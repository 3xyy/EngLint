import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCanvasRecorder, type CanvasRecorder } from '../../src/content/gdocs/canvas-recorder';
import { SNAPSHOT_MAX_CANVASES, SNAPSHOT_MAX_RUNS, SNAPSHOT_MAX_TEXT } from '../../src/content/gdocs/protocol';
import {
  BACKING_H,
  BACKING_W,
  CSS_W,
  FONT,
  RATIO,
  SELECTION_BLUE,
  TILE,
  asProto,
  fakeContext,
  fakeProto,
  fontPx,
  type FakeContext,
  type FakeProto,
} from './canvas-fakes';

const HELLO = '\u202DHello\u202C'; // Docs wraps each run in LEFT-TO-RIGHT OVERRIDE … POP DIRECTIONAL FORMATTING
/** The logical rect Docs fills page-white to repaint a whole tile: it maps onto all 1469 × 1901 backing px. */
const PAGE = [5, 5, (BACKING_W + 9) / 1.8 - 5, (BACKING_H + 9) / 1.8 - 5] as const;
/** fake measureText: half the font's px per character. */
const measured = (text: string, font = FONT) => (text.length * fontPx(font)) / 2;

let frames: FrameRequestCallback[] = [];
const recorders: CanvasRecorder[] = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.stop();
  vi.unstubAllGlobals();
});

function start(proto: FakeProto, onPaint: (generation: number) => void = () => {}) {
  const recorder = startCanvasRecorder(asProto(proto), { onPaint });
  recorders.push(recorder);
  return recorder;
}

function flushFrame() {
  for (const callback of frames.splice(0)) callback(0);
}

/** Lets the current task end: a paint routine runs synchronously, so its runs share one paint task. */
const endOfTask = () => Promise.resolve();

describe('canvas recorder: text runs', () => {
  it('records a run in canvas-local CSS px with the bidi controls stripped, and calls the original once', () => {
    const proto = fakeProto();
    const originalFillText = proto.fillText;
    const recorder = start(proto);
    const ctx = fakeContext(proto);

    ctx.fillText(HELLO, 101, 184.7);

    expect(originalFillText).toHaveBeenCalledTimes(1);
    expect(originalFillText.mock.calls[0]).toEqual([HELLO, 101, 184.7]);
    expect(originalFillText.mock.contexts[0]).toBe(ctx);
    const { canvases } = recorder.snapshot();
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.runs).toHaveLength(1);
    const run = canvases[0]!.runs[0]!;
    expect(run.text).toBe('Hello');
    expect(run.font).toBe(FONT);
    expect(run.x).toBeCloseTo((1.8 * 101 - 9) * RATIO, 2);
    expect(run.y).toBeCloseTo((1.8 * 184.7 - 9) * RATIO, 2);
  });

  it("measures the width in the run's own font, scaled by the transform and the CSS/backing ratio", () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    ctx.font = '26.6667px Arial';
    ctx.fillText(HELLO, 101, 184.7);
    ctx.font = FONT; // Docs has moved on to another font by the time the runs are read

    const run = recorder.snapshot().canvases[0]!.runs[0]!;
    expect(run.width).toBeCloseTo(measured('Hello', '26.6667px Arial') * 1.8 * RATIO, 2);
    expect(ctx.font).toBe(FONT);
  });

  it('places centred, right-aligned and right-to-left runs by their left edge', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const width = measured('Hello') * 1.8; // backing px
    const left = (x: number) => x * RATIO;
    const xFor = (align: string, direction = 'ltr') => {
      const ctx = fakeContext(proto);
      ctx.textAlign = align;
      ctx.direction = direction;
      ctx.fillText('Hello', 101, 184.7);
      const paint = recorder.snapshot().canvases.find((c) => c.id === ctx.canvas.dataset.englintCanvas);
      return paint!.runs[0]!.x;
    };
    const origin = 1.8 * 101 - 9;

    expect(xFor('center')).toBeCloseTo(left(origin - width / 2), 2);
    expect(xFor('right')).toBeCloseTo(left(origin - width), 2);
    expect(xFor('end')).toBeCloseTo(left(origin - width), 2);
    expect(xFor('start', 'rtl')).toBeCloseTo(left(origin - width), 2);
    expect(xFor('end', 'rtl')).toBeCloseTo(left(origin), 2);
    expect(xFor('left', 'rtl')).toBeCloseTo(left(origin), 2);
  });

  it('caps the width at maxWidth, and records nothing when maxWidth stops the text being drawn', () => {
    const proto = fakeProto();
    const originalFillText = proto.fillText;
    const recorder = start(proto);
    const ctx = fakeContext(proto);

    ctx.fillText('Hello', 101, 184.7, 20);
    ctx.fillText('Gone', 101, 200, 0);

    const runs = recorder.snapshot().canvases[0]!.runs;
    expect(runs.map((r) => r.text)).toEqual(['Hello']);
    expect(runs[0]!.width).toBeCloseTo(20 * 1.8 * RATIO, 2);
    expect(originalFillText.mock.calls).toEqual([
      ['Hello', 101, 184.7, 20],
      ['Gone', 101, 200, 0],
    ]);
  });

  it('does not record rotated or mirrored text', () => {
    const proto = fakeProto();
    const originalFillText = proto.fillText;
    const recorder = start(proto);
    const rotated = fakeContext(proto, { transform: { ...TILE, b: 0.5, c: -0.5 } });
    const mirrored = fakeContext(proto, { transform: { ...TILE, a: -1.8 } });

    rotated.fillText(HELLO, 101, 184.7);
    mirrored.fillText(HELLO, 101, 184.7);

    expect(recorder.snapshot().canvases).toEqual([]);
    expect(originalFillText).toHaveBeenCalledTimes(2);
  });
});

