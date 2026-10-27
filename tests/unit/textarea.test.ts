import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTextareaAdapter } from '../../src/content/adapters/textarea';

let ta: HTMLTextAreaElement;

beforeEach(() => {
  ta = document.createElement('textarea');
  ta.value = 'I has a cat';
  document.body.appendChild(ta);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (document as any).execCommand;
});

describe('textarea adapter', () => {
  it('reads the text', async () => {
    const a = createTextareaAdapter(ta, 'f1');
    expect(await a.getText()).toBe('I has a cat');
    expect(a.fieldId).toBe('f1');
    expect(a.element).toBe(ta);
  });

  it('does not claim every change reaches onChange: a script can set the value with no input event', () => {
    expect(createTextareaAdapter(ta, 'f1').reportsEveryChange).toBeFalsy();
  });

  it('fallback path sets value and fires input', async () => {
    delete (document as any).execCommand;
    const a = createTextareaAdapter(ta, 'f1');
    const events: InputEvent[] = [];
    ta.addEventListener('input', (e) => events.push(e as InputEvent));
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(ta.value).toBe('I have a cat');
    expect(events).toHaveLength(1);
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.inputType).toBe('insertReplacementText');
  });

  it('falls back when execCommand returns false', async () => {
    (document as any).execCommand = vi.fn(() => false);
    const a = createTextareaAdapter(ta, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(ta.value).toBe('I have a cat');
  });

  it('falls back when execCommand throws', async () => {
    (document as any).execCommand = vi.fn(() => {
      throw new Error('nope');
    });
    const a = createTextareaAdapter(ta, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(ta.value).toBe('I have a cat');
  });

  it('prefers execCommand insertText and does not touch the value itself', async () => {
    const exec = vi.fn((cmd: string, _ui: boolean, text: string) => {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      return true;
    });
    (document as any).execCommand = exec;
    const a = createTextareaAdapter(ta, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(exec).toHaveBeenCalledWith('insertText', false, 'have');
    expect(ta.value).toBe('I have a cat');
  });

  it('replace returns false when value is reverted', async () => {
    delete (document as any).execCommand;
    const a = createTextareaAdapter(ta, 'f1');
    // simulate a React controlled input resetting the value on input
    ta.addEventListener('input', () => {
      ta.value = 'I has a cat';
    });
    expect(await a.replace(2, 5, 'have')).toBe(false);
  });

  it('replace returns false instead of throwing on exceptions', async () => {
    const a = createTextareaAdapter(ta, 'f1');
    vi.spyOn(ta, 'setSelectionRange').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await a.replace(2, 5, 'have')).toBe(false);
  });

  it('onChange fires on input and unsubscribes', () => {
    const a = createTextareaAdapter(ta, 'f1');
    const cb = vi.fn();
    const off = a.onChange(cb);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('onLayoutChange says what scrolled: the textarea, the target of a scroll elsewhere, nothing for a resize', () => {
    const a = createTextareaAdapter(ta, 'f1');
    const cb = vi.fn();
    a.onLayoutChange(cb);
    ta.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalledWith(ta);
    cb.mockClear();
    document.body.dispatchEvent(new Event('scroll')); // capture on window
    expect(cb.mock.calls).toEqual([[document.body]]);
    cb.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(cb.mock.calls).toEqual([[]]);
  });

  it('onLayoutChange fires on textarea scroll, window resize and unsubscribes', () => {
    const a = createTextareaAdapter(ta, 'f1');
    const cb = vi.fn();
    const off = a.onLayoutChange(cb);
    ta.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    cb.mockClear();
    ta.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('caret is the collapsed selection offset, or null for a selection', () => {
    const a = createTextareaAdapter(ta, 'f1');
    ta.setSelectionRange(4, 4);
    expect(a.caret!()).toBe(4);
    ta.setSelectionRange(2, 5);
    expect(a.caret!()).toBeNull();
  });

  it('select sets the selection', async () => {
    const a = createTextareaAdapter(ta, 'f1');
    await a.select(2, 5);
    expect(ta.selectionStart).toBe(2);
    expect(ta.selectionEnd).toBe(5);
  });

  it('isAlive follows connection; dispose removes listeners', () => {
    const a = createTextareaAdapter(ta, 'f1');
    expect(a.isAlive()).toBe(true);
    const cb = vi.fn();
    a.onChange(cb);
    a.dispose();
    ta.dispatchEvent(new Event('input'));
    expect(cb).not.toHaveBeenCalled();
    ta.remove();
    expect(a.isAlive()).toBe(false);
  });

  it('readonly returns false without changing value', async () => {
    ta.readOnly = true;
    const a = createTextareaAdapter(ta, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(false);
    expect(ta.value).toBe('I has a cat');
  });

  it('disabled returns false without changing value', async () => {
    ta.disabled = true;
    const a = createTextareaAdapter(ta, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(false);
    expect(ta.value).toBe('I has a cat');
  });

  it('skips execCommand when focus did not land', async () => {
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec;
    vi.spyOn(ta, 'focus').mockImplementation(() => {});
    const a = createTextareaAdapter(ta, 'f1');
    expect(await a.replace(2, 5, 'have')).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(ta.value).toBe('I have a cat');
  });

  it('window scroll capture listener fires for scrolls on other elements', () => {
    const a = createTextareaAdapter(ta, 'f1');
    const cb = vi.fn();
    a.onLayoutChange(cb);
    document.body.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('dispose disconnects the ResizeObserver and stops layout callbacks', () => {
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
      const a = createTextareaAdapter(ta, 'f1');
      const cb = vi.fn();
      a.onLayoutChange(cb);
      expect(observe).toHaveBeenCalledWith(ta);
      a.dispose();
      expect(disconnect).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event('resize'));
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('subscriptions after dispose are no-ops', () => {
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect() {}
      },
    );
    try {
      const a = createTextareaAdapter(ta, 'f1');
      a.dispose();
      const cb = vi.fn();
      const offChange = a.onChange(cb);
      const offLayout = a.onLayoutChange(cb);
      ta.dispatchEvent(new Event('input'));
      window.dispatchEvent(new Event('resize'));
      expect(cb).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      offChange();
      offLayout();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rectsFor after dispose leaves no mirror in the document', async () => {
    const a = createTextareaAdapter(ta, 'f1');
    await a.rectsFor(0, 1);
    const before = document.documentElement.childElementCount;
    a.dispose();
    expect(document.documentElement.childElementCount).toBe(before - 1);
    expect(await a.rectsFor(0, 1)).toEqual([]);
    expect(document.documentElement.childElementCount).toBe(before - 1);
  });

  it('mirror is not reachable from document.body.querySelectorAll(div)', async () => {
    const a = createTextareaAdapter(ta, 'f1');
    let seen = -1;
    const orig = HTMLSpanElement.prototype.getClientRects;
    vi.spyOn(HTMLSpanElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLSpanElement) {
      seen = document.documentElement.querySelectorAll('span').length;
      return orig.call(this);
    });
    await a.rectsFor(0, 1);
    expect(seen).toBe(0); // the measured span is inside the shadow root, not the light DOM
    expect(document.body.querySelectorAll('div').length).toBe(0);
  });

  it('rectsForMany returns one entry per range and builds the mirror once', async () => {
    ta.value = 'I has a cat'; // 'I' 0-1, 'has' 2-5, 'a' 6-7, 'cat' 8-11
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 100));
    Object.defineProperty(ta, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(ta, 'clientHeight', { configurable: true, value: 100 });
    // Each measured span reports a rect at x = 10 × where it really sits in the mirror's text, so a span
    // placed at the wrong offset (e.g. overlapping ranges squeezed into one pass) shows up in the results.
    vi.spyOn(HTMLSpanElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLSpanElement) {
      let offset = 0;
      for (let n = this.previousSibling; n; n = n.previousSibling) offset += n.textContent?.length ?? 0;
      return [new DOMRect(offset * 10, 10, 5, 16)] as unknown as DOMRectList;
    });
    const styles = vi.spyOn(window, 'getComputedStyle');
    const a = createTextareaAdapter(ta, 'f1');

    // Unsorted and overlapping ranges still come back in input order.
    const out = await a.rectsForMany!([
      { start: 8, end: 11 },
      { start: 0, end: 1 },
      { start: 2, end: 5 },
      { start: 3, end: 7 },
    ]);
    expect(out.map((rs) => rs.map((r) => r.x))).toEqual([[80], [0], [20], [30]]);
    expect(styles.mock.calls.filter(([el]) => el === ta)).toHaveLength(1);

    expect(await a.rectsForMany!([])).toEqual([]);
    a.dispose();
    expect(await a.rectsForMany!([{ start: 0, end: 1 }])).toEqual([[]]);
  });

  it('mirror holds no text after rectsFor resolves', async () => {
    const a = createTextareaAdapter(ta, 'f1');
    let captured: ShadowRoot | undefined;
    const orig = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
      captured = orig.call(this, { ...init, mode: 'open' });
      return captured;
    });
    await a.rectsFor(0, 1);
    expect(captured).toBeDefined();
    expect(captured!.textContent).toBe('');
  });
});
