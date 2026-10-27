import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContentEditableAdapter } from '../../src/content/adapters/contenteditable';
import { buildTextMap } from '../../src/content/adapters/text-map';

// A pass-through spy: the real builder, counted.
vi.mock('../../src/content/adapters/text-map', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/content/adapters/text-map')>();
  return { ...actual, buildTextMap: vi.fn(actual.buildTextMap) };
});
const builds = vi.mocked(buildTextMap);

let root: HTMLDivElement;

function setHtml(html: string): void {
  root.innerHTML = html;
}

/** What Chrome's insertText does, close enough: replace the selected range with the text. */
function editSelection(text: string): void {
  const range = document.getSelection()!.getRangeAt(0);
  range.deleteContents();
  if (text) range.insertNode(document.createTextNode(text));
}

const selectedText = () => document.getSelection()!.toString();
const plain = (s: string) => s.replace(/\u00a0/g, ' ');
const oneRect = () => [new DOMRect(0, 0, 10, 16)] as unknown as DOMRectList;
const ticks = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  root = document.createElement('div');
  root.setAttribute('contenteditable', 'true');
  root.innerHTML = '<p>I has a cat</p>';
  document.body.appendChild(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (document as any).execCommand;
});

describe('contenteditable adapter', () => {
  it('reads the text through the text map', async () => {
    setHtml('<p>Hi <b>there</b></p><p>Next</p>');
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.getText()).toBe('Hi there\nNext');
    expect(a.fieldId).toBe('f1');
    expect(a.element).toBe(root);
  });

  it('replaces with execCommand insertText on the selected range', async () => {
    const exec = vi.fn((_cmd: string, _ui: boolean, text: string) => {
      expect(selectedText()).toBe('has');
      editSelection(text);
      return true;
    });
    (document as any).execCommand = exec;
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(exec).toHaveBeenCalledWith('insertText', false, 'have');
    expect(root.textContent).toBe('I have a cat');
    expect(document.activeElement).toBe(root);
  });

  it('replaces in the right place across paragraphs and inline elements', async () => {
    setHtml('<p>Hi <b>there</b>.</p><p>All good.</p><p>She go home.</p>');
    (document as any).execCommand = vi.fn((_c: string, _u: boolean, text: string) => (editSelection(text), true));
    const a = createContentEditableAdapter(root, 'f1');
    const text = await a.getText();
    const start = text.indexOf(' go ') + 1;
    expect(await a.replace(start, start + 2, 'goes')).toBe(true);
    expect(await a.getText()).toBe('Hi there.\nAll good.\nShe goes home.');
    expect(root.querySelectorAll('p')[2]!.textContent).toBe('She goes home.');
  });

  it('falls back to beforeinput insertReplacementText when execCommand does nothing', async () => {
    (document as any).execCommand = vi.fn(() => false);
    const seen: { type: string; data: string | undefined; selected: string; cancelable: boolean }[] = [];
    root.addEventListener('beforeinput', (e) => {
      const ev = e as InputEvent;
      const data = ev.dataTransfer?.getData('text/plain');
      seen.push({ type: ev.inputType, data, selected: selectedText(), cancelable: ev.cancelable });
      ev.preventDefault();
      editSelection(data ?? '');
    });
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(seen).toEqual([{ type: 'insertReplacementText', data: 'have', selected: 'has', cancelable: true }]);
    expect(root.textContent).toBe('I have a cat');
  });

  it('falls back to a paste event last, re-selecting the range first', async () => {
    delete (document as any).execCommand;
    const pasted: { data: string | undefined; selected: string }[] = [];
    root.addEventListener('beforeinput', () => {
      document.getSelection()!.removeAllRanges(); // an editor that moves the selection and does nothing
    });
    root.addEventListener('paste', (e) => {
      const data = (e as ClipboardEvent).clipboardData?.getData('text/plain');
      pasted.push({ data, selected: selectedText() });
      e.preventDefault();
      editSelection(data ?? '');
    });
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(pasted).toEqual([{ data: 'have', selected: 'has' }]);
    expect(root.textContent).toBe('I have a cat');
  });

  it('returns false when nothing applies the fix, without throwing', async () => {
    (document as any).execCommand = vi.fn(() => true); // claims success, changes nothing
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(false);
    expect(root.textContent).toBe('I has a cat');
  });

  it('a fix that is a prefix of the original is not confirmed by an unchanged text', async () => {
    setHtml('<p>See the the end</p>');
    (document as any).execCommand = vi.fn(() => true);
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(4, 11, 'the')).toBe(false); // "the the" → "the"; the slice alone would match
  });

  it('never stacks a fallback on an edit that changed the text some other way', async () => {
    (document as any).execCommand = vi.fn(() => {
      editSelection('hav'); // the editor mangled it
      return true;
    });
    const fallback = vi.fn();
    root.addEventListener('beforeinput', fallback);
    root.addEventListener('paste', fallback);
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
    expect(root.textContent).toBe('I hav a cat');
  });

  it('waits for an editor that applies the edit asynchronously, and does not apply it twice', async () => {
    delete (document as any).execCommand;
    const paste = vi.fn();
    root.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      const range = document.getSelection()!.getRangeAt(0).cloneRange();
      const data = (e as InputEvent).dataTransfer!.getData('text/plain');
      setTimeout(() => {
        range.deleteContents();
        range.insertNode(document.createTextNode(data));
      }, 10);
    });
    root.addEventListener('paste', paste);
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(paste).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 30));
    expect(root.textContent).toBe('I have a cat');
  });

  it('deletes with an empty replacement', async () => {
    setHtml('<p>See the the end</p>');
    (document as any).execCommand = vi.fn((_c: string, _u: boolean, text: string) => (editSelection(text), true));
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(3, 7, '')).toBe(true);
    expect(root.textContent).toBe('See the end');
  });

  it('returns false when the host is no longer editable or the adapter is disposed', async () => {
    const exec = vi.fn((_c: string, _u: boolean, text: string) => (editSelection(text), true));
    (document as any).execCommand = exec;
    const a = createContentEditableAdapter(root, 'f1');
    root.setAttribute('contenteditable', 'false');
    expect(await a.replace(2, 5, 'have')).toBe(false);
    root.setAttribute('contenteditable', 'true');
    a.dispose();
    expect(await a.replace(2, 5, 'have')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(root.textContent).toBe('I has a cat');
  });

  it('skips execCommand when focus did not land', async () => {
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec;
    vi.spyOn(root, 'focus').mockImplementation(() => {});
    root.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      editSelection((e as InputEvent).dataTransfer!.getData('text/plain'));
    });
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns false instead of throwing on exceptions', async () => {
    vi.spyOn(document, 'getSelection').mockImplementation(() => {
      throw new Error('boom');
    });
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(false);
  });

  it('select sets the selection and focuses the host', async () => {
    setHtml('<p>Hi <b>there</b></p><p>I has a cat</p>');
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const a = createContentEditableAdapter(root, 'f1');
    await a.select(11, 14);
    expect(selectedText()).toBe('has');
    expect(document.activeElement).toBe(root);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('onChange fires once per microtask for input plus mutations, and unsubscribes', async () => {
    const a = createContentEditableAdapter(root, 'f1');
    const cb = vi.fn();
    const off = a.onChange(cb);
    const t = root.querySelector('p')!.firstChild as Text;
    t.data = 'I have a cat';
    t.data = 'I have a cat!';
    root.dispatchEvent(new Event('input', { bubbles: true }));
    await ticks();
    expect(cb).toHaveBeenCalledTimes(1);

    root.querySelector('p')!.append(' More.'); // a mutation alone (an editor re-render)
    await ticks();
    expect(cb).toHaveBeenCalledTimes(2);

    off();
    t.data = 'changed';
    root.dispatchEvent(new Event('input', { bubbles: true }));
    await ticks();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('onLayoutChange says what scrolled: the host, the target of a scroll elsewhere, nothing for a resize', () => {
    const a = createContentEditableAdapter(root, 'f1');
    const cb = vi.fn();
    a.onLayoutChange(cb);
    root.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalledWith(root);
    cb.mockClear();
    const other = document.createElement('div');
    document.body.appendChild(other);
    other.dispatchEvent(new Event('scroll')); // capture on window
    expect(cb.mock.calls).toEqual([[other]]);
    cb.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(cb.mock.calls).toEqual([[]]);
  });

  it('onLayoutChange fires on host scroll, window scroll and resize, and unsubscribes', () => {
    const a = createContentEditableAdapter(root, 'f1');
    const cb = vi.fn();
    const off = a.onLayoutChange(cb);
    root.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    window.dispatchEvent(new Event('resize'));
    document.body.dispatchEvent(new Event('scroll')); // capture on window
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    cb.mockClear();
    root.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('dispose disconnects observers and makes later subscriptions no-ops', async () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
      },
    );
    try {
      const a = createContentEditableAdapter(root, 'f1');
      const cb = vi.fn();
      a.onLayoutChange(cb);
      a.onChange(cb);
      expect(observe).toHaveBeenCalledWith(root);
      a.dispose();
      expect(disconnect).toHaveBeenCalledTimes(1);
      (root.querySelector('p')!.firstChild as Text).data = 'x';
      root.dispatchEvent(new Event('input'));
      window.dispatchEvent(new Event('resize'));
      await ticks();
      expect(cb).not.toHaveBeenCalled();

      const later = vi.fn();
      const offChange = a.onChange(later);
      const offLayout = a.onLayoutChange(later);
      (root.querySelector('p')!.firstChild as Text).data = 'y';
      root.dispatchEvent(new Event('input'));
      window.dispatchEvent(new Event('resize'));
      await ticks();
      expect(later).not.toHaveBeenCalled();
      expect(observe).toHaveBeenCalledTimes(1);
      offChange();
      offLayout();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('isAlive needs a connected, still-editable host', () => {
    const a = createContentEditableAdapter(root, 'f1');
    expect(a.isAlive()).toBe(true);
    root.setAttribute('contenteditable', 'false');
    expect(a.isAlive()).toBe(false);
    root.setAttribute('contenteditable', 'true');
    expect(a.isAlive()).toBe(true);
    root.remove();
    expect(a.isAlive()).toBe(false);
  });

  it('rectsForMany measures each text node of each range, in input order', async () => {
    setHtml('<p>Hi <b>there</b></p><p>Next</p>');
    // Each per-node range reports x = 10 × its text offset and width = 10 × its length.
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const node = this.startContainer as Text;
      const base = node.data === 'there' ? 3 : node.data === 'Next' ? 9 : 0;
      const x = (base + this.startOffset) * 10;
      return [new DOMRect(x, 0, (this.endOffset - this.startOffset) * 10, 16)] as unknown as DOMRectList;
    });
    const a = createContentEditableAdapter(root, 'f1');
    const out = await a.rectsForMany!([
      { start: 9, end: 13 }, // "Next"
      { start: 1, end: 5 }, // "i th": two text nodes, two rects
    ]);
    expect(out.map((rs) => rs.map((r) => [r.x, r.width]))).toEqual([
      [[90, 40]],
      [
        [10, 20],
        [30, 20],
      ],
    ]);
    expect(await a.rectsFor(3, 8)).toHaveLength(1);
    a.dispose();
    expect(await a.rectsForMany!([{ start: 0, end: 1 }])).toEqual([[]]);
    expect(await a.rectsFor(0, 1)).toEqual([]);
  });

  it('rects are clipped to a scrolling host and drop empty ones', async () => {
    root.style.overflowY = 'auto'; // happy-dom doesn't expand the overflow shorthand
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 50));
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 50 });
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      new DOMRect(80, 10, 40, 16), // half outside on the right
      new DOMRect(10, 60, 40, 16), // below the visible box
      new DOMRect(10, 10, 0, 16), // collapsed whitespace
    ] as unknown as DOMRectList);
    const a = createContentEditableAdapter(root, 'f1');
    const [rects] = await a.rectsForMany!([{ start: 2, end: 5 }]);
    expect(rects!.map((r) => [r.x, r.y, r.width, r.height])).toEqual([[80, 10, 20, 16]]);
  });

  it('with a layer anchor, rects are clipped only to the boxes below it (the layer is clipped above)', async () => {
    // Three clipping boxes: root (y 0-200) in a scroller (0-30) in the anchor (0-25).
    const anchor = document.createElement('div');
    const scroller = document.createElement('div');
    document.body.appendChild(anchor);
    anchor.appendChild(scroller);
    scroller.appendChild(root);
    const box = (el: HTMLElement, height: number) => {
      el.style.overflowY = 'auto';
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, height));
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 100 });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
    };
    box(root, 200);
    box(scroller, 30);
    box(anchor, 25);
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      new DOMRect(10, 20, 40, 16), // y 20-36
      new DOMRect(10, 220, 40, 16), // below root's own box: always clipped
    ] as unknown as DOMRectList);
    const a = createContentEditableAdapter(root, 'f1');
    const heights = (rects: DOMRect[]) => rects.map((r) => [r.y, r.height]);
    expect(heights((await a.rectsForMany!([{ start: 2, end: 5 }]))[0]!)).toEqual([[20, 5]]); // fixed layer: every box
    expect(heights(await a.rectsFor(2, 5, { clipUntil: anchor }))).toEqual([[20, 10]]); // root and scroller
    expect(heights((await a.rectsForMany!([{ start: 2, end: 5 }], { clipUntil: scroller }))[0]!)).toEqual([[20, 16]]); // root only
  });

  it('text map is rebuilt only after a mutation', async () => {
    const a = createContentEditableAdapter(root, 'f1');
    builds.mockClear();
    expect(await a.getText()).toBe('I has a cat');
    expect(await a.getText()).toBe('I has a cat');
    await a.rectsForMany!([
      { start: 0, end: 1 },
      { start: 2, end: 5 },
    ]);
    await a.select(2, 5);
    expect(builds).toHaveBeenCalledTimes(1);

    const t = root.querySelector('p')!.firstChild as Text;
    t.data = 'I have a cat'; // read in the same task: still fresh
    expect(await a.getText()).toBe('I have a cat');
    expect(builds).toHaveBeenCalledTimes(2);
    await ticks();
    expect(await a.getText()).toBe('I have a cat');
    expect(builds).toHaveBeenCalledTimes(2);

    root.querySelector('p')!.setAttribute('contenteditable', 'false'); // an attribute the map depends on
    expect(await a.getText()).toBe('');
    expect(builds).toHaveBeenCalledTimes(3);

    root.dispatchEvent(new Event('input', { bubbles: true }));
    await a.getText();
    expect(builds).toHaveBeenCalledTimes(4);
  });

  it('2,000 paragraphs: 20 issues are measured from one cached map, quickly', async () => {
    setHtml(Array.from({ length: 2000 }, (_, i) => `<p>Paragraph ${i} has <b>some</b> words.</p>`).join(''));
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(oneRect);
    const a = createContentEditableAdapter(root, 'f1');
    builds.mockClear();
    const t0 = performance.now();
    const text = await a.getText();
    const ranges = Array.from({ length: 20 }, (_, k) => {
      const at = text.indexOf(`Paragraph ${k * 100} has`);
      return { start: at, end: at + `Paragraph ${k * 100} has some`.length }; // two text nodes each
    });
    const out = await a.rectsForMany!(ranges);
    const again = await a.rectsForMany!(ranges); // the next scroll frame
    const ms = performance.now() - t0;
    expect(builds).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.length)).toEqual(Array(20).fill(2));
    expect(again).toEqual(out);
    // The O(n²) guard is the single build above; this bound only catches a gross slowdown, with room for a busy machine.
    expect(ms).toBeLessThan(3000);
  });

  it('a handled beforeinput is never followed by paste, even when the editor is slow', async () => {
    delete (document as any).execCommand;
    const paste = vi.fn();
    root.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      const range = document.getSelection()!.getRangeAt(0).cloneRange();
      const data = (e as InputEvent).dataTransfer!.getData('text/plain');
      setTimeout(() => {
        range.deleteContents();
        range.insertNode(document.createTextNode(data));
      }, 200);
    });
    root.addEventListener('paste', paste);
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(paste).not.toHaveBeenCalled();
    expect(root.textContent).toBe('I have a cat');
  });

  it('a handled beforeinput that never lands returns false, without a paste', async () => {
    delete (document as any).execCommand;
    const paste = vi.fn();
    root.addEventListener('beforeinput', (e) => e.preventDefault()); // takes it, then drops it
    root.addEventListener('paste', paste);
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    expect(root.textContent).toBe('I has a cat');
  });

  it('a fix ending in a space counts as applied when the editor writes it as NBSP', async () => {
    setHtml('<p>I has cat</p>');
    // Chrome keeps a space before a space-less boundary visible by writing U+00A0.
    (document as any).execCommand = vi.fn((_c: string, _u: boolean, text: string) => (editSelection(text.replace(/ $/, '\u00a0')), true));
    const a = createContentEditableAdapter(root, 'f1');
    expect(await a.replace(2, 6, 'have a ')).toBe(true);
    expect(root.textContent).toBe('I have a\u00a0cat');
    expect(await a.getText()).toBe('I have a cat');
    // A fix that itself carries an NBSP is compared as plain spaces too.
    expect(await a.replace(9, 12, 'big\u00a0cat')).toBe(true);
    expect(await a.getText()).toBe('I have a big cat');
  });

  it('rects after an emoji and an NBSP land on the right text node, in this and a later paragraph', async () => {
    setHtml('<p>😀 Hi\u00a0<i>there</i>, I has 👍🏽 a cat.</p><p>Ok 🎉\u00a0<b>she</b> go\u00a0home.</p>');
    const measured: string[] = [];
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      measured.push((this.startContainer as Text).data.slice(this.startOffset, this.endOffset));
      return oneRect();
    });
    const a = createContentEditableAdapter(root, 'f1');
    const text = await a.getText();
    for (const word of ['has', 'a cat', 'go home']) {
      measured.length = 0;
      const at = text.indexOf(word);
      expect(await a.rectsFor(at, at + word.length), word).toHaveLength(1);
      expect(measured.map(plain), word).toEqual([word]);
    }
  });

  it('caret maps a collapsed selection to its text offset, or null', () => {
    setHtml('<p>Hi <b>there</b></p><p>I has a cat</p>');
    const a = createContentEditableAdapter(root, 'f1');
    const t = root.querySelectorAll('p')[1]!.firstChild as Text;
    const sel = document.getSelection()!;
    sel.collapse(t, 3);
    expect(a.caret!()).toBe(12); // "Hi there\n" is 9
    sel.setBaseAndExtent(t, 2, t, 5);
    expect(a.caret!()).toBeNull();
    sel.collapse(document.body, 0);
    expect(a.caret!()).toBeNull();
  });
});