describe('canvas recorder: selection highlight', () => {
  it('records a fillRect in the selection blue as a selection box', () => {
    const proto = fakeProto();
    const originalFillRect = proto.fillRect;
    const recorder = start(proto);
    const ctx = fakeContext(proto);

    ctx.fillStyle = SELECTION_BLUE;
    ctx.fillRect(279, 171, 35, 19);

    const { canvases } = recorder.snapshot();
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.runs).toEqual([]);
    expect(canvases[0]!.selection).toHaveLength(1);
    const box = canvases[0]!.selection[0]!;
    expect(box.x).toBeCloseTo((1.8 * 279 - 9) * RATIO, 2);
    expect(box.y).toBeCloseTo((1.8 * 171 - 9) * RATIO, 2);
    expect(box.width).toBeCloseTo(35 * 1.8 * RATIO, 2);
    expect(box.height).toBeCloseTo(19 * 1.8 * RATIO, 2);
    expect(originalFillRect).toHaveBeenCalledTimes(1);
  });

  it('matches the blue at any alpha, and nothing else', () => {
    const proto = fakeProto();
    const originalFillRect = proto.fillRect;
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    let row = 0;
    const fillWith = (style: unknown) => {
      ctx.fillStyle = style;
      ctx.fillRect(279, 171 + 40 * row++, 35, 19); // each on its own row, so no fill overlaps another's box
    };

    fillWith('#4e8ff8'); // how the getter spells it when opaque
    fillWith('rgba(78, 143, 248, 0.25)');
    fillWith('#ffffff');
    fillWith('rgba(78, 143, 249, 0.5)');
    fillWith({ addColorStop() {} }); // a gradient

    expect(recorder.snapshot().canvases[0]!.selection).toHaveLength(2);
    expect(originalFillRect).toHaveBeenCalledTimes(5);
  });

  it('a covering fill drops the boxes, unless the highlight is painted again after it', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    const boxes = () => recorder.snapshot().canvases[0]?.selection.length ?? 0;
    const highlight = () => {
      ctx.fillStyle = SELECTION_BLUE;
      ctx.fillRect(279, 171, 35, 19);
    };
    const background = () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(...PAGE);
    };

    highlight();
    background(); // the selection collapsed: Docs repaints without the highlight
    expect(boxes()).toBe(0);

    highlight();
    background();
    highlight(); // the selection moved: Docs repaints, then paints the new highlight
    expect(boxes()).toBe(1);
  });

  it('a fill overlapping a box drops just that box; a fill away from the boxes drops nothing', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    ctx.fillStyle = SELECTION_BLUE;
    ctx.fillRect(279, 171, 35, 19);
    ctx.fillRect(100, 300, 50, 19);
    // Each box's logical left edge (the tile transform moves it by e / a = 5 px).
    const lefts = () => recorder.snapshot().canvases[0]?.selection.map((b) => Math.round(b.x / RATIO / 1.8)) ?? [];
    expect(lefts()).toEqual([274, 95]);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(500, 500, 10, 10);
    expect(lefts()).toEqual([274, 95]);

    ctx.fillRect(290, 175, 10, 5);
    expect(lefts()).toEqual([95]);

    ctx.clearRect(140, 310, 30, 30);
    expect(lefts()).toEqual([]);
  });
});

