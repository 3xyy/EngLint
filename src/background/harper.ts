import { isExtensionPage, isPageDisabled, webHost } from '../core/sites';
import {
  HARPER_OFFSCREEN,
  type HarperCheckRequest,
  type HarperCheckResponse,
  type HarperLintMessage,
  type HarperLintReply,
} from '../shared/messages';
import { dialectItem, dictionaryItem, disabledSitesItem, localChecksItem } from '../shared/settings';

/** A check the offscreen document hasn't answered by then gets no issues; the late answer is dropped. */
export const HARPER_TIMEOUT_MS = 4000;
/** After the document or its checker fails to start, checks get no issues for this long before one tries again. */
export const HARPER_RETRY_MS = 60_000;
/**
 * After this many checks in a row that a started document didn't answer in time, the document is closed (a lint or
 * setup that never settles blocks its queue) and the check after the backoff starts a new one.
 */
export const HARPER_TIMEOUTS_BEFORE_CLOSE = 2;

const OFFSCREEN_URL = 'offscreen.html';
const JUSTIFICATION = "Runs EngLint's local grammar checker so it starts once instead of after every service-worker restart.";

/** The part of chrome.offscreen used here. */
export interface OffscreenApi {
  hasDocument(): Promise<boolean>;
  createDocument(p: { url: string; reasons: 'WORKERS'[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
}

/**
 * Makes sure the offscreen document exists. It outlives a stopped service worker, so a new worker finds it with
 * hasDocument, and Chrome's "Only a single offscreen document" refusal also means it's there.
 */
export function createEnsureOffscreen(offscreen: OffscreenApi | undefined): () => Promise<void> {
  return async () => {
    if (!offscreen) throw new Error('No offscreen API');
    if (await offscreen.hasDocument().catch(() => false)) return;
    try {
      await offscreen.createDocument({ url: OFFSCREEN_URL, reasons: ['WORKERS'], justification: JUSTIFICATION });
    } catch (err) {
      if (!/single offscreen document/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  };
}

/** Closes the offscreen document, with its WebAssembly and dictionary, when there is one. */
export function createCloseOffscreen(offscreen: OffscreenApi | undefined): () => Promise<void> {
  return async () => {
    if (!offscreen || !(await offscreen.hasDocument().catch(() => false))) return;
    await offscreen.closeDocument();
  };
}

export interface HarperRouterDeps {
  ensureOffscreen(): Promise<void>;
  closeOffscreen(): Promise<void>;
  /** A raw runtime message; resolves with the document's answer (undefined when no listener answered). */
  sendToOffscreen(message: HarperLintMessage): Promise<unknown>;
  /** The stored dismissal keys for these paragraph hashes (the check service's own lookup). */
  dismissedFor(hashes: string[]): Promise<string[]>;
  now(): number;
  timeoutMs?: number;
  /** runtime.getURL('/'): extension pages may ask too. */
  extensionOrigin: string;
}

export interface HarperSender {
  tab?: { id?: number; url?: string };
  url?: string;
}

const EMPTY = (): HarperCheckResponse => ({ status: 'ok', results: {}, dismissed: [] });
const TIMED_OUT = Symbol('timed out');

const isReply = (r: unknown): r is HarperLintReply =>
  typeof r === 'object' && r !== null && typeof (r as { ok?: unknown }).ok === 'boolean';

const isParagraph = (p: unknown): boolean => {
  const { hash, text } = (p ?? {}) as { hash?: unknown; text?: unknown };
  return typeof hash === 'string' && typeof text === 'string';
};
/** A request whose paragraphs are all hash and text strings; anything else is never sent. */
const isWellFormed = (req: unknown): req is HarperCheckRequest => {
  const paragraphs = (req as { paragraphs?: unknown } | null)?.paragraphs;
  return Array.isArray(paragraphs) && paragraphs.every(isParagraph);
};

/**
 * The `harperCheck` message, forwarded to the offscreen document. Harper is best-effort: a failure, a refusal or a
 * slow answer gives no issues and never an error status. Nothing here touches Claude's status, spend or badge.
 */
export function createHarperRouter(deps: HarperRouterDeps) {
  const timeoutMs = deps.timeoutMs ?? HARPER_TIMEOUT_MS;
  let starting: { promise: Promise<void>; settled: boolean } | null = null;
  let retryAt = -Infinity;
  let timeouts = 0; // checks in a row that a started document didn't answer in time

  const backOff = () => {
    retryAt = deps.now() + HARPER_RETRY_MS;
  };

  /** Closes the document; the next check starts a new one. Never rejects. */
  function close(): Promise<void> {
    starting = null;
    return deps.closeOffscreen().catch(() => {});
  }

  /**
   * Concurrent checks share one start; a failed one is forgotten so the check after the backoff starts again.
   * A start dropped at the deadline that settles later changes nothing.
   */
  function start(): Promise<void> {
    if (!starting) {
      const attempt: { promise: Promise<void>; settled: boolean } = { promise: Promise.resolve(), settled: false };
      attempt.promise = deps.ensureOffscreen().then(
        () => {
          attempt.settled = true;
        },
        (err: unknown) => {
          attempt.settled = true;
          if (starting === attempt) {
            starting = null;
            backOff();
          }
          throw err;
        },
      );
      starting = attempt;
    }
    return starting.promise;
  }

  async function ask(message: HarperLintMessage, dismissed: Promise<string[]>): Promise<HarperCheckResponse> {
    await start();
    let reply: unknown;
    try {
      reply = await deps.sendToOffscreen(message);
    } catch {
      reply = undefined;
    }
    if (!isReply(reply)) {
      starting = null; // the document went away, or never listened: make sure of it on the next check
      return EMPTY();
    }
    if (!reply.ok) {
      backOff();
      return EMPTY();
    }
    return { status: 'ok', results: reply.results, dismissed: await dismissed };
  }

  async function route(req: HarperCheckRequest, sender: HarperSender): Promise<HarperCheckResponse> {
    const fromContent = sender.tab?.id !== undefined;
    if (!fromContent && !isExtensionPage(sender.url, deps.extensionOrigin)) return EMPTY();
    if (!isWellFormed(req)) return EMPTY();
    if (isPageDisabled(await disabledSitesItem.getValue(), req.host, webHost(sender.tab?.url))) {
      return { status: 'off_site', results: {}, dismissed: [] };
    }
    if (req.paragraphs.length === 0 || deps.now() < retryAt) return EMPTY();

    const [dialect, words, localChecks] = await Promise.all([
      dialectItem.getValue(),
      dictionaryItem.getValue(),
      localChecksItem.getValue(),
    ]);
    if (!localChecks) return EMPTY(); // "Instant local checks" off: the document is never started
    const message: HarperLintMessage = { target: HARPER_OFFSCREEN, mode: req.mode, dialect, words, paragraphs: req.paragraphs };
    const dismissed = deps.dismissedFor(req.paragraphs.map((p) => p.hash)).catch((): string[] => []);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const answer = await Promise.race([ask(message, dismissed), deadline]);
      if (answer !== TIMED_OUT) {
        timeouts = 0;
        return answer;
      }
      if (starting && !starting.settled) {
        // A start still pending now may never settle: it counts as a failed start, so checks in the backoff get
        // no issues at once instead of each waiting out the deadline, and the check after it starts again.
        starting = null;
        backOff();
      } else if (++timeouts >= HARPER_TIMEOUTS_BEFORE_CLOSE) {
        // The document started but its checker stopped answering, and every later request would queue behind it.
        timeouts = 0;
        void close();
        backOff();
      }
      return EMPTY();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Never rejects: a failed storage read, a malformed request or any other throw gives no issues. */
  async function check(req: HarperCheckRequest, sender: HarperSender): Promise<HarperCheckResponse> {
    try {
      return await route(req, sender);
    } catch {
      return EMPTY();
    }
  }

  return { check, close };
}

/** Turning "Instant local checks" off closes the offscreen document, so its memory goes until a check needs it. */
export function closeWhenLocalChecksOff(router: { close(): Promise<void> }): () => void {
  return localChecksItem.watch((on) => {
    if (on === false) void router.close();
  });
}
