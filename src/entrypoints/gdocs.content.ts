// Google Docs, isolated world: waits for the MAIN-world bridge (gdocs-main.content.ts) and a paint that
// matches the text, then checks the document as one field. When Docs support isn't there, it says so
// (a notice and the D badge) and asks again on the user's next interaction, at most once a minute.
import { createGdocsAdapter, docsText } from '../content/adapters/gdocs';
import { CARET_KEYS, createFieldHost, loadPageSettings, type Field, type FieldHost } from '../content/field-host';
import { createGdocsBridge, type GdocsBridge } from '../content/gdocs/bridge';
import { readRectRuns, runsConsistent, type RectRun } from '../content/gdocs/geometry';
import { announcePage } from '../content/page-announce';
import { readFieldSelection, readPageSelection } from '../content/tools/selection';
import { splitParagraphs } from '../core/paragraphs';
import { onMessage, sendMessage } from '../shared/messages';

export const FALLBACK_NOTICE = "Google Docs live checking isn't available right now.";
/** Longer than MAIN's 30 s connect window, so its final answer always arrives. */
export const READY_TIMEOUT_MS = 35_000;
export const REASK_INTERVAL_MS = 60_000;
/** After Docs replaced its editor element: the most often a new field is attached. */
export const REATTACH_INTERVAL_MS = 5000;
/** After ready: how long painted rects may take to match the text (Docs may still be repainting). */
const PAINT_WAIT_MS = 5000;
const PAINT_POLL_MS = 250;
/**
 * After ready, while no line rect is painted at all: how long a slow cold load may take to paint its first
 * lines (live, the API answered seconds before the first rects). Polled every second after the first 5 s.
 */
const FIRST_PAINT_WAIT_MS = 30_000;
const FIRST_PAINT_POLL_MS = 1000;
const FIELD_ID = 'gdocs';
const EDITOR = '.kix-appview-editor';
const TEXT_EVENT_IFRAME = 'iframe.docs-texteventtarget-iframe';
/** A document's editor URL (/document/d/<id>/…, /document/u/<n>/d/<id>/…); not the docs list (/document/u/0/). */
const EDITOR_PATH = /^\/document\/(u\/\d+\/)?d\//;

/** True on the Docs editor: an editor URL whose page has the editor's scroll container. */
export function isDocsEditor(pathname: string, doc: ParentNode): boolean {
  return EDITOR_PATH.test(pathname) && doc.querySelector(EDITOR) !== null;
}