describe('canvas recorder: repaints', () => {
  function paintedPair() {
    const proto = fakeProto();
    const recorder = start(proto);
    const [a, b] = [fakeContext(proto), fakeContext(proto)];
    for (const ctx of [a, b]) {
      ctx.fillText(HELLO, 101, 184.7);
      ctx.fillStyle = SELECTION_BLUE;
      ctx.fillRect(279, 171, 35, 19);
      ctx.fillStyle = '#ffffff';
    }
    const counts = () =>
      recorder.snapshot().canvases.map((c) => ({ id: c.id, runs: c.runs.length, boxes: c.selection.length }));
    const before = counts();
    return { proto, recorder, a, b, counts, before };
  }

  it('a fill covering the canvas drops its selection boxes but keeps its runs, and leaves other canvases alone', () => {
    const { a, counts, before } = paintedPair();

    a.fillRect(...PAGE);

    expect(counts()).toEqual([
      { id: before[0]!.id, runs: 1, boxes: 0 },
      { id: before[1]!.id, runs: 1, boxes: 1 },
    ]);
  });

  it('a clearRect covering the canvas drops its selection boxes too', () => {
    const { b, counts, before } = paintedPair();

    b.clearRect(...PAGE);

    expect(counts()).toEqual([
      { id: before[0]!.id, runs: 1, boxes: 1 },
      { id: before[1]!.id, runs: 1, boxes: 0 },
    ]);
  });

  it('a small fill away from the boxes, or a large one that mostly misses the canvas, drops nothing', () => {
    const { a, b, counts, before } = paintedPair();

    a.fillRect(600, 900, 20, 20);
    // Taller than the whole page, but it starts halfway down, so it covers only the bottom half of the backing.
    b.fillRect(PAGE[0], PAGE[1] + PAGE[3] / 2, PAGE[2], PAGE[3] * 4);

    expect(before).toEqual([
      { id: before[0]!.id, runs: 1, boxes: 1 },
      { id: before[1]!.id, runs: 1, boxes: 1 },
    ]);
    expect(counts()).toEqual(before);
  });

  it('a fill over 90% of the canvas drops even a box it misses, and one under 90% does not', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    ctx.fillStyle = SELECTION_BLUE;
    ctx.fillRect(279, 1012, 35, 19); // in the bottom 5% strip of the backing (device y 1812–1847 of 1901)
    const boxes = () => recorder.snapshot().canvases[0]?.selection.length ?? 0;
    /** A page-wide fill from the top down to `share` of the backing height, in page units. */
    const fillTo = (share: number) => ctx.fillRect(PAGE[0], PAGE[1], PAGE[2], (share * BACKING_H + 9) / 1.8 - 5);
    ctx.fillStyle = '#ffffff';

    fillTo(0.85);
    expect(boxes()).toBe(1);

    fillTo(0.95);
    expect(boxes()).toBe(0);
  });

  it('a new backing size resets the canvas', () => {
    const { a, b, counts, before } = paintedPair();

    a.canvas.width = 1000; // resizing clears the bitmap without any drawing call
    expect(counts()).toEqual([before[1]]);

    b.canvas.height = 2000;
    b.fillText(HELLO, 101, 300);
    expect(counts()).toEqual([{ id: before[1]!.id, runs: 1, boxes: 0 }]);
    expect(b.canvas.dataset.englintCanvas).toBe(before[1]!.id);
  });

  it('starts the canvas over when it holds too many runs', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    for (let i = 0; i < 5000; i++) ctx.fillText('x', 0, 20);
    expect(recorder.snapshot().canvases[0]!.runs).toHaveLength(5000);

    ctx.fillText('last', 0, 20);

    expect(recorder.snapshot().canvases[0]!.runs.map((r) => r.text)).toEqual(['last']);
  });
});

