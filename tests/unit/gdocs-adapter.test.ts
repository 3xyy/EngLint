import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGdocsAdapter, type GdocsAdapterDeps } from '../../src/content/adapters/gdocs';
import type { GdocsBridge } from '../../src/content/gdocs/bridge';
import type { CanvasPaint, CanvasSnapshot } from '../../src/content/gdocs/canvas-recorder';
import { offsetToRects, readRectRuns } from '../../src/content/gdocs/geometry';
import { splitParagraphs } from '../../src/core/paragraphs';
import { boxFromAttributes, fixtureHtml, fixtureText, perChar } from './gdocs-fixture';

const CONTROL = /[\u0003\u0010\u0011\u0012\u001c]/;

/** A stand-in for the bridge over a Docs document model: getText/getSelection/setSelection, as recorded live. */
function fakeDocs(text = fixtureText) {
  const state = { text, selection: { start: 0, end: 0 } };
  const paintListeners = new Set<(generation: number) => void>();
  const bridge = {
    whenReady: vi.fn(async () => true),
    getText: vi.fn(async () => state.text),
    getSelection: vi.fn(async () => ({ ...state.selection })),
    setSelection: vi.fn(async (start: number, end: number) => {
      state.selection = { start, end };
    }),
    // No canvas recorder on this page (as with WXT_GDOCS_CANVAS=off): geometry comes from the SVG rects.
    getRuns: vi.fn(async (): Promise<Awaited<ReturnType<GdocsBridge['getRuns']>>> => {
      throw new Error('gdocs-no-runs');
    }),
    onPaint: vi.fn((callback: (generation: number) => void) => {
      paintListeners.add(callback);
      return () => {
        paintListeners.delete(callback);
      };
    }),
    dispose: vi.fn(),
  } satisfies GdocsBridge;
  /** A paint announced by the page, as the bridge passes it on. */
  const paint = (generation: number) => [...paintListeners].forEach((cb) => cb(generation));
  return { state, bridge, paint, paintListeners };
}

/** Docs' text-event editable: a paste replaces the model's selection with the pasted text. */
function editableFor(
  state: ReturnType<typeof fakeDocs>['state'],
  opts: { applyAfterMs?: number; ignore?: boolean; ignoreEmpty?: boolean } = {},
) {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  document.body.appendChild(el);
  const pastes: string[] = [];
  el.addEventListener('paste', (e) => {
    const pasted = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    pastes.push(pasted);
    if (opts.ignore || (opts.ignoreEmpty && pasted === '')) return;
    const { start, end } = state.selection;
    const apply = () => (state.text = state.text.slice(0, start) + pasted + state.text.slice(end));
    if (opts.applyAfterMs) setTimeout(apply, opts.applyAfterMs);
    else apply();
  });
  return { el, pastes };
}

function adapterFor(docs: ReturnType<typeof fakeDocs>, deps: GdocsAdapterDeps = {}) {
  return createGdocsAdapter(docs.bridge, 'gdocs', { boxOf: boxFromAttributes, measure: perChar, ...deps });
}

/** Settles a promise under fake timers, recording how long (fake ms) it took. */
async function timed<T>(promise: Promise<T>, stepMs = 50, maxMs = 5000) {
  const state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => Object.assign(state, { done: true, value }));
  let elapsed = 0;
  while (!state.done && elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    elapsed += stepMs;
  }
  return { value: state.value as T, elapsed, done: state.done };
}

