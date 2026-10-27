// Runs in the page's own JS world: Docs only exposes its annotate API there, and only reads the flag there.
// It relays the API to the isolated-world bridge (src/content/gdocs/bridge.ts) over DOM CustomEvents, along with
// what Docs paints on its canvases (canvas-recorder.ts).
// Keep this bundle tiny: no chrome.* APIs exist here, and nothing beyond protocol.ts and canvas-recorder.ts may be
// imported.
import { startCanvasRecorder, type CanvasRecorder } from '../content/gdocs/canvas-recorder';
import {
  GDOCS_PAINT,
  GDOCS_READY,
  GDOCS_REQ,
  GDOCS_RES,
  emit,
  listen,
  type GdocsRequest,
  type GdocsResponse,
} from '../content/gdocs/protocol';

/** What `_docs_annotate_getAnnotatedText(id)` resolves to (recorded live). */
export interface AnnotateApi {
  getText(): string;
  getAnnotations(): unknown;
  getSelection(): Array<{ start: number; end: number }>;
  setSelection(start: number, end: number): void;
}

export interface GdocsWindow {
  _docs_annotate_canvas_by_ext?: string;
  _docs_annotate_getAnnotatedText?: (extensionId: string) => Promise<AnnotateApi>;
}

export interface GdocsMainOptions {
  extensionId: string;
  /** Build-time switch (WXT_GDOCS_FLAG): 'off' skips setting the flag, to exercise the fallback. */
  gdocsFlag?: string;
  /**
   * Starts the canvas recorder, handing it the paint callback. Left out when the build turns the recorder off
   * (WXT_GDOCS_CANVAS=off): the canvas methods stay unpatched and `runs` answers gdocs-no-runs.
   */
  startRecorder?: (onPaint: (generation: number) => void) => CanvasRecorder;
}

// A connect window lasts 30 s of wall clock (Date.now deltas, so throttled background timers can't stretch it).
// Inside it: poll every 100 ms for the first 5 s, then every 500 ms. Each connect attempt gets 3 s.
const WINDOW_MS = 30_000;
const FAST_PHASE_MS = 5000;
const FAST_POLL_MS = 100;
const SLOW_POLL_MS = 500;
const ATTEMPT_DEADLINE_MS = 3000;

export function startGdocsMain(win: GdocsWindow, events: EventTarget, opts: GdocsMainOptions): void {
  // First: the recorder has to be in place before Docs paints. Failing to start only costs the canvas runs.
  let recorder: CanvasRecorder | null = null;
  try {
    recorder = opts.startRecorder?.((generation) => emit(events, GDOCS_PAINT, { generation })) ?? null;
  } catch {
    recorder = null;
  }

  // Docs' gate accepts any non-empty value, and another extension (e.g. Grammarly) may already own the flag.
  if (opts.gdocsFlag !== 'off' && !win._docs_annotate_canvas_by_ext) {
    win._docs_annotate_canvas_by_ext = opts.extensionId;
  }

  let api: AnnotateApi | null = null;
  let available: boolean | null = null; // null while a connect window is open
  const waitingPings: string[] = [];
  const respond = (res: GdocsResponse) => emit(events, GDOCS_RES, res);

  // Listen before connecting, so a ping that arrives mid-window is queued rather than lost.
  listen(events, GDOCS_REQ, (req) => {
    if (typeof req.reqId !== 'string') return;
    const { reqId } = req;
    if (req.op === 'ping') {
      if (available === true) return respond({ reqId, ok: true, value: { available } });
      waitingPings.push(reqId);
      // After a final false, a ping opens one fresh window; pings during a window just wait for it.
      if (available === false) openWindow();
      return;
    }
    // Canvas runs don't depend on the annotate API.
    if (req.op === 'runs') {
      if (!recorder) return respond({ reqId, ok: false, error: 'gdocs-no-runs' });
      try {
        return respond({ reqId, ok: true, value: recorder.snapshot() });
      } catch {
        return respond({ reqId, ok: false, error: 'gdocs-runs-failed' });
      }
    }
    if (!api) return respond({ reqId, ok: false, error: 'gdocs-unavailable' });
    try {
      respond({ reqId, ok: true, value: serve(api, req) });
    } catch (err) {
      respond({ reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const finish = (found: AnnotateApi | null) => {
    api = found;
    available = found !== null;
    for (const reqId of waitingPings.splice(0)) respond({ reqId, ok: true, value: { available } });
    emit(events, GDOCS_READY, { available });
  };

  // One attempt: the API resolves within the deadline and getText() returns a string. Anything else → null.
  const tryConnect = async (): Promise<AnnotateApi | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ATTEMPT_DEADLINE_MS);
    });
    try {
      // Called on win to keep `this`. A synchronous throw lands in the catch below, like a rejection.
      const found = await Promise.race([win._docs_annotate_getAnnotatedText!(opts.extensionId), deadline]);
      return found && typeof found.getText() === 'string' ? found : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Retries failed attempts until one succeeds; only an elapsed window is final. The API is resolved once and cached.
  const openWindow = () => {
    available = null;
    const startedAt = Date.now();
    const attempt = async () => {
      const found = typeof win._docs_annotate_getAnnotatedText === 'function' ? await tryConnect() : null;
      const elapsed = Date.now() - startedAt;
      if (found || elapsed >= WINDOW_MS) return finish(found);
      setTimeout(attempt, elapsed < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    void attempt();
  };
  openWindow();
}

function serve(api: AnnotateApi, req: Partial<GdocsRequest>): unknown {
  switch (req.op) {
    case 'getText':
      return api.getText();
    case 'getSelection':
      // Copy each range's fields explicitly so they survive JSON.
      return Array.from(api.getSelection() ?? [], (range) => ({ start: range.start, end: range.end }));
    case 'setSelection': {
      const [start, end] = Array.isArray(req.args) ? req.args : [];
      if (typeof start !== 'number' || typeof end !== 'number') throw new Error('gdocs-bad-args');
      api.setSelection(start, end);
      return undefined;
    }
    default:
      throw new Error('gdocs-unknown-op');
  }
}

export default defineContentScript({
  matches: ['https://docs.google.com/document/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    startGdocsMain(window as unknown as GdocsWindow, document, {
      extensionId: import.meta.env.WXT_EXTENSION_ID,
      gdocsFlag: import.meta.env.WXT_GDOCS_FLAG,
      // Decided at build time, so an off build leaves the recorder out of this bundle altogether.
      startRecorder:
        import.meta.env.WXT_GDOCS_CANVAS === 'off'
          ? undefined
          : (onPaint) => startCanvasRecorder(CanvasRenderingContext2D.prototype, { onPaint }),
    });
  },
});