describe('canvas recorder: the snapshot stays within what the bridge accepts', () => {
  const totals = (canvases: { runs: { text: string }[] }[]) => ({
    runs: canvases.reduce((n, c) => n + c.runs.length, 0),
    text: canvases.reduce((n, c) => n + c.runs.reduce((m, r) => m + r.text.length, 0), 0),
  });
  const measuredTexts = (proto: FakeProto) => new Set(proto.measureText.mock.calls.map(([text]) => text));

  it('stops adding canvases before they would pass 20,000 runs, and never measures the ones left out', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const contexts = Array.from({ length: 5 }, () => fakeContext(proto));
    contexts.forEach((ctx, i) => {
      for (let run = 0; run < 4500; run++) ctx.fillText(`canvas${i}`, 101, 184.7);
    });

    const { canvases } = recorder.snapshot();

    expect(canvases.map((c) => c.id)).toEqual(contexts.slice(0, 4).map((ctx) => ctx.canvas.dataset.englintCanvas));
    expect(totals(canvases).runs).toBe(18_000);
    expect(totals(canvases).runs).toBeLessThanOrEqual(SNAPSHOT_MAX_RUNS);
    expect(measuredTexts(proto).has('canvas3')).toBe(true);
    expect(measuredTexts(proto).has('canvas4')).toBe(false);
    expect(contexts[4]!.canvas.dataset.englintCanvas).toBeUndefined(); // not even tagged
  });

  it('stops before 2,000,000 characters of run text', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const [a, b] = [fakeContext(proto), fakeContext(proto)];
    const [long, other] = ['a'.repeat(10_000), 'b'.repeat(10_000)];
    for (let run = 0; run < 150; run++) a.fillText(long, 101, 184.7); // 1,500,000 characters
    for (let run = 0; run < 60; run++) b.fillText(other, 101, 184.7); // 600,000 more would pass the budget

    const { canvases } = recorder.snapshot();

    expect(canvases.map((c) => c.id)).toEqual([a.canvas.dataset.englintCanvas]);
    expect(totals(canvases).text).toBe(1_500_000);
    expect(totals(canvases).text).toBeLessThanOrEqual(SNAPSHOT_MAX_TEXT);
    expect(measuredTexts(proto).has(other)).toBe(false);
  });

  it('holds at most 256 canvases', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    for (let i = 0; i < SNAPSHOT_MAX_CANVASES + 1; i++) fakeContext(proto).fillText(`canvas${i}`, 101, 184.7);

    const { canvases } = recorder.snapshot();

    expect(canvases).toHaveLength(256);
    expect(measuredTexts(proto).has('canvas256')).toBe(false);
  });
});

