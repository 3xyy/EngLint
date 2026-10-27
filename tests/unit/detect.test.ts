import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepActiveElement, editingHost, watchFields } from '../../src/content/detect';

const tick = () => new Promise((r) => setTimeout(r, 0));

function add<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = '';
});

describe('watchFields', () => {
  it('reports a checkable field on every focus, and never inputs or password fields', () => {
    const ta = add('textarea');
    const text = add('input', { type: 'text' });
    const pw = add('input', { type: 'password' });
    const onField = vi.fn();
    stop = watchFields(document, onField, vi.fn());

    text.focus();
    pw.focus();
    expect(onField).not.toHaveBeenCalled();
    ta.focus();
    text.focus();
    ta.focus();
    expect(onField.mock.calls).toEqual([[ta], [ta]]);
  });

  it('reports a field that already has focus when watching starts', () => {
    const ta = add('textarea');
    ta.focus();
    const onField = vi.fn();
    stop = watchFields(document, onField, vi.fn());
    expect(onField).toHaveBeenCalledWith(ta);
  });

  it('finds a field focused inside an open shadow root', () => {
    const host = add('div');
    const ta = document.createElement('textarea');
    host.attachShadow({ mode: 'open' }).appendChild(ta);
    const onField = vi.fn();
    stop = watchFields(document, onField, vi.fn());
    // What Chrome delivers to a document listener: target retargeted to the host, the real field first in the path.
    const e = new FocusEvent('focusin', { bubbles: true, composed: true });
    Object.defineProperty(e, 'composedPath', { value: () => [ta, host, document.body, document] });
    host.dispatchEvent(e);
    expect(onField).toHaveBeenCalledWith(ta);
    expect(onField).not.toHaveBeenCalledWith(host);

    ta.focus();
    expect(deepActiveElement(document)).toBe(ta);
  });

  it.each(['englint-overlay', 'englint-field-layer'])(
    "never reports a box inside EngLint's own UI (%s), even in an open root (the e2e build), nor walks into it",
    (tag) => {
      const host = document.createElement(tag);
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
      const box = document.createElement('textarea'); // a checkable field anywhere else
      root.appendChild(box);
      box.focus();
      const onField = vi.fn();
      stop = watchFields(document, onField, vi.fn()); // the start-up check of the focused element
      const e = new FocusEvent('focusin', { bubbles: true, composed: true });
      Object.defineProperty(e, 'composedPath', { value: () => [box, root, host, document.body, document] });
      host.dispatchEvent(e);
      expect(onField).not.toHaveBeenCalled();
      expect(deepActiveElement(document)).toBe(host); // the same as the production build's closed root gives
    },
  );

  it("focus moving into EngLint's own UI never reports the page's editing host, even on an editable page", () => {
    const html = document.documentElement;
    html.setAttribute('contenteditable', 'true'); // the whole page is an editor
    const host = document.createElement('englint-overlay');
    html.appendChild(host); // where the overlay goes: under <html>
    const button = document.createElement('button');
    host.attachShadow({ mode: 'closed' }).appendChild(button);
    try {
      button.focus(); // focus in the popover when watching starts
      expect(document.activeElement).toBe(host);
      const onField = vi.fn();
      stop = watchFields(document, onField, vi.fn());
      // A closed root: the page's listeners see only the host.
      const e = new FocusEvent('focusin', { bubbles: true, composed: true });
      Object.defineProperty(e, 'composedPath', { value: () => [host, html, document] });
      host.dispatchEvent(e);
      expect(onField).not.toHaveBeenCalled();
    } finally {
      html.removeAttribute('contenteditable');
      host.remove();
    }
  });

  it('calls onGone once when a reported field leaves the document', async () => {
    const ta = add('textarea');
    const other = add('textarea');
    const onGone = vi.fn();
    stop = watchFields(document, vi.fn(), onGone);
    ta.focus();
    ta.remove();
    other.remove(); // never focused, never reported
    await tick();
    expect(onGone.mock.calls).toEqual([[ta]]);
    document.body.appendChild(document.createElement('p'));
    await tick();
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('stops watching', async () => {
    const ta = add('textarea');
    const onField = vi.fn();
    const onGone = vi.fn();
    stop = watchFields(document, onField, onGone);
    ta.focus();
    stop();
    ta.blur();
    ta.focus();
    ta.remove();
    await tick();
    expect(onField).toHaveBeenCalledTimes(1);
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe('editingHost', () => {
  it('is the outermost editable element, stopping at a non-editable island', () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true"><p id="p">a <b id="b">b</b></p>' +
      '<div contenteditable="false"><div id="inner" contenteditable="true"><i id="i">c</i></div></div></div>' +
      '<textarea id="ta"></textarea><p id="plain">x</p>';
    const $ = (id: string) => document.getElementById(id)!;
    expect(editingHost($('b'))).toBe($('host'));
    expect(editingHost($('p'))).toBe($('host'));
    expect(editingHost($('host'))).toBe($('host'));
    expect(editingHost($('i'))).toBe($('inner')); // its parent is not editable: a host of its own
    expect(editingHost($('ta'))).toBe($('ta'));
    expect(editingHost($('plain'))).toBe($('plain'));
  });
});

describe('watchFields with contenteditable', () => {
  it('reports the editing host when focus lands on an element inside it', () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true"><p>Hi <span id="chip" tabindex="-1">there</span></p></div>';
    const host = document.getElementById('host')!;
    const onField = vi.fn();
    stop = watchFields(document, onField, vi.fn());
    document.getElementById('chip')!.focus();
    host.focus();
    expect(onField.mock.calls).toEqual([[host], [host]]);
  });

  it('calls onGone with the host when the host leaves', async () => {
    document.body.innerHTML = '<div id="host" contenteditable="true"><p><span id="chip" tabindex="-1">x</span></p></div>';
    const host = document.getElementById('host')!;
    const onGone = vi.fn();
    stop = watchFields(document, vi.fn(), onGone);
    document.getElementById('chip')!.focus();
    host.remove();
    await tick();
    expect(onGone.mock.calls).toEqual([[host]]);
  });
});
