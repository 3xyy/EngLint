// Google Docs adapter: text and selection come through the MAIN-world bridge (Docs' annotate API),
// geometry from the annotated SVG rects refined by the text runs Docs painted on its canvases, and fixes are
// pasted into Docs' text-event iframe, which keeps Docs' own undo (verified live). Every
// value from the bridge is untrusted: offsets are clamped to the text before they go back to Docs.
import type { GdocsBridge } from '../gdocs/bridge';
import type { CanvasPaint, CanvasSnapshot } from '../gdocs/canvas-recorder';
import { placeLines } from '../gdocs/canvas-runs';
import { readRectRuns, rectsOnRuns, type Box } from '../gdocs/geometry';
import { CANVAS_ID } from '../gdocs/protocol';
import { plainSpaces } from './text-map';
import type { EditorAdapter, MeasureOptions } from './types';

const EDITOR = '.kix-appview-editor'; // the scroll container
const TILES = '.kix-rotatingtilemanager-content'; // holds the rect SVGs
const HIT_REGION = '.kix-rotatingtilemanager'; // the tiles' parent: where pointer events over the text land
const TEXT_EVENT_IFRAME = 'iframe.docs-texteventtarget-iframe';
const EDITABLE = '[contenteditable="true"]';

/**
 * Docs' structure characters, '\n' each, one for one: document start, soft line break (Shift+Enter),
 * page break, table start, table end (may be followed directly by text), row, cell.
 */
const CONTROL_CHARS = /[\u0003\u000b\u000c\u0010\u0011\u0012\u001c]/g;
const APPLY_POLL_MS = 100;
const APPLY_TIMEOUT_MS = 600;
/** After a selection: time for Docs to scroll it into view and repaint before rects are read. */
const SELECT_SETTLE_MS = 100;
/** A frame may never come (background tab): wait at most this long for one. */
const FRAME_CAP_MS = 100;
/** The page world answers a runs read straight away (no Docs API call); past this, a measure goes on without it. */
const RUNS_TIMEOUT_MS = 250;
const TILE_CHANGES: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['aria-label'],
};

export interface GdocsAdapterDeps {
  /** The Docs page (default: document). */
  doc?: Document;
  /** The editable inside the text-event iframe (injectable: happy-dom can't load iframes). */
  editable?: () => HTMLElement | null;
  /** Viewport box of an element (default: getBoundingClientRect). */
  boxOf?: (el: Element) => Box;
  /** Width of `text` in a canvas font (default: canvas measureText). */
  measure?: (text: string, font: string) => number;
}

/** getText() with Docs' control characters as '\n' and NBSP as a space: offsets stay 1:1 with Docs' own. */
export function docsText(raw: string): string {
  return plainSpaces(raw.replace(CONTROL_CHARS, '\n'));
}

function clamp(n: number, length: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), length) : 0;
}

/** Docs drops a pasted fix's edge spaces; NBSP survives (the comparison treats it as a space). */
function nbspEdges(text: string): string {
  return text.replace(/^ +| +$/g, (spaces) => '\u00a0'.repeat(spaces.length));
}

/** A character that can be pasted back as itself: not '\n' (Docs' control characters read as '\n'), no other control character, not half of a surrogate pair. */
function pasteable(c: string | undefined): c is string {
  return c !== undefined && !/[\u0000-\u001f\u007f\ud800-\udfff]/.test(c);
}

/**
 * A deletion pasted as '' may not apply in Docs (unverified live), so it is widened by one neighbouring
 * character, which is pasted back: the following one, or the preceding one at the end of a paragraph or
 * of the text. Without a usable neighbour the deletion stays an empty paste.
 */
export function widenDeletion(
  text: string,
  range: { start: number; end: number },
): { range: { start: number; end: number }; insert: string } {
  const after = text[range.end];
  if (pasteable(after)) return { range: { start: range.start, end: range.end + 1 }, insert: after };
  const before = range.start > 0 ? text[range.start - 1] : undefined;
  if (pasteable(before)) return { range: { start: range.start - 1, end: range.end }, insert: before };
  return { range, insert: '' };
}

function pasteEvent(text: string): ClipboardEvent {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  return new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
}