describe('canvas recorder: repainted lines', () => {
  /** Lines of 14.6667 px text, 17 px apart, as Docs lays out single-spaced body text. */
  const baseline = (line: number) => 100 + line * 17;
  const textsByLine = (recorder: CanvasRecorder) =>
    [...(recorder.snapshot().canvases[0]?.runs ?? [])].sort((p, q) => p.y - q.y || p.x - q.x).map((r) => r.text);

  it('a covering background fill keeps the runs, and a later repaint of one line replaces just that line', async () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    for (let line = 0; line < 20; line++) ctx.fillText(`line ${line}`, 72, baseline(line));
    await endOfTask();

    // Docs repaints a dirty line under a clip: its page-white fill covers the canvas, but only that line is redrawn.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(...PAGE);
    ctx.fillStyle = '#000000';
    ctx.fillText('line 3, edited', 72, baseline(3));

    const expected = Array.from({ length: 20 }, (_, line) => (line === 3 ? 'line 3, edited' : `line ${line}`));
    expect(textsByLine(recorder)).toEqual(expected);
    const line3 = recorder.snapshot().canvases[0]!.runs.find((r) => r.text === 'line 3, edited')!;
    expect(line3.y).toBeCloseTo((1.8 * baseline(3) - 9) * RATIO, 2);
  });

  it('runs drawn in one task share their line, and a run from a later task replaces all of them', async () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    ctx.fillText('\u25CF', 54, baseline(1)); // a list bullet is its own run
    ctx.font = 'bold 14.6667px Arial';
    ctx.fillText('Bold ', 72, baseline(1));
    ctx.font = FONT;
    ctx.fillText('rest', 110, baseline(1));
    ctx.fillText('next line', 72, baseline(2));
    expect(textsByLine(recorder)).toEqual(['\u25CF', 'Bold ', 'rest', 'next line']);
    await endOfTask();

    ctx.fillText('Bold rest, retyped', 72, baseline(1));

    expect(textsByLine(recorder)).toEqual(['Bold rest, retyped', 'next line']);
  });

  it("a run replaces only the lines its font size's band reaches", async () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    const big = '26.6667px Arial';
    ctx.font = big;
    ctx.fillText('Heading', 72, 60);
    ctx.font = FONT;
    ctx.fillText('body 90', 72, 90);
    ctx.fillText('body 107', 72, 107);
    await endOfTask();

    ctx.fillText('body 90, retyped', 72, 90);
    expect(textsByLine(recorder)).toEqual(['Heading', 'body 90, retyped', 'body 107']);
    await endOfTask();

    // 26.67 px text on baseline 95 reaches from about 73.7 to 101.7: both body lines, not the heading.
    ctx.font = big;
    ctx.fillText('Big', 72, 95);
    expect(textsByLine(recorder)).toEqual(['Heading', 'Big']);
  });

  it('repainting one line many times keeps the other lines', async () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    for (let line = 0; line < 20; line++) ctx.fillText(`line ${line}`, 72, baseline(line));
    await endOfTask();
    flushFrame();

    for (let edit = 0; edit < 6000; edit++) {
      ctx.fillText(`line 3 v${edit}`, 72, baseline(3));
      await endOfTask();
      flushFrame();
    }

    const texts = textsByLine(recorder);
    expect(texts).toHaveLength(20);
    expect(texts[3]).toBe('line 3 v5999');
    expect(texts[19]).toBe('line 19');
  });
});

describe('canvas recorder: canvas identity', () => {
  it('tags each canvas with data-englint-canvas once, with a different id per canvas', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const a = fakeContext(proto);
    const b = fakeContext(proto);
    let writes = 0;
    let value: string | undefined;
    Object.defineProperty(a.canvas.dataset, 'englintCanvas', {
      get: () => value,
      set: (next: string) => {
        writes++;
        value = next;
      },
      configurable: true,
      enumerable: true,
    });
    a.fillText(HELLO, 101, 184.7);
    b.fillText(HELLO, 101, 184.7);

    const first = recorder.snapshot().canvases;
    recorder.snapshot();

    expect(first.map((c) => c.id)).toEqual([a.canvas.dataset.englintCanvas, b.canvas.dataset.englintCanvas]);
    expect(first[0]!.id).not.toBe(first[1]!.id);
    expect(writes).toBe(1);
  });

  it('leaves out canvases that are detached or have no size on screen', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const detached = fakeContext(proto);
    detached.canvas.isConnected = false;
    const hidden = fakeContext(proto, { cssWidth: 0 });
    const shown = fakeContext(proto);
    for (const ctx of [detached, hidden, shown]) ctx.fillText(HELLO, 101, 184.7);

    expect(recorder.snapshot().canvases.map((c) => c.id)).toEqual([shown.canvas.dataset.englintCanvas]);
    expect(detached.canvas.dataset.englintCanvas).toBeUndefined();
  });

  it('reads every canvas rect before writing any tag', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const events: string[] = [];
    for (const name of ['a', 'b']) {
      const ctx = fakeContext(proto);
      const rect = ctx.canvas.getBoundingClientRect;
      ctx.canvas.getBoundingClientRect = () => {
        events.push(`rect ${name}`);
        return rect();
      };
      Object.defineProperty(ctx.canvas.dataset, 'englintCanvas', {
        get: () => undefined,
        set: () => events.push(`tag ${name}`),
        configurable: true,
      });
      ctx.fillText(HELLO, 101, 184.7);
    }

    recorder.snapshot();

    expect(events).toEqual(['rect a', 'rect b', 'tag a', 'tag b']);
  });
});

