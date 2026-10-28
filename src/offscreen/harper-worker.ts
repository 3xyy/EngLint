import type { HarperLintMessage, HarperLintReply } from '../shared/messages';

// Harper runs in a worker of the offscreen document, not on the document itself: an extension's pages share one
// main thread, so building Harper's dictionary there (hundreds of milliseconds) froze an open side panel, popup or
// options page with it. harper.js's own WorkerLinter starts its worker from a blob: URL, which the extension's
// CSP (script-src 'self') refuses; this worker is a file of the extension.

/** The page to the worker: where the WebAssembly is (first), then each check with an id. */
export type ToWorker = { type: 'init'; wasmUrl: string } | { type: 'lint'; id: number; msg: HarperLintMessage };
/** The worker to the page: a check's reply, under its id. */
export interface FromWorker {
  id: number;
  reply: HarperLintReply;
}

/** The part of a Worker the page uses. */
export interface WorkerLike {
  postMessage(data: ToWorker): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (e: any) => void): void;
  terminate(): void;
}

const FAILED: HarperLintReply = { ok: false };

/**
 * The offscreen page's side: starts a worker from `makeWorker` at once and tells it where the WebAssembly is, then
 * sends each check under an id and answers with the reply for that id. A worker error (its script failed to load, or
 * threw) answers every check waiting with { ok: false } at once and ends that worker; the next check starts a new one.
 * A reply that can't be read answers the checks waiting { ok: false } and keeps the worker. A worker that can't be
 * made, or a post that throws, answers the check { ok: false }. The background treats { ok: false } as "no local
 * issues", and waits a while before it asks again.
 */
export function createWorkerLint(makeWorker: () => WorkerLike, wasmUrl: string): (msg: HarperLintMessage) => Promise<HarperLintReply> {
  const waiting = new Map<number, (reply: HarperLintReply) => void>();
  let nextId = 0; // never reset: a late reply from an ended worker finds no check
  let worker: WorkerLike | null = null;
  const failAll = () => {
    const all = [...waiting.values()];
    waiting.clear();
    for (const resolve of all) resolve(FAILED);
  };
  const start = (): WorkerLike => {
    const w = makeWorker();
    w.addEventListener('message', (e: { data?: Partial<FromWorker> }) => {
      if (worker !== w) return; // an ended worker's late reply
      const id = e.data?.id;
      const resolve = typeof id === 'number' ? waiting.get(id) : undefined;
      if (!resolve) return;
      waiting.delete(id!);
      resolve(e.data!.reply ?? FAILED);
    });
    w.addEventListener('error', () => {
      if (worker !== w) return;
      worker = null;
      w.terminate();
      failAll();
    });
    w.addEventListener('messageerror', () => {
      if (worker === w) failAll();
    });
    w.postMessage({ type: 'init', wasmUrl });
    return w;
  };
  try {
    worker = start(); // the dictionary starts loading with the document, before the first check
  } catch {
    worker = null; // the first check tries again
  }

  return (msg) =>
    new Promise<HarperLintReply>((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      try {
        worker ??= start();
        worker.postMessage({ type: 'lint', id, msg });
      } catch {
        waiting.delete(id);
        resolve(FAILED);
      }
    });
}

/**
 * The worker's side: builds the Harper host from the WebAssembly address once it comes, then lints each check
 * and posts its reply under the check's id. A check before the address, or one the host fails, is answered
 * { ok: false }. Returns a promise per message, settled once its reply is posted.
 */
export function createWorkerHandler(
  makeHost: (wasmUrl: string) => { lint(msg: HarperLintMessage): Promise<HarperLintReply> },
  post: (data: FromWorker) => void,
): (data: unknown) => Promise<void> {
  let host: { lint(msg: HarperLintMessage): Promise<HarperLintReply> } | null = null;
  return async (data) => {
    const m = data as Partial<ToWorker> | null;
    if (typeof m !== 'object' || m === null) return;
    if (m.type === 'init' && typeof m.wasmUrl === 'string') {
      host ??= makeHost(m.wasmUrl);
      return;
    }
    if (m.type !== 'lint' || typeof m.id !== 'number') return;
    const reply = host ? await host.lint(m.msg as HarperLintMessage).catch(() => FAILED) : FAILED;
    post({ id: m.id, reply });
  };
}