function canvasMeasure(doc: Document): (text: string, font: string) => number {
  let ctx: CanvasRenderingContext2D | null | undefined;
  let lastFont = '';
  return (text, font) => {
    ctx ??= doc.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    if (font !== lastFont) {
      ctx.font = font;
      lastFont = font;
    }
    return ctx.measureText(text).width;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `promise`, or a gdocs-timeout rejection after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gdocs-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Runs `cb` on the next frame, or after FRAME_CAP_MS if no frame comes. */
function nextFrame(cb: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  setTimeout(run, FRAME_CAP_MS);
}

export function createGdocsAdapter(
  bridge: GdocsBridge,
  fieldId = 'gdocs',
  deps: GdocsAdapterDeps = {},
): EditorAdapter {
  const doc = deps.doc ?? document;
  const boxOf = deps.boxOf ?? ((el: Element) => el.getBoundingClientRect());
  const measure = deps.measure ?? canvasMeasure(doc);
  const editable =
    deps.editable ??
    (() => {
      const frame = doc.querySelector<HTMLIFrameElement>(TEXT_EVENT_IFRAME);
      return frame?.contentDocument?.querySelector<HTMLElement>(EDITABLE) ?? null;
    });
  const editor = () => doc.querySelector(EDITOR);

  let disposed = false;
  const cleanups = new Set<() => void>();

  function listen(target: EventTarget, type: string, cb: () => void, opts?: AddEventListenerOptions): () => void {
    target.addEventListener(type, cb, opts);
    const off = () => {
      target.removeEventListener(type, cb, opts);
      cleanups.delete(off);
    };
    cleanups.add(off);
    return off;
  }

  // One observer on the tiles for both onChange and onLayoutChange: a repaint is both.
  const tileListeners = new Set<() => void>();
  let observer: MutationObserver | null = null;
  function onTiles(cb: () => void): () => void {
    tileListeners.add(cb);
    if (!observer) {
      const root = doc.querySelector(TILES) ?? editor();
      if (root) {
        observer = new MutationObserver(() => [...tileListeners].forEach((l) => l()));
        observer.observe(root, TILE_CHANGES);
      }
    }
    const off = () => {
      tileListeners.delete(cb);
      cleanups.delete(off);
    };
    cleanups.add(off);
    return off;
  }

  // Calls made while a read is on its way share it: one bridge round trip. A read that came back (or failed) is not
  // kept, so a later call always reads the text as it is then.
  let textRead: Promise<string> | null = null;
  const getText = (): Promise<string> =>
    (textRead ??= bridge
      .getText()
      .then(docsText)
      .finally(() => (textRead = null)));

  // ---- canvas runs: read on the first measure after a paint announces a new generation, kept until then ----
  let snapshot: CanvasSnapshot | null = null;
  /**
   * The snapshot, or the read that failed, is as new as the last paint announced. A failed read (gdocs-no-runs
   * without a recorder, a timeout, a reply over budget) is not tried again until a paint brings a new generation.
   */
  let runsCurrent = false;
  let lastPaint: number | null = null;
  let paintCount = 0;
  let reading: Promise<CanvasPaint[]> | null = null;
  // Called inside the page's animation frame: only note the generation; the runs are read on the next measure.
  const offPaint = bridge.onPaint((generation) => {
    paintCount++;
    lastPaint = generation;
    if (generation !== snapshot?.generation) runsCurrent = false;
  });
  cleanups.add(offPaint);

  async function readRuns(): Promise<CanvasPaint[]> {
    const seen = paintCount;
    try {
      snapshot = await withTimeout(bridge.getRuns(), RUNS_TIMEOUT_MS);
    } catch {
      snapshot = null; // this measure, and those until the next paint, use the SVG rects alone
    }
    // A paint that came during the read may be newer than the snapshot: then the next measure reads again.
    runsCurrent = paintCount === seen || lastPaint === snapshot?.generation;
    return snapshot?.canvases ?? [];
  }

  /** What Docs painted, to place lines from; [] means the SVG rects alone. Measures that overlap share one read. */
  function canvasPaints(): Promise<CanvasPaint[]> {
    if (runsCurrent) return Promise.resolve(snapshot?.canvases ?? []);
    reading ??= readRuns().finally(() => (reading = null));
    return reading;
  }

  /** A recorded canvas's viewport box, or null unless exactly one canvas carries its id: any page script can set it. */
  function canvasRect(id: string): Box | null {
    if (!CANVAS_ID.test(id)) return null;
    const found = doc.querySelectorAll(`canvas[data-englint-canvas="${id}"]`);
    return found.length === 1 ? boxOf(found[0]!) : null;
  }

  /**
   * The rects of each range, from one text read, the canvas runs (cached per paint generation) and one rect read.
   * Lines are placed from the canvas runs where they match, from the SVG rects otherwise (placeLines). Clipped to
   * the scroll container unless the underline layer is anchored in it (or above it): then the scroller clips the
   * layer itself, and painted lines scrolled out of view keep their rects.
   */
  async function measureRanges(ranges: { start: number; end: number }[], opts?: MeasureOptions): Promise<DOMRect[][]> {
    if (disposed || ranges.length === 0) return ranges.map(() => []);
    try {
      const [text, paints] = await Promise.all([getText(), canvasPaints()]);
      // No await from here on: the line rects, the canvases' current boxes and the clip are read together.
      const scroller = editor();
      const { runs, spans } = placeLines(paints, canvasRect, readRectRuns(scroller ?? doc, boxOf), text);
      const until = opts?.clipUntil;
      const clip = scroller && !(until && until.contains(scroller)) ? boxOf(scroller) : null;
      const clipped = (r: DOMRect): DOMRect | null => {
        if (!clip || clip.width <= 0 || clip.height <= 0) return r; // no layout to clip against
        const left = Math.max(r.left, clip.x);
        const top = Math.max(r.top, clip.y);
        const right = Math.min(r.right, clip.x + clip.width);
        const bottom = Math.min(r.bottom, clip.y + clip.height);
        if (right <= left || bottom <= top) return null;
        const inside = left === r.left && top === r.top && right === r.right && bottom === r.bottom;
        return inside ? r : new DOMRect(left, top, right - left, bottom - top);
      };
      return ranges.map(({ start, end }) =>
        rectsOnRuns(runs, spans, start, end, measure)
          .map(clipped)
          .filter((r): r is DOMRect => r !== null),
      );
    } catch {
      return ranges.map(() => []);
    }
  }

  /** Selects [start, end), clamped to the current text, in Docs. */
  async function selectClamped(start: number, end: number): Promise<void> {
    const length = (await getText()).length;
    await bridge.setSelection(clamp(start, length), clamp(end, length));
  }

  const element = editor() ?? doc.documentElement;

  return {
    fieldId,
    element,

    getText,

    // onChange reads the text after every input, keyup and tile repaint, and fires on any difference.
    reportsEveryChange: true,

    async rectsFor(start, end, opts) {
      return (await measureRanges([{ start, end }], opts))[0]!;
    },

    rectsForMany: measureRanges,

    async replace(start, end, text) {
      try {
        if (disposed || end < start) return false;
        const target = editable();
        if (!target) return false;
        const before = await getText();
        let range = { start: clamp(start, before.length), end: clamp(end, before.length) };
        let insert = text;
        if (insert === '') ({ range, insert } = widenDeletion(before, range));
        await bridge.setSelection(range.start, range.end);
        target.focus({ preventScroll: true });
        target.dispatchEvent(pasteEvent(nbspEdges(insert)));

        const want = plainSpaces(insert);
        // The length matters: a fix that is a prefix of the original ("the the" → "the") matches unchanged text.
        const length = before.length - (range.end - range.start) + want.length;
        const deadline = Date.now() + APPLY_TIMEOUT_MS;
        for (;;) {
          await sleep(APPLY_POLL_MS);
          try {
            const now = await getText();
            if (now.length === length && now.slice(range.start, range.start + want.length) === want) return true;
          } catch {
            // a slow read: try again until the deadline
          }
          if (disposed || Date.now() >= deadline) return false;
        }
      } catch {
        return false;
      }
    },

    async select(start, end) {
      try {
        if (disposed) return;
        await selectClamped(start, end);
        editable()?.focus({ preventScroll: true });
        await sleep(SELECT_SETTLE_MS);
      } catch {
        // selection is best effort
      }
    },

    scrollRoot: editor,

    paintRoot: () => editor()?.querySelector(TILES) ?? null,

    hitRegion: () => editor()?.querySelector(HIT_REGION) ?? null,

    async caret() {
      try {
        if (disposed) return null;
        const [selection, text] = await Promise.all([bridge.getSelection(), getText()]);
        return selection.start === selection.end ? clamp(selection.end, text.length) : null;
      } catch {
        return null;
      }
    },

    async selection() {
      try {
        if (disposed) return null;
        // A backward selection (shift+left, a right-to-left drag) comes as anchor then focus: order it.
        const { start: a, end: b } = await bridge.getSelection();
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        return start < end ? { start, end } : null;
      } catch {
        return null;
      }
    },

    async selectionRects() {
      try {
        if (disposed) return null;
        const paints = await canvasPaints();
        if (disposed) return null;
        const scroller = editor();
        const clip = scroller ? boxOf(scroller) : null;
        const rects: DOMRect[] = [];
        for (const paint of paints) {
          const canvas = canvasRect(paint.id);
          if (!canvas) continue;
          for (const b of paint.selection) {
            if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || !(b.width > 0 && b.height > 0)) continue;
            const rect = new DOMRect(canvas.x + b.x, canvas.y + b.y, b.width, b.height);
            // Painted but scrolled out of the editor's view: not where the selection can be seen.
            if (clip && clip.width > 0 && clip.height > 0) {
              const outside =
                rect.right <= clip.x || rect.left >= clip.x + clip.width || rect.bottom <= clip.y || rect.top >= clip.y + clip.height;
              if (outside) continue;
            }
            rects.push(rect);
          }
        }
        // Reading order: boxes whose vertical centres are within half a line of the line's first box are one line.
        const centre = (r: DOMRect) => r.y + r.height / 2;
        rects.sort((a, b) => centre(a) - centre(b));
        const lines: DOMRect[][] = [];
        for (const r of rects) {
          const line = lines.at(-1);
          const first = line?.[0];
          if (line && first && Math.abs(centre(r) - centre(first)) <= first.height / 2) line.push(r);
          else lines.push([r]);
        }
        rects.length = 0;
        for (const line of lines) rects.push(...line.sort((a, b) => a.x - b.x));
        return rects.length > 0 ? rects : null;
      } catch {
        return null;
      }
    },

    // Repaints (scrolling, zoom) fire the same events as edits: only a changed text is a change.
    onChange(cb) {
      if (disposed) return () => {};
      let queued = false;
      let active = true;
      let last: string | null = null;
      getText().then(
        (text) => (last ??= text),
        () => {},
      );
      const fire = () => {
        if (queued || !active) return;
        queued = true;
        nextFrame(async () => {
          queued = false;
          if (!active) return;
          let text: string | null = null;
          try {
            text = await getText();
          } catch {
            // can't tell: count it as a change
          }
          if (!active || (text !== null && text === last)) return;
          if (text !== null) last = text;
          cb();
        });
      };
      const events = editable()?.ownerDocument;
      const offs = [
        ...(events ? [listen(events, 'input', fire, { capture: true }), listen(events, 'keyup', fire, { capture: true })] : []),
        onTiles(fire),
      ];
      const off = () => {
        active = false;
        offs.forEach((o) => o());
        cleanups.delete(off);
      };
      cleanups.add(off);
      return off;
    },

    onLayoutChange(cb) {
      if (disposed) return () => {};
      const scroller = editor();
      const offs = [
        ...(scroller ? [listen(scroller, 'scroll', () => cb(scroller))] : []),
        listen(window, 'resize', () => cb()),
        onTiles(() => cb(undefined, true)), // Docs redrew its lines: an edit, a scroll that painted others, a reflow
      ];
      const off = () => {
        offs.forEach((o) => o());
        cleanups.delete(off);
      };
      cleanups.add(off);
      return off;
    },

    isAlive() {
      return !disposed && element.isConnected;
    },

    dispose() {
      disposed = true;
      [...cleanups].forEach((off) => off());
      cleanups.clear();
      tileListeners.clear();
      observer?.disconnect();
      observer = null;
    },
  };
}