describe('canvas recorder: never breaks painting', () => {
  it('a throwing getTransform still paints, does not throw, and records nothing', () => {
    const proto = fakeProto();
    const originalFillText = proto.fillText;
    const originalFillRect = proto.fillRect;
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    ctx.getTransform = () => {
      throw new Error('no transform');
    };

    expect(() => ctx.fillText(HELLO, 101, 184.7)).not.toThrow();
    ctx.fillStyle = SELECTION_BLUE;
    expect(() => ctx.fillRect(279, 171, 35, 19)).not.toThrow();

    expect(originalFillText).toHaveBeenCalledTimes(1);
    expect(originalFillText.mock.calls[0]).toEqual([HELLO, 101, 184.7]);
    expect(originalFillRect).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot().canvases).toEqual([]);
  });

  it("an error from the original method still reaches the caller, and nothing is recorded", () => {
    const proto = fakeProto();
    proto.fillText.mockImplementationOnce(() => {
      throw new TypeError('Illegal invocation');
    });
    const recorder = start(proto);
    const ctx = fakeContext(proto);

    expect(() => ctx.fillText(HELLO, 101, 184.7)).toThrow('Illegal invocation');
    expect(recorder.snapshot().canvases).toEqual([]);
  });
});

describe('canvas recorder: chaining with other hooks', () => {
  it("records through another extension's context proxy that forwards each call to the real context", () => {
    const proto = fakeProto();
    const originalFillText = proto.fillText;
    const recorder = start(proto);
    const ctx = fakeContext(proto);
    const proxied = new Proxy(ctx, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (...args: unknown[]) => value.apply(target, args) : value;
      },
    });

    proxied.fillText(HELLO, 101, 184.7);

    expect(recorder.snapshot().canvases[0]!.runs.map((r) => r.text)).toEqual(['Hello']);
    expect(originalFillText).toHaveBeenCalledTimes(1);
    expect(originalFillText.mock.contexts[0]).toBe(ctx);
  });

  it('records under a prototype patch added after it, and calls through one added before it', () => {
    const proto = fakeProto();
    const native = proto.fillText;
    const earlier = vi.fn(function (this: unknown, ...args: unknown[]) {
      return native.apply(this, args);
    });
    proto.fillText = earlier as unknown as typeof proto.fillText;
    const recorder = start(proto);
    const ours = proto.fillText;
    const later = vi.fn(function (this: unknown, ...args: unknown[]) {
      return ours.apply(this, args);
    });
    proto.fillText = later as unknown as typeof proto.fillText;
    const ctx = fakeContext(proto);

    ctx.fillText(HELLO, 101, 184.7);

    expect(recorder.snapshot().canvases[0]!.runs.map((r) => r.text)).toEqual(['Hello']);
    expect(later).toHaveBeenCalledTimes(1);
    expect(earlier).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledTimes(1);
  });
});

describe('canvas recorder: paint notifications', () => {
  it('calls onPaint once per frame after several paints, with the latest generation', () => {
    const proto = fakeProto();
    const onPaint = vi.fn();
    const recorder = start(proto, onPaint);
    const ctx = fakeContext(proto);

    ctx.fillText(HELLO, 101, 184.7);
    ctx.fillText(HELLO, 101, 204.7);
    ctx.fillStyle = SELECTION_BLUE;
    ctx.fillRect(279, 171, 35, 19);
    expect(onPaint).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    flushFrame();
    const first = recorder.snapshot().generation;
    expect(onPaint.mock.calls).toEqual([[first]]);

    ctx.fillText(HELLO, 101, 224.7);
    flushFrame();
    expect(onPaint).toHaveBeenCalledTimes(2);
    expect(onPaint.mock.calls[1]![0]).toBeGreaterThan(first);
    expect(onPaint.mock.calls[1]![0]).toBe(recorder.snapshot().generation);
  });

  it('a fill that changes no records asks for no frame', () => {
    const proto = fakeProto();
    const onPaint = vi.fn();
    start(proto, onPaint);
    const ctx = fakeContext(proto);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(...PAGE); // nothing recorded yet, so there is nothing to clear
    ctx.fillRect(279, 171, 35, 19);

    expect(frames).toHaveLength(0);
  });
});

