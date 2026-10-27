// Records what Docs paints on its canvases: each fillText run and each selection-highlight fillRect, per canvas.
// It runs in the page's own JS world (gdocs-main.content.ts), and the isolated world reads it over the bridge
// ('runs') to place underlines from the text Docs actually drew.
// The prototype comes in as an argument, so tests pass a fake. No chrome.*, and no imports but protocol.ts (itself
// import-free): this ships in the MAIN-world bundle.
//
// The paint hooks sit on Docs' hot path. Each calls the original method first, with the same `this` and arguments,
// then, inside a try/catch, appends a few numbers and strings to flat arrays: no measuring, no DOM writes, no layout
// reads, no per-character work. The one exception is cheap and allocation-free: while a selection box is recorded,
// a fill or clear that overlaps it drops it in place. Replacing repainted lines, measuring, CSS conversion and
// tagging the canvas all wait for the recorder's own frame callback or for snapshot().
// Only the prototype methods are patched (never getContext), so another extension's context proxy that forwards
// to the real context, or its own prototype patch above or below this one, keeps working.
//
// Docs repaints a dirty region under a clip: a background fill that covers the whole canvas, then only the dirty
// lines. So a fill says nothing about which runs were erased. Instead, a run drawn in a later paint task replaces
// the earlier runs whose vertical band (from the font size around the baseline) overlaps its own.
import { SNAPSHOT_MAX_CANVASES, SNAPSHOT_MAX_RUNS, SNAPSHOT_MAX_TEXT } from './protocol';

/** One fillText call, in canvas-local CSS px (add the canvas's client rect for viewport px). */
export interface CanvasRun {
  /** The drawn text without Docs' bidi controls (U+202A–U+202E). */
  text: string;
  /** The context's font when the run was drawn, e.g. `14.6667px Arial`. */
  font: string;
  /** Left edge. */
  x: number;
  /** Baseline. */
  y: number;
  width: number;
}

/** A selection-highlight fill, in canvas-local CSS px. */
export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What one canvas shows: the latest runs of each line, and the selection boxes. `id` is its `data-englint-canvas`. */
export interface CanvasPaint {
  id: string;
  runs: CanvasRun[];
  selection: CanvasBox[];
}

export interface CanvasSnapshot {
  /** Goes up with every recorded change, so equal generations mean equal records. */
  generation: number;
  canvases: CanvasPaint[];
}

export interface CanvasRecorder {
  snapshot(): CanvasSnapshot;
  /** Unpatches the prototype (unless a later patch sits on top, in which case the hooks just pass through). */
  stop(): void;
}

export interface CanvasRecorderOptions {
  /** Called at most once per animation frame, after a frame in which the records changed. */
  onPaint(generation: number): void;
}

