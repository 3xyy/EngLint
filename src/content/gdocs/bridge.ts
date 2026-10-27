// Isolated-world side of the Docs bridge: requests go to the MAIN-world script (gdocs-main.content.ts)
// over DOM CustomEvents, and responses are matched by reqId.
// Threat model: these events are visible to every page-world script on docs.google.com, which can read a reqId
// off the req event and answer (or send ready) first. Low risk (such a script can call the annotate API itself),
// but every value from here is untrusted: types are checked below, and callers clamp offsets.
import type { CanvasBox, CanvasPaint, CanvasRun, CanvasSnapshot } from './canvas-recorder';
import {
  CANVAS_ID,
  GDOCS_PAINT,
  GDOCS_READY,
  GDOCS_REQ,
  GDOCS_RES,
  SNAPSHOT_MAX_CANVASES,
  SNAPSHOT_MAX_RUNS,
  SNAPSHOT_MAX_TEXT,
  emit,
  listen,
  type GdocsOp,
} from './protocol';

export interface GdocsSelection {
  start: number;
  end: number;
}

export interface GdocsBridge {
  /**
   * true at once if a ready event or ping answer has ever said available (even one that came after an
   * earlier whenReady gave up). Otherwise it pings, which also makes a MAIN script that gave up try again,
   * and resolves with the answer or the next ready event; false if neither comes within timeoutMs.
   */
  whenReady(timeoutMs?: number): Promise<boolean>;
  getText(): Promise<string>;
  /** The first selected range; `{ start: 0, end: 0 }` when there is none. */
  getSelection(): Promise<GdocsSelection>;
  setSelection(start: number, end: number): Promise<void>;
  /**
   * What Docs has painted on its canvases (canvas-recorder.ts), checked: a canvas entry with a bad shape or a
   * non-finite number is dropped, and numbers are clamped. Rejects `gdocs-no-runs` when the page has no recorder
   * (WXT_GDOCS_CANVAS=off), `gdocs-bad-response` when the reply isn't a snapshot at all, and `gdocs-too-large`
   * when its canvases hold over 20,000 runs or 2,000,000 characters in all.
   */
  getRuns(): Promise<CanvasSnapshot>;
  /** Calls `callback` with each new paint generation (at most one per frame); returns the unsubscribe function. */
  onPaint(callback: (generation: number) => void): () => void;
  /**
   * Stops listening. Pending requests reject `gdocs-disposed`, a waiting whenReady resolves false, and
   * later calls do the same at once without sending anything.
   */
  dispose(): void;
}

const REQUEST_TIMEOUT_MS = 1000;
const READY_TIMEOUT_MS = 5000;