describe('canvas recorder: measuring', () => {
  it('measures on snapshot, not while painting, and serves a repeat from the cache', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    const ctx = fakeContext(proto);

    ctx.fillText(HELLO, 101, 184.7);
    ctx.fillText(HELLO, 101, 204.7);
    expect(proto.measureText).not.toHaveBeenCalled();

    recorder.snapshot();
    expect(proto.measureText).toHaveBeenCalledTimes(1);
    expect(proto.measureText.mock.calls[0]).toEqual(['Hello']);
    recorder.snapshot();
    expect(proto.measureText).toHaveBeenCalledTimes(1);

    ctx.font = '26.6667px Arial';
    ctx.fillText(HELLO, 101, 224.7);
    recorder.snapshot();
    expect(proto.measureText).toHaveBeenCalledTimes(2);
  });

  it('keeps the 2,000 most recently used widths', () => {
    const proto = fakeProto();
    const recorder = start(proto);
    let ctx: FakeContext | null = null;
    const paintAndRead = (...texts: string[]) => {
      if (ctx) ctx.canvas.isConnected = false; // a detached canvas isn't read, so only these texts are measured
      ctx = fakeContext(proto);
      for (const text of texts) ctx.fillText(text, 0, 20);
      recorder.snapshot();
    };
    const measuredTimes = (text: string) => proto.measureText.mock.calls.filter(([t]) => t === text).length;

    paintAndRead(...Array.from({ length: 2000 }, (_, i) => `w${i}`));
    paintAndRead('w0'); // w0 is now the most recently used
    paintAndRead('new'); // the 2,001st width evicts the least recently used one, w1
    paintAndRead('w0', 'w1');

    expect(measuredTimes('w0')).toBe(1);
    expect(measuredTimes('w1')).toBe(2);
  });
});

describe('canvas recorder: stop', () => {
  it('restores the original methods and stops recording', () => {
    const proto = fakeProto();
    const originals = { fillText: proto.fillText, fillRect: proto.fillRect, clearRect: proto.clearRect };
    const recorder = start(proto);
    expect(proto.fillText).not.toBe(originals.fillText);

    recorder.stop();

    expect(proto.fillText).toBe(originals.fillText);
    expect(proto.fillRect).toBe(originals.fillRect);
    expect(proto.clearRect).toBe(originals.clearRect);
    expect(proto.measureText).toBeTypeOf('function');
    fakeContext(proto).fillText(HELLO, 101, 184.7);
    expect(recorder.snapshot().canvases).toEqual([]);
  });

  it('leaves a patch added on top in place, and goes quiet underneath it', () => {
    const proto = fakeProto();
    const native = proto.fillText;
    const onPaint = vi.fn();
    const recorder = start(proto, onPaint);
    const ours = proto.fillText;
    const later = vi.fn(function (this: unknown, ...args: unknown[]) {
      return ours.apply(this, args);
    });
    proto.fillText = later as unknown as typeof proto.fillText;

    recorder.stop();
    fakeContext(proto).fillText(HELLO, 101, 184.7);
    flushFrame();

    expect(proto.fillText).toBe(later);
    expect(native).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot().canvases).toEqual([]);
    expect(onPaint).not.toHaveBeenCalled();
  });
});

describe('canvas recorder: fake check', () => {
  it('the tile fake maps the page rect onto the whole backing', () => {
    expect(1.8 * PAGE[0] - 9).toBeCloseTo(0, 6);
    expect(1.8 * (PAGE[0] + PAGE[2]) - 9).toBeCloseTo(BACKING_W, 6);
    expect(1.8 * (PAGE[1] + PAGE[3]) - 9).toBeCloseTo(BACKING_H, 6);
    // In logical px the page is under a third of the backing area: only the transform makes it a full repaint.
    expect((PAGE[2] * PAGE[3]) / (BACKING_W * BACKING_H)).toBeLessThan(0.35);
    expect(CSS_W / BACKING_W).toBe(RATIO);
  });
});