beforeEach(() => {
  document.body.innerHTML = fixtureHtml;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('getText', () => {
  it('maps Docs control characters to \\n and keeps offsets 1:1', async () => {
    const adapter = adapterFor(fakeDocs());
    const text = await adapter.getText();
    expect(text).toHaveLength(423);
    expect(text).not.toMatch(CONTROL);
    expect(text.slice(19, 22)).toBe('has');
    for (let i = 0; i < text.length; i++) {
      if (!CONTROL.test(fixtureText[i]!)) expect(text[i]).toBe(fixtureText[i]);
      else expect(text[i]).toBe('\n');
    }
  });

  it('splits into clean paragraphs: no control-only lines, table cells on their own', async () => {
    const paragraphs = splitParagraphs(await adapterFor(fakeDocs()).getText());
    expect(paragraphs.map((p) => p.text)).toEqual([
      'Quarterly Notes',
      'I has a cat and she likes to sleep on the sofa.',
      'Their going to the store after lunch, and they will buy teh bread.',
      '👋 Hello everyone, we is meeting tomorow at noon.',
      ' This line starts with one leading space and it contain a mistake.',
      'This paragraph is clean. It has no spelling or grammar problems at all.',
      'Shopping list:',
      'Apples and oranges',
      'Bread and buter',
      'Milk',
      'Name',
      'Note',
      'Alice',
      'Alice have two dogs.',
    ]);
    expect(paragraphs[1]!.start).toBe(17);
  });

  it('maps the other live control characters: soft line break, page break, table end followed by text', async () => {
    // Recorded live: Shift+Enter is U+000B; a page break is U+000C then \n; \u0011 may be followed by text.
    const raw = '\u0003One\u000bsoft break\nPage one end\u000c\nPage two\n\u0010\u0012\u001cCell\n\u0011After table\n';
    const text = await adapterFor(fakeDocs(raw)).getText();
    expect(text).toHaveLength(raw.length);
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
    expect(splitParagraphs(text).map((p) => p.text)).toEqual(['One', 'soft break', 'Page one end', 'Page two', 'Cell', 'After table']);
  });

  it('reads NBSP as a space, one for one', async () => {
    expect(await adapterFor(fakeDocs('\u0003Hello,\u00a0world\n')).getText()).toBe('\nHello, world\n');
  });
});

describe('getText: one read on its way at a time', () => {
  it('callers that ask while a read is on its way share it (caret, rects, the text): one bridge round trip', async () => {
    const docs = fakeDocs();
    docs.state.selection = { start: 20, end: 20 };
    let answer: (text: string) => void = () => {};
    docs.bridge.getText.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const adapter = adapterFor(docs);

    const all = Promise.all([adapter.getText(), adapter.caret!(), adapter.rectsFor(19, 22)]);
    expect(docs.bridge.getText).toHaveBeenCalledTimes(1);
    answer(fixtureText);
    const [text, caret, rects] = await all;
    expect(text.slice(19, 22)).toBe('has');
    expect(caret).toBe(20);
    expect(rects).toHaveLength(1);

    await adapter.getText(); // asked after that read came back: a read of its own
    expect(docs.bridge.getText).toHaveBeenCalledTimes(2);
  });

  it('a failed read is shared too, and is not kept: the next call reads again', async () => {
    const docs = fakeDocs();
    docs.bridge.getText.mockRejectedValueOnce(new Error('gdocs-timeout'));
    const adapter = adapterFor(docs);
    const [text, rects] = await Promise.allSettled([adapter.getText(), adapter.rectsFor(19, 22)]);
    expect(text.status).toBe('rejected');
    expect(rects).toEqual({ status: 'fulfilled', value: [] });
    expect(docs.bridge.getText).toHaveBeenCalledTimes(1);
    expect((await adapter.getText()).slice(19, 22)).toBe('has');
    expect(docs.bridge.getText).toHaveBeenCalledTimes(2);
  });

  it('says every change to the text reaches onChange, so a read may stand until the next one', () => {
    expect(adapterFor(fakeDocs()).reportsEveryChange).toBe(true);
  });
});

describe('replace', () => {
  beforeEach(() => vi.useFakeTimers());

  it('selects the range, pastes into the editable and confirms by re-reading', async () => {
    const docs = fakeDocs();
    const { el, pastes } = editableFor(docs.state);
    const focus = vi.spyOn(el, 'focus');
    const adapter = adapterFor(docs, { editable: () => el });

    const { value, elapsed } = await timed(adapter.replace(19, 22, 'have'));
    expect(value).toBe(true);
    expect(docs.bridge.setSelection).toHaveBeenCalledWith(19, 22);
    expect(focus).toHaveBeenCalled();
    expect(pastes).toEqual(['have']);
    expect(docs.state.text.slice(17, 28)).toBe('I have a ca');
    expect(elapsed).toBeLessThanOrEqual(150);
  });

  it('turns leading and trailing spaces into NBSP so Docs keeps them, and verifies after normalizing', async () => {
    const docs = fakeDocs('\u0003Hello,world\n');
    const { el, pastes } = editableFor(docs.state);
    const adapter = adapterFor(docs, { editable: () => el });

    const { value } = await timed(adapter.replace(7, 7, ' big '));
    expect(pastes).toEqual(['\u00a0big\u00a0']);
    expect(value).toBe(true);
    expect(docs.state.text).toBe('\u0003Hello,\u00a0big\u00a0world\n');
  });

  it('keeps inner spaces as they are', async () => {
    const docs = fakeDocs('\u0003a b\n');
    const { el, pastes } = editableFor(docs.state);
    await timed(adapterFor(docs, { editable: () => el }).replace(1, 4, 'x  y'));
    expect(pastes).toEqual(['x  y']);
  });

  it('waits for a change that shows up late', async () => {
    const docs = fakeDocs();
    const { el } = editableFor(docs.state, { applyAfterMs: 350 });
    const { value, elapsed } = await timed(adapterFor(docs, { editable: () => el }).replace(19, 22, 'have'));
    expect(value).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(600);
  });

  it('gives up with false after 600 ms when the text never changes', async () => {
    const docs = fakeDocs();
    const { el, pastes } = editableFor(docs.state, { ignore: true });
    const { value, elapsed, done } = await timed(adapterFor(docs, { editable: () => el }).replace(19, 22, 'have'), 10);
    expect(done).toBe(true);
    expect(value).toBe(false);
    expect(pastes).toEqual(['have']); // pasted once, never again
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(800);
  });

  it('false when the text changed into something else', async () => {
    const docs = fakeDocs();
    const el = document.createElement('div');
    el.addEventListener('paste', () => (docs.state.text = docs.state.text.replace('has', 'hasn')));
    const { value } = await timed(adapterFor(docs, { editable: () => el }).replace(19, 22, 'have'));
    expect(value).toBe(false);
  });

  it('a fix that is a prefix of the original is not confirmed by unchanged text', async () => {
    const docs = fakeDocs('\u0003the the cat\n');
    const { el } = editableFor(docs.state, { ignore: true });
    const { value } = await timed(adapterFor(docs, { editable: () => el }).replace(1, 8, 'the'));
    expect(value).toBe(false);
  });

  describe('a deletion (empty fix) pastes one neighbouring character over a widened range', () => {
    // Whether Docs applies an empty paste is unverified live; these editables ignore one.
    it('widens by the following character', async () => {
      const docs = fakeDocs('\u0003I am really happy.\n');
      const { el, pastes } = editableFor(docs.state, { ignoreEmpty: true });
      const adapter = adapterFor(docs, { editable: () => el });
      expect(docs.state.text.slice(6, 13)).toBe('really ');

      const { value } = await timed(adapter.replace(6, 13, ''));
      expect(value).toBe(true);
      expect(docs.bridge.setSelection).toHaveBeenCalledWith(6, 14);
      expect(pastes).toEqual(['h']);
      expect(docs.state.text).toBe('\u0003I am happy.\n');
    });

    it('a following space is pasted as NBSP (Docs drops plain edge spaces) and verified as a space', async () => {
      const docs = fakeDocs('\u0003I am really happy.\n');
      const { el, pastes } = editableFor(docs.state, { ignoreEmpty: true });
      const adapter = adapterFor(docs, { editable: () => el });
      const { value } = await timed(adapter.replace(5, 12, '')); // " really"
      expect(value).toBe(true);
      expect(pastes).toEqual(['\u00a0']);
      expect(await adapter.getText()).toBe('\nI am happy.\n');
    });

    it('at the end of a paragraph or of the text, widens by the preceding character', async () => {
      const docs = fakeDocs('\u0003Hello there!!\nNext\n');
      const { el, pastes } = editableFor(docs.state, { ignoreEmpty: true });
      const adapter = adapterFor(docs, { editable: () => el });
      expect((await timed(adapter.replace(13, 14, ''))).value).toBe(true); // the second "!", before "\n"
      expect(docs.bridge.setSelection).toHaveBeenLastCalledWith(12, 14);
      expect(pastes).toEqual(['!']);
      expect(docs.state.text).toBe('\u0003Hello there!\nNext\n');

      const end = fakeDocs('\u0003abc d');
      const e = editableFor(end.state, { ignoreEmpty: true });
      expect((await timed(adapterFor(end, { editable: () => e.el }).replace(4, 6, ''))).value).toBe(true);
      expect(end.bridge.setSelection).toHaveBeenLastCalledWith(3, 6);
      expect(e.pastes).toEqual(['c']);
      expect(end.state.text).toBe('\u0003abc');
    });

    it('never borrows a control character, a newline or half of a surrogate pair', async () => {
      const docs = fakeDocs('\u0003xa\u{1f44b}\n');
      const { el, pastes } = editableFor(docs.state, { ignoreEmpty: true });
      expect((await timed(adapterFor(docs, { editable: () => el }).replace(2, 3, ''))).value).toBe(true); // "a", before 👋
      expect(docs.bridge.setSelection).toHaveBeenLastCalledWith(1, 3);
      expect(pastes).toEqual(['x']);
      expect(docs.state.text).toBe('\u0003x\u{1f44b}\n');
    });

    it('with no usable neighbour, falls back to an empty paste', async () => {
      const honoured = fakeDocs('\u0003x\n');
      const h = editableFor(honoured.state);
      expect((await timed(adapterFor(honoured, { editable: () => h.el }).replace(1, 2, ''))).value).toBe(true);
      expect(honoured.bridge.setSelection).toHaveBeenLastCalledWith(1, 2);
      expect(h.pastes).toEqual(['']);
      expect(honoured.state.text).toBe('\u0003\n');

      const ignored = fakeDocs('\u0003x\n');
      const i = editableFor(ignored.state, { ignoreEmpty: true });
      expect((await timed(adapterFor(ignored, { editable: () => i.el }).replace(1, 2, ''))).value).toBe(false);
    });
  });

  it('clamps offsets to the text before selecting', async () => {
    const docs = fakeDocs();
    const { el } = editableFor(docs.state, { ignore: true });
    const adapter = adapterFor(docs, { editable: () => el });
    await timed(adapter.replace(-5, 9999, 'x'));
    expect(docs.bridge.setSelection).toHaveBeenLastCalledWith(0, 423);
    await timed(adapter.replace(500, 600, 'x'));
    expect(docs.bridge.setSelection).toHaveBeenLastCalledWith(423, 423);
  });

  it('never throws: a failing bridge, a missing editable or a reversed range give false', async () => {
    const docs = fakeDocs();
    const { el } = editableFor(docs.state);
    docs.bridge.setSelection.mockRejectedValueOnce(new Error('gdocs-timeout'));
    expect((await timed(adapterFor(docs, { editable: () => el }).replace(19, 22, 'have'))).value).toBe(false);

    docs.bridge.getText.mockRejectedValueOnce(new Error('gdocs-timeout'));
    expect((await timed(adapterFor(docs, { editable: () => el }).replace(19, 22, 'have'))).value).toBe(false);

    const noEditable = adapterFor(docs, { editable: () => null });
    expect((await timed(noEditable.replace(19, 22, 'have'))).value).toBe(false);

    expect((await timed(adapterFor(docs, { editable: () => el }).replace(22, 19, 'have'))).value).toBe(false);
    expect(docs.state.text).toBe(fixtureText);
  });

  it('a failed re-read during polling is retried', async () => {
    const docs = fakeDocs();
    const { el } = editableFor(docs.state);
    const adapter = adapterFor(docs, { editable: () => el });
    docs.bridge.getText.mockResolvedValueOnce(fixtureText).mockRejectedValueOnce(new Error('gdocs-timeout'));
    expect((await timed(adapter.replace(19, 22, 'have'))).value).toBe(true);
  });

  it('after dispose, false without touching the document', async () => {
    const docs = fakeDocs();
    const { el, pastes } = editableFor(docs.state);
    const adapter = adapterFor(docs, { editable: () => el });
    adapter.dispose();
    expect((await timed(adapter.replace(19, 22, 'have'))).value).toBe(false);
    expect(pastes).toEqual([]);
    expect(docs.bridge.setSelection).not.toHaveBeenCalled();
  });
});

describe('select and caret', () => {
  it('select clamps and focuses the editable', async () => {
    vi.useFakeTimers();
    const docs = fakeDocs();
    const el = document.createElement('div');
    const focus = vi.spyOn(el, 'focus');
    const adapter = adapterFor(docs, { editable: () => el });
    await timed(adapter.select(400, 9999));
    expect(docs.bridge.setSelection).toHaveBeenCalledWith(400, 423);
    expect(focus).toHaveBeenCalled();
  });

  it('caret is the collapsed selection, clamped to the text', async () => {
    const docs = fakeDocs();
    const adapter = adapterFor(docs);
    docs.state.selection = { start: 420, end: 420 };
    expect(await adapter.caret!()).toBe(420);
    docs.state.selection = { start: 5000, end: 5000 }; // a forged answer
    expect(await adapter.caret!()).toBe(423);
    docs.state.selection = { start: 19, end: 22 };
    expect(await adapter.caret!()).toBeNull();
  });

  it('selection orders a backward range (shift+left), and is null when collapsed', async () => {
    const docs = fakeDocs();
    const adapter = adapterFor(docs);
    docs.state.selection = { start: 22, end: 19 }; // the bridge reports anchor, then focus
    expect(await adapter.selection!()).toEqual({ start: 19, end: 22 });
    docs.state.selection = { start: 19, end: 22 };
    expect(await adapter.selection!()).toEqual({ start: 19, end: 22 });
    docs.state.selection = { start: 20, end: 20 };
    expect(await adapter.selection!()).toBeNull();
  });

  it('caret is null when the bridge fails', async () => {
    const docs = fakeDocs();
    docs.bridge.getSelection.mockRejectedValueOnce(new Error('gdocs-timeout'));
    expect(await adapterFor(docs).caret!()).toBeNull();
  });
});

describe('rects', () => {
  const expected = (start: number, end: number) => {
    const runs = readRectRuns(document, boxFromAttributes);
    return offsetToRects(fixtureText, runs, start, end, perChar);
  };

  it('maps ranges through the rendered rects, in input order', async () => {
    const adapter = adapterFor(fakeDocs());
    const buter = fixtureText.indexOf('buter');
    const [has, b, none] = await adapter.rectsForMany!([
      { start: 19, end: 22 },
      { start: buter, end: buter + 5 },
      { start: 500, end: 510 },
    ]);
    expect(has).toEqual(expected(19, 22));
    expect(has).toHaveLength(1);
    expect(b).toEqual(expected(buter, buter + 5));
    expect(b![0]!.x).toBeGreaterThan(144);
    expect(none).toEqual([]);
    expect(await adapter.rectsFor(19, 22)).toEqual(has);
  });

  it('clips rects to the editor scroll container', async () => {
    const editor = document.querySelector('.kix-appview-editor')!;
    const boxOf = (el: Element) =>
      el === editor ? { x: 0, y: 150, width: 2000, height: 1000 } : boxFromAttributes(el);
    const adapter = adapterFor(fakeDocs(), { boxOf });
    const [heading, has] = await adapter.rectsForMany!([
      { start: 1, end: 10 }, // "Quarterly": its line box runs from y=122.08 to 154.08
      { start: 19, end: 22 },
    ]);
    expect(heading).toHaveLength(1);
    expect(heading![0]!.top).toBe(150);
    expect(heading![0]!.bottom).toBeCloseTo(154.08, 6);
    expect(has).toEqual(expected(19, 22));

    const below = adapterFor(fakeDocs(), {
      boxOf: (el) => (el === editor ? { x: 0, y: 200, width: 2000, height: 1000 } : boxFromAttributes(el)),
    });
    expect(await below.rectsFor(19, 22)).toEqual([]);
  });

  it('with the layer anchored in the editor, rects are not clipped: the editor clips the layer itself', async () => {
    const editor = document.querySelector('.kix-appview-editor')!;
    const boxOf = (el: Element) => (el === editor ? { x: 0, y: 200, width: 2000, height: 1000 } : boxFromAttributes(el));
    const adapter = adapterFor(fakeDocs(), { boxOf });
    expect(await adapter.rectsFor(19, 22)).toEqual([]); // the fixed layer: scrolled out of view, no rect
    expect(await adapter.rectsFor(19, 22, { clipUntil: editor })).toEqual(expected(19, 22)); // painted: kept
    const [heading] = await adapter.rectsForMany!([{ start: 1, end: 10 }], { clipUntil: document.body });
    expect(heading![0]!.top).toBeCloseTo(122.08, 6); // an anchor above the editor doesn't clip either
  });

  it('scrollRoot is the editor scroller', () => {
    expect(adapterFor(fakeDocs()).scrollRoot!()).toBe(document.querySelector('.kix-appview-editor'));
  });

  it("paintRoot is the tile container: the text's stacking level (z-index 22 live)", () => {
    const tiles = document.querySelector('.kix-rotatingtilemanager-content');
    expect(tiles).not.toBeNull();
    expect(adapterFor(fakeDocs()).paintRoot!()).toBe(tiles);
  });

  it('paintRoot ignores a tile container outside the editor (placement and z-index both follow it)', () => {
    const tiles = document.querySelector('.kix-appview-editor .kix-rotatingtilemanager-content');
    const stray = document.createElement('div');
    stray.className = 'kix-rotatingtilemanager-content';
    document.body.prepend(stray); // first in document order, but not in the editor
    try {
      expect(adapterFor(fakeDocs()).paintRoot!()).toBe(tiles);
    } finally {
      stray.remove();
    }
  });

  it("hitRegion is the tile manager: where the pointer lands over the text, not Docs' other UI in the editor", () => {
    const hit = document.querySelector('.kix-appview-editor .kix-rotatingtilemanager');
    expect(hit).not.toBeNull();
    expect(hit!.contains(document.querySelector('.kix-rotatingtilemanager-content'))).toBe(true);
    expect(adapterFor(fakeDocs()).hitRegion!()).toBe(hit);
  });

  it('no rects when the bridge fails or after dispose', async () => {
    const docs = fakeDocs();
    const adapter = adapterFor(docs);
    docs.bridge.getText.mockRejectedValueOnce(new Error('gdocs-timeout'));
    expect(await adapter.rectsForMany!([{ start: 19, end: 22 }])).toEqual([[]]);
    adapter.dispose();
    expect(await adapter.rectsFor(19, 22)).toEqual([]);
  });

  it('element is the editor scroll container', () => {
    expect(adapterFor(fakeDocs()).element).toBe(document.querySelector('.kix-appview-editor'));
  });
});

describe('rects from canvas runs', () => {
  const LINE = 'I has a cat and she likes to sleep on the sofa.';
  const HAS = { start: 19, end: 22 };
  /** That line painted justified: one run per word, 24 px apart, its baseline inside the line's rect. */
  const justified = (dx = 0): CanvasPaint => ({
    id: '1',
    runs: LINE.split(' ').map((word, i) => ({ text: word, font: '14.6667px Arial', x: 96 + dx + 24 * i, y: 179, width: 20 })),
    selection: [],
  });
  const snapshot = (generation: number, dx = 0): CanvasSnapshot => ({ generation, canvases: [justified(dx)] });
  /** The canvas at the viewport origin: canvas px are viewport px. */
  const boxOf = (el: Element) => (el.tagName === 'CANVAS' ? { x: 0, y: 0, width: 816, height: 1056 } : boxFromAttributes(el));
  const lineRun = () => readRectRuns(document, boxFromAttributes).find((r) => r.text === LINE)!;
  /** Where "has" lands on the canvas run painted `dx` px to the right. */
  const onCanvas = (dx = 0) => [{ x: 120 + dx, y: lineRun().y, width: 20, height: lineRun().height }];
  const fromSvg = () => offsetToRects(fixtureText, readRectRuns(document, boxFromAttributes), HAS.start, HAS.end, perChar).map(box);
  const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

  function plantCanvas(id = '1') {
    const canvas = document.createElement('canvas');
    canvas.dataset.englintCanvas = id;
    document.querySelector('.kix-rotatingtilemanager-content')!.append(canvas);
    return canvas;
  }

  function canvasDocs(first: CanvasSnapshot = snapshot(1)) {
    const docs = fakeDocs();
    docs.bridge.getRuns.mockImplementation(async () => first);
    return docs;
  }

  const hasRects = async (adapter: ReturnType<typeof adapterFor>) => (await adapter.rectsFor(HAS.start, HAS.end)).map(box);

  beforeEach(() => plantCanvas());

  it('a word is measured on the run Docs painted it in, not spread evenly over the line rect', async () => {
    const adapter = adapterFor(canvasDocs(), { boxOf });
    const [has, none] = await adapter.rectsForMany!([HAS, { start: 500, end: 510 }]);
    expect(has!.map(box)).toEqual(onCanvas());
    expect(none).toEqual([]);
    expect(fromSvg()[0]!.x).toBeCloseTo(96 + 2 * (293.386 / 47), 6); // the rect alone: 108.5
  });

  it('reads the runs once per paint generation: the same generation reuses them, a new one is read on the next measure', async () => {
    const docs = canvasDocs();
    const adapter = adapterFor(docs, { boxOf });
    expect(await hasRects(adapter)).toEqual(onCanvas());
    expect(await hasRects(adapter)).toEqual(onCanvas());
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(1);

    docs.paint(1);
    expect(await hasRects(adapter)).toEqual(onCanvas());
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(1);

    docs.bridge.getRuns.mockImplementation(async () => snapshot(2, 5));
    docs.paint(2);
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(1); // not read inside the paint callback
    expect(await hasRects(adapter)).toEqual(onCanvas(5));
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(2);
  });

  it('a paint that lands while the runs are being read makes the next measure read them again', async () => {
    const docs = canvasDocs();
    let answer: (value: CanvasSnapshot) => void = () => {};
    docs.bridge.getRuns.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const adapter = adapterFor(docs, { boxOf });
    const first = hasRects(adapter);
    docs.paint(5);
    answer(snapshot(4));
    expect(await first).toEqual(onCanvas());

    docs.bridge.getRuns.mockImplementation(async () => snapshot(5, 5));
    expect(await hasRects(adapter)).toEqual(onCanvas(5));
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(2);
  });

  it('measures that overlap share one read', async () => {
    const docs = canvasDocs();
    const adapter = adapterFor(docs, { boxOf });
    const [a, b] = await Promise.all([hasRects(adapter), hasRects(adapter)]);
    expect(a).toEqual(onCanvas());
    expect(b).toEqual(onCanvas());
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(1);
  });

  it('a failed read falls back to the SVG rects, and is tried again only after the next paint', async () => {
    const docs = canvasDocs();
    docs.bridge.getRuns.mockRejectedValueOnce(new Error('gdocs-too-large'));
    const adapter = adapterFor(docs, { boxOf });
    expect(await hasRects(adapter)).toEqual(fromSvg());
    expect(await hasRects(adapter)).toEqual(fromSvg());
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(1);

    docs.paint(3);
    expect(await hasRects(adapter)).toEqual(onCanvas());
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(2);
  });

  it('a read that never answers falls back to the SVG rects well before the bridge gives up on it', async () => {
    vi.useFakeTimers();
    const docs = canvasDocs();
    docs.bridge.getRuns.mockImplementation(() => new Promise(() => {}));
    const adapter = adapterFor(docs, { boxOf });
    const { value, elapsed, done } = await timed(adapter.rectsFor(HAS.start, HAS.end), 10);
    expect(done).toBe(true);
    expect(value.map(box)).toEqual(fromSvg());
    expect(elapsed).toBeLessThanOrEqual(300);
  });

  it('without a recorder on the page (gdocs-no-runs) the runs are asked for once, and the SVG rects are used', async () => {
    const docs = fakeDocs(); // getRuns rejects gdocs-no-runs
    const adapter = adapterFor(docs, { boxOf });
    for (let i = 0; i < 3; i++) expect(await hasRects(adapter)).toEqual(fromSvg());
    expect(docs.bridge.getRuns).toHaveBeenCalledTimes(1);
  });

  it('a canvas id that two canvases carry is ignored: any page script can set the attribute', async () => {
    plantCanvas('1');
    const adapter = adapterFor(canvasDocs(), { boxOf });
    expect(await hasRects(adapter)).toEqual(fromSvg());
  });

  it('a canvas id that is not a plain number is never put in a selector: that canvas is ignored, the rest still measure', async () => {
    // The bad entry comes first, painted 40 px off; the valid canvas after it paints the line where it is.
    const bad = { ...justified(40), id: '1"]' };
    const adapter = adapterFor(canvasDocs({ generation: 1, canvases: [bad, justified()] }), { boxOf });
    expect(await hasRects(adapter)).toEqual(onCanvas());
  });

  it('a canvas id with no canvas behind it is ignored', async () => {
    document.querySelector('canvas')!.remove();
    const adapter = adapterFor(canvasDocs(), { boxOf });
    expect(await hasRects(adapter)).toEqual(fromSvg());
  });

  describe('selectionRects', () => {
    const withSelection = (selection: CanvasPaint['selection'], generation = 1): CanvasSnapshot => ({
      generation,
      canvases: [{ ...justified(), selection }],
    });
    /** The canvas sits 10 px right of and 20 px below the viewport origin. */
    const offsetBox = (el: Element) => (el.tagName === 'CANVAS' ? { x: 10, y: 20, width: 816, height: 1056 } : boxFromAttributes(el));
    const asBoxes = (rects: DOMRect[] | null) => rects?.map(box) ?? null;

    it('gives each recorded highlight box as a viewport rect, from the canvas as it sits now', async () => {
      const adapter = adapterFor(
        canvasDocs(withSelection([{ x: 100, y: 170, width: 40, height: 18 }, { x: 96, y: 194, width: 70, height: 18 }])),
        { boxOf: offsetBox },
      );
      const rects = await adapter.selectionRects!();
      expect(rects!.every((r) => r instanceof DOMRect)).toBe(true);
      expect(asBoxes(rects)).toEqual([
        { x: 110, y: 190, width: 40, height: 18 },
        { x: 106, y: 214, width: 70, height: 18 },
      ]);
    });

    it('is null when no highlight is recorded, when the runs cannot be read, and when its canvas is gone', async () => {
      expect(await adapterFor(canvasDocs(withSelection([])), { boxOf }).selectionRects!()).toBeNull();
      expect(await adapterFor(fakeDocs(), { boxOf }).selectionRects!()).toBeNull(); // gdocs-no-runs
      document.querySelector('canvas')!.remove();
      const gone = adapterFor(canvasDocs(withSelection([{ x: 0, y: 0, width: 5, height: 5 }])), { boxOf });
      expect(await gone.selectionRects!()).toBeNull();
    });

    it('orders the rects top to bottom, left to right, so the last one is where the selection ends', async () => {
      const adapter = adapterFor(
        canvasDocs(withSelection([{ x: 96, y: 194, width: 70, height: 18 }, { x: 100, y: 170, width: 40, height: 18 }])),
        { boxOf },
      );
      expect((await adapter.selectionRects!())!.map((r) => r.y)).toEqual([170, 194]);
    });

    it('puts boxes on one visual line in x order even when their heights and tops differ', async () => {
      const adapter = adapterFor(
        canvasDocs(
          withSelection([
            { x: 300, y: 171, width: 40, height: 14 }, // a smaller font: lower top, same line
            { x: 96, y: 170, width: 60, height: 18 },
            { x: 200, y: 168.5, width: 40, height: 22 },
            { x: 96, y: 194, width: 70, height: 18 }, // the next line
          ]),
        ),
        { boxOf },
      );
      expect((await adapter.selectionRects!())!.map((r) => [r.x, r.y])).toEqual([[96, 170], [200, 168.5], [300, 171], [96, 194]]);
    });

    it('reads the highlight again after a paint, and reuses the runs it already has otherwise', async () => {
      const docs = canvasDocs(withSelection([{ x: 100, y: 170, width: 40, height: 18 }]));
      const adapter = adapterFor(docs, { boxOf });
      expect(asBoxes(await adapter.selectionRects!())).toEqual([{ x: 100, y: 170, width: 40, height: 18 }]);
      await adapter.selectionRects!();
      expect(docs.bridge.getRuns).toHaveBeenCalledTimes(1);

      docs.bridge.getRuns.mockImplementation(async () => withSelection([{ x: 100, y: 170, width: 90, height: 18 }], 2));
      docs.paint(2);
      expect(asBoxes(await adapter.selectionRects!())).toEqual([{ x: 100, y: 170, width: 90, height: 18 }]);
    });

    it('drops boxes with no size or a non-finite position', async () => {
      const adapter = adapterFor(
        canvasDocs(withSelection([{ x: 1, y: 2, width: 0, height: 18 }, { x: NaN, y: 2, width: 9, height: 18 }, { x: 100, y: 170, width: 40, height: 18 }])),
        { boxOf },
      );
      expect(asBoxes(await adapter.selectionRects!())).toEqual([{ x: 100, y: 170, width: 40, height: 18 }]);
    });

    it('leaves out a highlight scrolled out of the editor, and keeps the one in view', async () => {
      const editorBox = (el: Element) =>
        el.classList.contains('kix-appview-editor') ? { x: 0, y: 200, width: 2000, height: 1000 } : boxOf(el);
      const adapter = adapterFor(
        canvasDocs(withSelection([{ x: 100, y: 170, width: 40, height: 18 }, { x: 100, y: 300, width: 40, height: 18 }])),
        { boxOf: editorBox },
      );
      expect(asBoxes(await adapter.selectionRects!())).toEqual([{ x: 100, y: 300, width: 40, height: 18 }]);
    });

    it('is null after dispose', async () => {
      const adapter = adapterFor(canvasDocs(withSelection([{ x: 100, y: 170, width: 40, height: 18 }])), { boxOf });
      adapter.dispose();
      expect(await adapter.selectionRects!()).toBeNull();
    });
  });

  it('listens for paints from creation until dispose', () => {
    const docs = canvasDocs();
    const adapter = adapterFor(docs, { boxOf });
    expect(docs.paintListeners.size).toBe(1);
    adapter.dispose();
    expect(docs.paintListeners.size).toBe(0);
  });
});

describe('events', () => {
  beforeEach(() => vi.useFakeTimers());

  function setup() {
    const docs = fakeDocs();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const adapter = adapterFor(docs, { editable: () => el });
    return { docs, adapter, el };
  }
  const edit = (docs: ReturnType<typeof fakeDocs>, from: string, to: string) =>
    (docs.state.text = docs.state.text.replace(from, to));
  const repaint = () => {
    document.querySelectorAll('rect[aria-label]')[1]!.setAttribute('aria-label', 'I has a cat and she likes to sleep on the sofa.');
    document.querySelector('.kix-canvas-tile-content')!.appendChild(document.createElement('div'));
  };

  it('onChange: input and keyup in the editable document, coalesced per frame, once the text changed', async () => {
    const { docs, adapter, el } = setup();
    const cb = vi.fn();
    adapter.onChange(cb);
    await vi.advanceTimersByTimeAsync(0); // the baseline read
    edit(docs, 'has', 'had');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(cb).toHaveBeenCalledTimes(1);
    edit(docs, 'had', 'have');
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'b', bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('onChange: a tile repaint that comes with a changed text', async () => {
    const { docs, adapter } = setup();
    const cb = vi.fn();
    adapter.onChange(cb);
    await vi.advanceTimersByTimeAsync(0);
    edit(docs, 'has', 'have');
    document.querySelectorAll('rect[aria-label]')[1]!.setAttribute('aria-label', 'I have a cat');
    await vi.advanceTimersByTimeAsync(120);
    expect(cb).toHaveBeenCalledTimes(1);
    edit(docs, 'Milk', 'Milk\nEggs');
    document.querySelector('.kix-canvas-tile-content')!.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(120);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('a repaint or keyup with an unchanged text is a layout change only', async () => {
    const { docs, adapter, el } = setup();
    const change = vi.fn();
    const layout = vi.fn();
    adapter.onChange(change);
    adapter.onLayoutChange(layout);
    await vi.advanceTimersByTimeAsync(0);
    repaint();
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(change).not.toHaveBeenCalled();
    expect(layout).toHaveBeenCalled();

    // After an edit is reported, repainting that same text is not a second change.
    edit(docs, 'has', 'had');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(change).toHaveBeenCalledTimes(1);
    repaint();
    await vi.advanceTimersByTimeAsync(300);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('repaints with an unchanged text trigger no check; an edit does', async () => {
    const { FieldSession } = await import('../../src/content/session');
    const { defaultFamilies } = await import('../../src/core/modes');
    const { docs, adapter } = setup();
    const send = vi.fn(async (req: { paragraphs: { hash: string }[] }) => ({
      status: 'ok' as const,
      results: Object.fromEntries(req.paragraphs.map((p) => [p.hash, []])),
      dismissed: [],
    }));
    const session = new FieldSession(adapter, {
      host: 'docs.google.com',
      getMode: () => 'essay',
      policy: (mode) => ({ mode, families: defaultFamilies(mode), rules: new Set(), dictionary: new Set() }),
      send,
      persistDismissal: async () => {},
      onUpdate: () => {},
    });
    const reads = () => docs.bridge.getText.mock.calls.length;
    session.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(send).toHaveBeenCalledTimes(1);

    const before = reads();
    for (let i = 0; i < 5; i++) {
      repaint(); // scrolling: tiles repainted, text unchanged
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reads() - before).toBe(5); // one change-detection read per repaint, no session refresh

    edit(docs, 'Milk', 'Milk and honey');
    repaint();
    await vi.advanceTimersByTimeAsync(1200);
    expect(send).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('a failed text read counts as a change', async () => {
    const { docs, adapter, el } = setup();
    const cb = vi.fn();
    adapter.onChange(cb);
    await vi.advanceTimersByTimeAsync(0);
    docs.bridge.getText.mockRejectedValueOnce(new Error('gdocs-timeout'));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('onChange ignores other attribute changes', async () => {
    const { docs, adapter } = setup();
    const cb = vi.fn();
    adapter.onChange(cb);
    await vi.advanceTimersByTimeAsync(0);
    edit(docs, 'has', 'have');
    document.querySelector('rect[aria-label]')!.setAttribute('opacity', '1');
    await vi.advanceTimersByTimeAsync(120);
    expect(cb).not.toHaveBeenCalled();
  });

  it('onLayoutChange: editor scroll, window resize, and tile mutations (a redraw)', async () => {
    const { adapter } = setup();
    const cb = vi.fn();
    adapter.onLayoutChange(cb);
    const editor = document.querySelector('.kix-appview-editor')!;
    editor.dispatchEvent(new Event('scroll'));
    expect(cb.mock.calls).toEqual([[editor]]); // what scrolled: the editor
    window.dispatchEvent(new Event('resize'));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1]).toEqual([]);
    document.querySelector('rect[aria-label]')!.setAttribute('aria-label', 'Quarterly notes');
    await vi.advanceTimersByTimeAsync(120);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb.mock.calls[2]).toEqual([undefined, true]); // a repaint is no scroll, and says it only redrew the lines
  });

  it('unsubscribe and dispose stop every callback', async () => {
    const { docs, adapter, el } = setup();
    const change = vi.fn();
    const layout = vi.fn();
    const offChange = adapter.onChange(change);
    adapter.onLayoutChange(layout);
    await vi.advanceTimersByTimeAsync(0);
    offChange();
    edit(docs, 'has', 'had');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(change).not.toHaveBeenCalled();

    adapter.dispose();
    expect(adapter.isAlive()).toBe(false);
    edit(docs, 'had', 'have');
    document.querySelector('.kix-appview-editor')!.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    document.querySelector('rect[aria-label]')!.setAttribute('aria-label', 'changed');
    await vi.advanceTimersByTimeAsync(120);
    expect(layout).not.toHaveBeenCalled();
    expect(adapter.onChange(change)).toBeTypeOf('function');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(change).not.toHaveBeenCalled();
  });

  it('isAlive until disposed, or until the editor leaves the page', () => {
    const { adapter } = setup();
    expect(adapter.isAlive()).toBe(true);
    adapter.dispose();
    expect(adapter.isAlive()).toBe(false);

    const second = setup().adapter;
    expect(second.isAlive()).toBe(true);
    document.querySelector('.kix-appview-editor')!.remove();
    expect(second.isAlive()).toBe(false);
  });
});