// What a runs reply may carry. A canvas entry over a limit is dropped; the canvas list is cut at
// SNAPSHOT_MAX_CANVASES. Past the total budget (protocol.ts, which the page world keeps to as well) the whole reply
// is rejected, which bounds the work done on it.
const MAX_RUNS = 5000;
const MAX_BOXES = 1000;
const MAX_TEXT = 10_000;
const MAX_FONT = 200;
const COORD_LIMIT = 1e6;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createGdocsBridge(target: EventTarget = document): GdocsBridge {
  const idPrefix = Math.random().toString(36).slice(2, 10);
  let idCounter = 0;
  const nextId = () => `${idPrefix}-${++idCounter}`;
  const pending = new Map<string, Pending>();
  let disposed = false;

  const settle = (reqId: string): Pending | undefined => {
    const entry = pending.get(reqId);
    if (!entry) return undefined;
    pending.delete(reqId);
    clearTimeout(entry.timer);
    return entry;
  };

  // Recorded for the bridge's lifetime: a ready that arrives after whenReady returned false still counts.
  let available = false;
  const readyWaiters = new Set<(available: boolean) => void>();
  const offReady = listen(target, GDOCS_READY, (ready) => {
    if (ready.available === true) available = true;
    for (const waiter of [...readyWaiters]) waiter(ready.available === true);
  });

  const paintListeners = new Set<() => void>();

  const offRes = listen(target, GDOCS_RES, (res) => {
    const entry = typeof res.reqId === 'string' ? settle(res.reqId) : undefined;
    if (!entry) return;
    if (res.ok === true) entry.resolve(res.value);
    else entry.reject(new Error(typeof res.error === 'string' ? res.error : 'gdocs-error'));
  });

  function request(op: GdocsOp, args?: [number, number], timeoutMs = REQUEST_TIMEOUT_MS, reqId = nextId()) {
    return new Promise<unknown>((resolve, reject) => {
      if (disposed) return reject(new Error('gdocs-disposed'));
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error('gdocs-timeout'));
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      emit(target, GDOCS_REQ, args ? { reqId, op, args } : { reqId, op });
    });
  }

  return {
    whenReady(timeoutMs = READY_TIMEOUT_MS) {
      if (disposed) return Promise.resolve(false);
      if (available) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        // The ready event may have fired before we listened, so also ask with a ping.
        // The ping waits as long as whenReady does: the MAIN script answers it only when its connect window ends.
        const pingId = nextId();
        let done = false;
        const finish = (result: boolean) => {
          if (done) return;
          done = true;
          readyWaiters.delete(finish);
          if (result) available = true;
          settle(pingId)?.resolve(undefined); // a ready event won: settle the ping instead of leaving it dangling
          resolve(result);
        };
        readyWaiters.add(finish);
        request('ping', undefined, timeoutMs, pingId).then(
          (value) => finish(isObject(value) && value.available === true),
          () => finish(false),
        );
      });
    },

    async getText() {
      const value = await request('getText');
      if (typeof value !== 'string') throw new Error('gdocs-bad-response');
      return value;
    },

    async getSelection() {
      const value = await request('getSelection');
      const first: unknown = Array.isArray(value) ? value[0] : undefined;
      return isObject(first) && typeof first.start === 'number' && typeof first.end === 'number'
        ? { start: first.start, end: first.end }
        : { start: 0, end: 0 };
    },

    async setSelection(start, end) {
      await request('setSelection', [start, end]);
    },

    async getRuns() {
      return readSnapshot(await request('runs'));
    },

    onPaint(callback) {
      if (disposed) return () => {};
      const off = listen(target, GDOCS_PAINT, (paint) => {
        if (isFiniteNumber(paint.generation)) callback(paint.generation);
      });
      paintListeners.add(off);
      return () => {
        if (paintListeners.delete(off)) off();
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      offReady();
      offRes();
      for (const off of paintListeners) off();
      paintListeners.clear();
      for (const reqId of [...pending.keys()]) settle(reqId)?.reject(new Error('gdocs-disposed'));
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const clamp = (value: number, min = -COORD_LIMIT) => Math.min(COORD_LIMIT, Math.max(min, value));

function readSnapshot(value: unknown): CanvasSnapshot {
  if (!isObject(value) || !isFiniteNumber(value.generation) || !Array.isArray(value.canvases)) {
    throw new Error('gdocs-bad-response');
  }
  const canvases: CanvasPaint[] = [];
  let totalRuns = 0;
  let totalText = 0;
  for (const entry of value.canvases.slice(0, SNAPSHOT_MAX_CANVASES)) {
    const paint = readCanvas(entry);
    if (!paint) continue;
    totalRuns += paint.runs.length;
    for (const run of paint.runs) totalText += run.text.length;
    if (totalRuns > SNAPSHOT_MAX_RUNS || totalText > SNAPSHOT_MAX_TEXT) throw new Error('gdocs-too-large');
    canvases.push(paint);
  }
  return { generation: value.generation, canvases };
}

/** One canvas entry, or null if anything in it is off: its lines then fall back to the SVG rects. */
function readCanvas(entry: unknown): CanvasPaint | null {
  if (!isObject(entry) || typeof entry.id !== 'string' || !CANVAS_ID.test(entry.id)) return null;
  const { runs, selection } = entry;
  if (!Array.isArray(runs) || runs.length > MAX_RUNS) return null;
  if (!Array.isArray(selection) || selection.length > MAX_BOXES) return null;
  const outRuns: CanvasRun[] = [];
  for (const run of runs) {
    if (!isObject(run)) return null;
    const { text, font, x, y, width } = run;
    if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
    if (typeof font !== 'string' || font.length > MAX_FONT) return null;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width)) return null;
    outRuns.push({ text, font, x: clamp(x), y: clamp(y), width: clamp(width, 0) });
  }
  const boxes: CanvasBox[] = [];
  for (const box of selection) {
    if (!isObject(box)) return null;
    const { x, y, width, height } = box;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    boxes.push({ x: clamp(x), y: clamp(y), width: clamp(width, 0), height: clamp(height, 0) });
  }
  return { id: entry.id, runs: outRuns, selection: boxes };
}