// Each run takes RUN_FIELDS slots, in paint order: the text, its font, the device x of its alignment point, its
// device baseline y, the horizontal and vertical scale, its alignment, its maxWidth, and the paint task it was drawn
// in (REPLACED once a later task's run has replaced it).
const AT_TEXT = 0;
const AT_FONT = 1;
const AT_X = 2;
const AT_Y = 3;
const AT_SCALE_X = 4;
const AT_SCALE_Y = 5;
const AT_ALIGN = 6;
const AT_MAX_WIDTH = 7;
const AT_TASK = 8;
const RUN_FIELDS = 9;
const REPLACED = -1;
/** Per selection box: device left, top, width, height. */
const BOX_FIELDS = 4;
/** Where a run's x sits on it, in halves of its width from the left edge. */
const ALIGN_LEFT = 0;
const ALIGN_CENTRE = 1;
const ALIGN_RIGHT = 2;
/** A run's line band reaches this many font sizes above and below its baseline. */
const BAND_ABOVE = 0.8;
const BAND_BELOW = 0.25;
/** For a font string with no px size in it (Chrome's getter always gives px). */
const DEFAULT_FONT_PX = 16;
const FONT_PX = /(\d*\.?\d+)px/;
/** A canvas that collects more than this without settling starts over, which bounds the memory it holds. */
const MAX_RUNS = 5000;
const MAX_BOXES = 1000;
/** A fill or clear over at least this share of the backing store erases every selection box on the canvas. */
const REPAINT_COVERAGE = 0.9;
const WIDTH_CACHE_SIZE = 2000;
const FONT_CACHE_SIZE = 256;
/** Once this many canvases are tracked, forgetting garbage-collected ones runs as each new canvas appears. */
const SWEEP_AT = 64;
const BIDI_CONTROLS = /[\u202A-\u202E]/g;
// rgb(78, 143, 248) at any alpha. Chrome's fillStyle getter spells it #4e8ff8 when opaque, rgba(78, 143, 248, a) if not.
const SELECTION_COLOUR = /^(?:#4e8ff8(?:[0-9a-f]{2})?|rgba?\(\s*78\s*,\s*143\s*,\s*248\s*(?:,\s*[\d.]+%?\s*)?\))$/i;

type Method = 'fillText' | 'fillRect' | 'clearRect';
type Hook = (ctx: CanvasRenderingContext2D, args: unknown[]) => void;

interface CanvasRecord {
  id: string;
  context: WeakRef<CanvasRenderingContext2D>;
  runs: Array<string | number>;
  /** Runs before this index have been settled against each other (see settle). */
  settled: number;
  boxes: number[];
  /** The backing store's size when last seen: a new size means the bitmap was cleared without a drawing call. */
  width: number;
  height: number;
}

/** A canvas ready to be read in snapshot(): its rect has been read, its tag not yet written. */
interface Placed {
  record: CanvasRecord;
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  sx: number;
  sy: number;
}

export function startCanvasRecorder(proto: CanvasRenderingContext2D, options: CanvasRecorderOptions): CanvasRecorder {
  const methods = proto as unknown as Record<Method, unknown>;
  const measureText: unknown = proto.measureText; // called on read, never patched
  // Both taken now, at document_start, before any page script can wrap them.
  const requestFrame: (callback: () => void) => unknown =
    typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback) => setTimeout(callback, 16);
  const afterThisTask: (callback: () => void) => void =
    typeof globalThis.queueMicrotask === 'function'
      ? globalThis.queueMicrotask.bind(globalThis)
      : (callback) => void Promise.resolve().then(callback);

  let records = new WeakMap<object, CanvasRecord>();
  let tracked: CanvasRecord[] = [];
  let lastId = 0;
  let generation = 0;
  let active = true;
  let frameRequested = false;
  // A paint routine draws synchronously, so every run drawn before the next microtask belongs to one paint task.
  let task = 0;
  let inTask = false;
  const widths = new Map<string, number>(); // font|text → measured width; insertion order is recency
  const fontSizes = new Map<string, number>();

  const endTask = () => {
    inTask = false;
  };

  const paintTask = () => {
    if (!inTask) {
      inTask = true;
      task++;
      afterThisTask(endTask);
    }
    return task;
  };

  const fontSize = (font: string) => {
    let size = fontSizes.get(font);
    if (size === undefined) {
      const match = FONT_PX.exec(font);
      size = match ? parseFloat(match[1]!) : DEFAULT_FONT_PX;
      if (fontSizes.size >= FONT_CACHE_SIZE) fontSizes.clear();
      fontSizes.set(font, size);
    }
    return size;
  };

  /**
   * Drops every run that a run from a later paint task overlaps vertically: Docs redrew that line. Runs from one
   * task never replace each other, since one line can be several runs (a bullet, a bold word, justified words).
   * Only the runs added since the last settle are checked, each against the runs before it.
   */
  const settle = (record: CanvasRecord) => {
    const runs = record.runs;
    const count = runs.length / RUN_FIELDS;
    if (record.settled >= count) return;
    const tops = new Float64Array(count);
    const bottoms = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const at = i * RUN_FIELDS;
      const size = fontSize(runs[at + AT_FONT] as string) * (runs[at + AT_SCALE_Y] as number);
      const y = runs[at + AT_Y] as number;
      tops[i] = y - BAND_ABOVE * size;
      bottoms[i] = y + BAND_BELOW * size;
    }
    for (let i = record.settled; i < count; i++) {
      const drawnIn = runs[i * RUN_FIELDS + AT_TASK] as number;
      for (let j = 0; j < i; j++) {
        const at = j * RUN_FIELDS + AT_TASK;
        const older = runs[at] as number;
        if (older >= 0 && older < drawnIn && tops[j]! < bottoms[i]! && tops[i]! < bottoms[j]!) runs[at] = REPLACED;
      }
    }
    let write = 0;
    for (let read = 0; read < runs.length; read += RUN_FIELDS) {
      if (runs[read + AT_TASK] === REPLACED) continue;
      if (write !== read) for (let k = 0; k < RUN_FIELDS; k++) runs[write + k] = runs[read + k]!;
      write += RUN_FIELDS;
    }
    runs.length = write;
    record.settled = write / RUN_FIELDS;
  };

  const notify = () => {
    frameRequested = false;
    if (!active) return;
    // Off Docs' paint path: settle what was drawn since the last frame, so repainted lines don't pile up.
    for (const record of tracked) {
      try {
        settle(record);
      } catch {
        // Settling again at snapshot() covers a failure here.
      }
    }
    try {
      options.onPaint(generation);
    } catch {
      // A failing listener must not break the page's frame.
    }
  };

  const changed = () => {
    generation++;
    if (!frameRequested) {
      frameRequested = true;
      requestFrame(notify);
    }
  };

  const clearRuns = (record: CanvasRecord) => {
    record.runs.length = 0;
    record.settled = 0;
  };

  /** A new backing size clears the bitmap without any drawing call, so whatever was recorded is gone. */
  const resetIfResized = (record: CanvasRecord, canvas: HTMLCanvasElement) => {
    if (record.width === canvas.width && record.height === canvas.height) return false;
    record.width = canvas.width;
    record.height = canvas.height;
    if (record.runs.length > 0 || record.boxes.length > 0) {
      clearRuns(record);
      record.boxes.length = 0;
      changed();
    }
    return true;
  };

  const forgetCollected = () => {
    tracked = tracked.filter((record) => record.context.deref() !== undefined);
  };

  const recordFor = (ctx: CanvasRenderingContext2D): CanvasRecord => {
    const canvas = ctx.canvas;
    let record = records.get(ctx);
    if (!record) {
      if (tracked.length >= SWEEP_AT) forgetCollected();
      record = {
        id: String(++lastId),
        context: new WeakRef(ctx),
        runs: [],
        settled: 0,
        boxes: [],
        width: canvas.width,
        height: canvas.height,
      };
      records.set(ctx, record);
      tracked.push(record);
    } else {
      resetIfResized(record, canvas);
    }
    return record;
  };

  const onText: Hook = (ctx, args) => {
    const text = args[0];
    const x = args[1];
    const y = args[2];
    if (typeof text !== 'string' || typeof x !== 'number' || typeof y !== 'number') return;
    let maxWidth = Infinity;
    if (args.length > 3 && args[3] !== undefined) {
      const given = args[3];
      if (typeof given !== 'number' || !(given > 0)) return; // a maxWidth of 0, below or NaN draws nothing
      maxWidth = given;
    }
    const m = ctx.getTransform();
    if (!(m.a > 0 && m.d > 0) || m.b !== 0 || m.c !== 0) return; // upright, unmirrored text only
    const deviceX = m.a * x + m.e;
    const deviceY = m.d * y + m.f;
    if (!Number.isFinite(deviceX) || !Number.isFinite(deviceY)) return;
    const record = recordFor(ctx);
    if (record.runs.length >= MAX_RUNS * RUN_FIELDS) clearRuns(record);
    record.runs.push(text, ctx.font, deviceX, deviceY, m.a, m.d, alignmentOf(ctx), maxWidth, paintTask());
    changed();
  };

  const onRect = (ctx: CanvasRenderingContext2D, args: unknown[], fill: boolean) => {
    const x = args[0];
    const y = args[1];
    const w = args[2];
    const h = args[3];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return;
    const selection = fill && isSelectionColour(ctx.fillStyle);
    const existing = records.get(ctx);
    // A fill or clear only ever erases selection boxes; runs are replaced line by line (see settle).
    if (!selection && (existing === undefined || existing.boxes.length === 0)) return;
    const m = ctx.getTransform();
    if (m.b !== 0 || m.c !== 0) return;
    const x0 = m.a * x + m.e;
    const x1 = m.a * (x + w) + m.e;
    const y0 = m.d * y + m.f;
    const y1 = m.d * (y + h) + m.f;
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    if (!Number.isFinite(right - left) || !Number.isFinite(bottom - top)) return;

    if (selection) {
      if (right <= left || bottom <= top) return;
      const record = recordFor(ctx);
      if (record.boxes.length >= MAX_BOXES * BOX_FIELDS) record.boxes.length = 0;
      record.boxes.push(left, top, right - left, bottom - top);
      changed();
      return;
    }

    if (!existing || resetIfResized(existing, ctx.canvas)) return;
    // Coverage is measured in backing px, clipped to the canvas: Docs' page-white fill is drawn in page units.
    const coveredWidth = Math.min(right, existing.width) - Math.max(left, 0);
    const coveredHeight = Math.min(bottom, existing.height) - Math.max(top, 0);
    const covering =
      coveredWidth > 0 &&
      coveredHeight > 0 &&
      coveredWidth * coveredHeight >= REPAINT_COVERAGE * existing.width * existing.height;
    const boxes = existing.boxes;
    let kept = 0;
    for (let i = 0; i < boxes.length; i += BOX_FIELDS) {
      const boxLeft = boxes[i]!;
      const boxTop = boxes[i + 1]!;
      const boxRight = boxLeft + boxes[i + 2]!;
      const boxBottom = boxTop + boxes[i + 3]!;
      if (covering || (boxLeft < right && left < boxRight && boxTop < bottom && top < boxBottom)) continue;
      if (kept !== i) for (let k = 0; k < BOX_FIELDS; k++) boxes[kept + k] = boxes[i + k]!;
      kept += BOX_FIELDS;
    }
    if (kept !== boxes.length) {
      boxes.length = kept;
      changed();
    }
  };

  const hooks: Array<{ name: Method; original: (...args: unknown[]) => unknown; hooked: unknown }> = [];
  const patch = (name: Method, hook: Hook) => {
    const original = methods[name];
    if (typeof original !== 'function') return;
    const hooked = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      const result: unknown = original.apply(this, args); // Docs' own errors still reach Docs
      if (active) {
        try {
          hook(this, args);
        } catch {
          // Recording must never break a paint.
        }
      }
      return result;
    };
    methods[name] = hooked;
    hooks.push({ name, original: original as (...args: unknown[]) => unknown, hooked });
  };
  patch('fillText', onText);
  patch('fillRect', (ctx, args) => onRect(ctx, args, true));
  patch('clearRect', (ctx, args) => onRect(ctx, args, false));

  /** Width in logical px of `text` in `font`, from the cache or measured on `ctx` once `setFont` has run. */
  const widthOf = (ctx: CanvasRenderingContext2D, font: string, text: string, setFont: () => void) => {
    const key = `${font}|${text}`;
    const cached = widths.get(key);
    if (cached !== undefined) {
      widths.delete(key); // move it to the most recently used end
      widths.set(key, cached);
      return cached;
    }
    setFont();
    const width = (measureText as (this: CanvasRenderingContext2D, text: string) => TextMetrics).call(ctx, text).width;
    if (!Number.isFinite(width)) return NaN;
    widths.set(key, width);
    if (widths.size > WIDTH_CACHE_SIZE) widths.delete(widths.keys().next().value!);
    return width;
  };

  const readRuns = (ctx: CanvasRenderingContext2D, runs: Array<string | number>, sx: number, sy: number) => {
    const out: CanvasRun[] = [];
    if (typeof measureText !== 'function') return out;
    // Measuring borrows the canvas's own context, set to each run's font, and gives its font back afterwards.
    const savedFont = ctx.font;
    let currentFont = savedFont;
    try {
      for (let at = 0; at < runs.length; at += RUN_FIELDS) {
        const text = (runs[at + AT_TEXT] as string).replace(BIDI_CONTROLS, '');
        if (!text) continue;
        const font = runs[at + AT_FONT] as string;
        const measured = widthOf(ctx, font, text, () => {
          if (currentFont !== font) ctx.font = currentFont = font;
        });
        if (Number.isNaN(measured)) continue;
        const width = Math.min(measured, runs[at + AT_MAX_WIDTH] as number) * (runs[at + AT_SCALE_X] as number);
        const left = (runs[at + AT_X] as number) - ((runs[at + AT_ALIGN] as number) * width) / 2;
        out.push({ text, font, x: left * sx, y: (runs[at + AT_Y] as number) * sy, width: width * sx });
      }
    } finally {
      if (currentFont !== savedFont) ctx.font = savedFont;
    }
    return out;
  };

  /** Reads a canvas's rect (a layout read), or null if it can't be shown: detached, resized since, or no size. */
  const place = (record: CanvasRecord): Placed | null => {
    const ctx = record.context.deref();
    if (!ctx) return null;
    const canvas = ctx.canvas;
    if (canvas.isConnected === false) return null; // the isolated world can't find a detached canvas
    if (resetIfResized(record, canvas)) return null;
    const rect = canvas.getBoundingClientRect();
    if (!(record.width > 0 && record.height > 0 && rect.width > 0 && rect.height > 0)) return null;
    return { record, ctx, canvas, sx: rect.width / record.width, sy: rect.height / record.height };
  };

  /** A settled canvas's run count and run characters: at most what the bridge will count (bidi controls count here). */
  const sizeOf = (record: CanvasRecord) => {
    let text = 0;
    for (let at = AT_TEXT; at < record.runs.length; at += RUN_FIELDS) text += (record.runs[at] as string).length;
    return { runs: record.runs.length / RUN_FIELDS, text };
  };

  /** Tags the canvas (a DOM write) and converts its settled records to CSS px. */
  const paintOf = ({ record, ctx, canvas, sx, sy }: Placed): CanvasPaint => {
    if (canvas.dataset.englintCanvas !== record.id) canvas.dataset.englintCanvas = record.id;
    const runs = readRuns(ctx, record.runs, sx, sy);
    const selection: CanvasBox[] = [];
    const boxes = record.boxes;
    for (let i = 0; i < boxes.length; i += BOX_FIELDS) {
      selection.push({ x: boxes[i]! * sx, y: boxes[i + 1]! * sy, width: boxes[i + 2]! * sx, height: boxes[i + 3]! * sy });
    }
    return { id: record.id, runs, selection };
  };

  return {
    snapshot() {
      const canvases: CanvasPaint[] = [];
      if (!active) return { generation, canvases };
      forgetCollected();
      // Every rect is read before any tag is written: a write between two layout reads would force a style recalc.
      const placed: Placed[] = [];
      for (const record of tracked) {
        if (placed.length >= SNAPSHOT_MAX_CANVASES) break;
        if (record.runs.length === 0 && record.boxes.length === 0) continue;
        try {
          const ready = place(record);
          if (ready) placed.push(ready);
        } catch {
          // A canvas that can't be read is left out; its lines fall back to the SVG rects.
        }
      }
      // Within the bridge's budget: once the next canvas would pass it, that canvas and the rest are left out before
      // any of their runs is measured (their lines fall back to the SVG rects), instead of building a reply the
      // isolated world would refuse whole.
      let runs = 0;
      let text = 0;
      for (const ready of placed) {
        if (canvases.length >= SNAPSHOT_MAX_CANVASES) break;
        try {
          settle(ready.record);
          const size = sizeOf(ready.record);
          if (runs + size.runs > SNAPSHOT_MAX_RUNS || text + size.text > SNAPSHOT_MAX_TEXT) break;
          canvases.push(paintOf(ready));
          runs += size.runs;
          text += size.text;
        } catch {
          // As above.
        }
      }
      return { generation, canvases };
    },

    stop() {
      if (!active) return;
      active = false;
      for (const { name, original, hooked } of hooks) {
        if (methods[name] === hooked) methods[name] = original;
      }
      records = new WeakMap();
      tracked = [];
      widths.clear();
      fontSizes.clear();
    },
  };
}

function alignmentOf(ctx: CanvasRenderingContext2D): number {
  const align = ctx.textAlign;
  if (align === 'center') return ALIGN_CENTRE;
  if (align === 'left') return ALIGN_LEFT;
  if (align === 'right') return ALIGN_RIGHT;
  // 'start' (the default) and 'end' depend on the direction.
  return (align === 'end') !== (ctx.direction === 'rtl') ? ALIGN_RIGHT : ALIGN_LEFT;
}

function isSelectionColour(style: unknown): boolean {
  return typeof style === 'string' && SELECTION_COLOUR.test(style);
}