/** Resolves true once this is the Docs editor (Docs builds it after load); false at once off an editor URL, or at the timeout. */
export function whenDocsEditor(pathname: string, doc: Document, timeoutMs: number): Promise<boolean> {
  if (!EDITOR_PATH.test(pathname)) return Promise.resolve(false);
  if (isDocsEditor(pathname, doc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (found: boolean) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(found);
    };
    const observer = new MutationObserver(() => {
      if (isDocsEditor(pathname, doc)) finish(true);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export interface DocsGateDeps {
  bridge: Pick<GdocsBridge, 'whenReady' | 'getText'>;
  /** The rect runs painted now. */
  readRuns(): RectRun[];
  /** Calls `cb` on each user interaction with the document; returns the unsubscribe function. */
  onInteraction(cb: () => void): () => void;
  /** Docs support is usable: start checking. Called at most once. */
  onReady(): void;
  /** Docs support isn't usable. Called at most once. */
  onFallback(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Decides whether Docs support is usable: the bridge is ready and the painted rects match the text.
 * After a fallback it re-asks only on interaction, and at most once per REASK_INTERVAL_MS (the first
 * interaction may re-ask at once). Never loops on its own. Returns a function that stops it.
 */
export function gateDocs(deps: DocsGateDeps): () => void {
  let stopped = false;
  let ready = false;
  let asking = false;
  let lastAsk = -Infinity;
  let offInteraction: (() => void) | null = null;

  /**
   * Docs may still be painting, and typing between the two reads can mismatch: retry until the deadline.
   * Until painted rects are first seen (no rects yet, or text reads that keep failing), a slow cold load gets
   * up to FIRST_PAINT_WAIT_MS; from the first time rects are seen, they get PAINT_WAIT_MS to match the text.
   */
  async function paintMatches(): Promise<boolean> {
    const start = Date.now();
    let deadline = start + FIRST_PAINT_WAIT_MS;
    let painted = false;
    for (;;) {
      try {
        const text = docsText(await deps.bridge.getText());
        const runs = deps.readRuns();
        if (runs.length > 0 ? runsConsistent(text, runs) : splitParagraphs(text).length === 0) return true;
        if (!painted && runs.length > 0) {
          painted = true;
          deadline = Date.now() + PAINT_WAIT_MS;
        }
      } catch {
        // a slow read: try again
      }
      if (stopped || Date.now() >= deadline) return false;
      await sleep(Date.now() - start < PAINT_WAIT_MS ? PAINT_POLL_MS : FIRST_PAINT_POLL_MS);
    }
  }

  async function usable(): Promise<boolean> {
    return (await deps.bridge.whenReady(READY_TIMEOUT_MS)) && !stopped && (await paintMatches());
  }

  function becomeReady() {
    ready = true;
    offInteraction?.();
    offInteraction = null;
    deps.onReady();
  }

  async function reask() {
    if (stopped || ready || asking || Date.now() - lastAsk < REASK_INTERVAL_MS) return;
    asking = true;
    lastAsk = Date.now();
    try {
      if ((await usable()) && !stopped && !ready) becomeReady();
    } finally {
      asking = false;
    }
  }

  void usable().then((ok) => {
    if (stopped) return;
    if (ok) return becomeReady();
    deps.onFallback();
    offInteraction = deps.onInteraction(() => void reask());
  });

  return () => {
    stopped = true;
    offInteraction?.();
    offInteraction = null;
  };
}

export interface ReattachDeps {
  /** Resolves true once the editor is on the page again. */
  whenEditor(): Promise<boolean>;
  /** Still wanted: Docs support was ready, the site is on, and no Docs field is attached. */
  wanted(): boolean;
  attach(): void;
}

/**
 * Returns a request function that re-attaches the Docs field after it detached (Docs replaced its editor
 * element): once the editor is back, at most once per REATTACH_INTERVAL_MS. Requests while one is pending coalesce.
 */
export function createReattacher(deps: ReattachDeps): () => void {
  let pending = false;
  let last = -Infinity;
  return () => {
    if (pending) return;
    pending = true;
    void (async () => {
      try {
        const wait = last + REATTACH_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        if (deps.wanted() && (await deps.whenEditor()) && deps.wanted()) deps.attach();
      } catch {
        // the next detach asks again
      } finally {
        pending = false;
      }
    })();
  };
}

/** Keys that type or edit; with Esc, they close the card ("on Esc, or when you type"). */
const EDIT_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab']);

/**
 * Whether a keydown in Docs' text-event iframe closes the card: Esc, a typed character (Option/Alt may
 * type one) or an editing key. Not caret keys (their keyup opens the card at the caret), not shortcuts.
 */
export function closesCard(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (e.key === 'Escape') return true;
  if (e.ctrlKey || e.metaKey) return false;
  return e.key.length === 1 || EDIT_KEYS.has(e.key);
}

/**
 * A keydown in Docs' text-event iframe, which the overlay's own key listeners never see. Esc and typing close
 * the card and hide the selection button; Esc alone also closes the undo chip and keeps the button away until
 * the selection changes. Typing leaves the chip, as it does in other fields.
 */
export function onDocsKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  fields: Pick<FieldHost, 'closeCard' | 'closeUndo' | 'hideSelection'>,
): void {
  if (!closesCard(e)) return;
  const esc = e.key === 'Escape';
  fields.closeCard();
  if (esc) fields.closeUndo();
  fields.hideSelection(esc);
}

function on(target: EventTarget, type: string, cb: (e: Event) => void, opts?: AddEventListenerOptions): () => void {
  target.addEventListener(type, cb, opts);
  return () => target.removeEventListener(type, cb, opts);
}

export default defineContentScript({
  matches: ['https://docs.google.com/document/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // The tab's page is this document (this script runs in the top frame only, and the generic script stays off
    // Docs): the background forgets the old page's state at once, before the editor is up and before anything is
    // reported.
    await announcePage(ctx);
    // Other Docs pages (the docs list) match too: no checking there, and no fallback either.
    if (!(await whenDocsEditor(location.pathname, document, READY_TIMEOUT_MS))) return;
    const host = location.hostname;
    const settings = await loadPageSettings(ctx, host);
    const textEventFrame = () => document.querySelector<HTMLIFrameElement>(TEXT_EVENT_IFRAME);
    const fields = createFieldHost(ctx, {
      host,
      settings,
      badgeInset: 12, // the editor's own bottom-right corner, clear of its scrollbar's end
      // Docs keeps focus in its offscreen text-event iframe while the user edits.
      isFocused: (el) => {
        const active = document.activeElement;
        return !!active && (active === textEventFrame() || el.contains(active));
      },
      // Docs may replace its editor element: the field dies with it (isAlive), and a new one is attached.
      onDetach: (f) => {
        if (f !== field) return;
        field = null;
        offKeys?.();
        offKeys = null;
        if (checking) reattach();
      },
    });
    const bridge = createGdocsBridge(document);
    ctx.onInvalidated(() => bridge.dispose());

    // The shortcut (Docs draws its own right-click menu): the popover on the doc's selection. In fallback
    // mode no field is attached, so it answers opened: false, and the background opens the side panel.
    const offTools = [
      onMessage('openTools', async ({ data }) => {
        const f = fields.focusedField();
        const range = f ? await readFieldSelection(f.adapter) : null;
        return { opened: !!f && !!range && (await fields.openTools(f, range, data.request)) };
      }),
      // Docs draws its text: the doc's own selection (the bridge) when the field is up, else the page's.
      onMessage('pageSelection', async () => {
        const f = fields.focusedField();
        const range = f ? await readFieldSelection(f.adapter).catch(() => null) : null;
        return { text: range?.text ?? readPageSelection(document) };
      }),
    ];
    ctx.onInvalidated(() => offTools.forEach((off) => off()));

    let fallback = false;
    const setNotice = (text: string | null) =>
      void fields
        .overlay()
        .then((o) => o.showNotice(text))
        .catch(() => {});
    const sendFallback = (status: 'docs_fallback' | 'ok', removed: boolean) =>
      sendMessage('issuesUpdated', {
        fieldId: FIELD_ID,
        host,
        mode: settings.mode(),
        status,
        focused: false,
        issues: [],
        ...(removed ? { removed } : {}),
      }).catch(() => {});

    let field: Field | null = null;
    let offKeys: (() => void) | null = null;
    let checking = false; // Docs support was ready and the site is on
    const reattach = createReattacher({
      whenEditor: () => whenDocsEditor(location.pathname, document, READY_TIMEOUT_MS),
      wanted: () => checking && field === null,
      attach: () => startChecking(),
    });

    function startChecking() {
      if (fallback) setNotice(null);
      fallback = false;
      checking = true;
      const el = document.querySelector(EDITOR) ?? document.documentElement;
      const f = (field = fields.attach(el, (fieldId) => createGdocsAdapter(bridge, fieldId), FIELD_ID));
      fields.report(f, true);
      // Keys reach Docs through its text-event iframe, not this document (the overlay's own Esc and
      // typing listeners never see them): a caret key opens the card at the caret; Esc or typing closes it.
      const keys = textEventFrame()?.contentDocument;
      if (keys) {
        const offs = [
          // Focus entering or leaving the iframe: this document's focus events don't always see it (the shortcut).
          ...(keys.defaultView ? ['focus', 'blur'].map((type) => on(keys.defaultView!, type, () => fields.focusChanged())) : []),
          on(keys, 'keyup', (e) => {
            if (CARET_KEYS.has((e as KeyboardEvent).key)) void fields.openAtCaret(f);
            fields.selectionChanged(); // shift-arrows select without a pointer
          }, { capture: true }),
          on(keys, 'keydown', (e) => onDocsKey(e as KeyboardEvent, fields), { capture: true }),
        ];
        offKeys = () => offs.forEach((off) => off());
      }
    }

    function showFallback() {
      fallback = true;
      setNotice(FALLBACK_NOTICE);
      sendFallback('docs_fallback', false);
    }

    function onInteraction(cb: () => void): () => void {
      const keys = textEventFrame()?.contentDocument;
      const offs = [
        ...(keys ? [on(keys, 'keydown', cb, { capture: true })] : []),
        on(document, 'click', cb, { capture: true }), // clicks land on the page; keys go to the iframe
      ];
      return () => offs.forEach((off) => off());
    }

    // ---- site switch ----
    let stopGate: (() => void) | null = null;
    const start = () => {
      stopGate ??= gateDocs({
        bridge,
        readRuns: () => readRectRuns(document.querySelector(EDITOR) ?? document),
        onInteraction,
        onReady: startChecking,
        onFallback: showFallback,
      });
    };
    const stop = () => {
      checking = false;
      stopGate?.();
      stopGate = null;
      offKeys?.();
      offKeys = null;
      if (field) fields.detach(field);
      field = null;
      if (fallback) {
        fallback = false;
        setNotice(null);
        sendFallback('ok', true);
      }
    };

    // The toolbar badge says "off" while this site is switched off.
    const reportOff = (off: boolean) => void sendMessage('siteOff', { off }).catch(() => {});
    let siteOn = settings.watchEnabled((nowOn) => {
      if (nowOn !== siteOn) reportOff(!nowOn); // not on every change to the list
      siteOn = nowOn;
      if (nowOn) start();
      else stop();
    });
    ctx.onInvalidated(stop);
    if (siteOn) start();
    else reportOff(true);
  },
});
