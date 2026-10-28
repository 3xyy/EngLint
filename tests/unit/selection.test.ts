import { afterEach, describe, expect, it } from 'vitest';
import { createContentEditableAdapter } from '../../src/content/adapters/contenteditable';
import { createTextareaAdapter } from '../../src/content/adapters/textarea';
import type { EditorAdapter } from '../../src/content/adapters/types';
import { MAX_SELECTION_CHARS, readFieldSelection, readPageSelection } from '../../src/content/tools/selection';

afterEach(() => {
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

function textarea(value: string, start: number, end: number): EditorAdapter {
  const ta = document.createElement('textarea');
  ta.value = value;
  document.body.appendChild(ta);
  ta.setSelectionRange(start, end);
  return createTextareaAdapter(ta, 'f1');
}

function editable(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.setAttribute('contenteditable', 'true');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function select(a: Node, ao: number, b: Node, bo: number): void {
  const range = document.createRange();
  range.setStart(a, ao);
  range.setEnd(b, bo);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('readFieldSelection', () => {
  it('trims edge whitespace off a textarea selection', async () => {
    const a = textarea('a big dog', 1, 6); // " big "
    expect(await readFieldSelection(a)).toEqual({ start: 2, end: 5, text: 'big' });
  });

  it('snaps a selection inside a word to the whole word: "roble" in "problems" is "problems"', async () => {
    expect(await readFieldSelection(textarea('Our problems are big.', 5, 10))).toEqual({ start: 4, end: 12, text: 'problems' });
    expect(await readFieldSelection(textarea('I has a cat', 3, 9))).toEqual({ start: 2, end: 11, text: 'has a cat' });
  });

  it('is null for a collapsed selection', async () => {
    expect(await readFieldSelection(textarea('a big dog', 3, 3))).toBeNull();
  });

  it('is null when only whitespace is selected', async () => {
    expect(await readFieldSelection(textarea('a  b', 1, 3))).toBeNull();
  });

  it('flags a selection above the limit and keeps its range', async () => {
    const long = 'x'.repeat(MAX_SELECTION_CHARS + 1);
    const got = await readFieldSelection(textarea(long, 0, long.length));
    expect(got).toMatchObject({ start: 0, end: MAX_SELECTION_CHARS + 1, tooLong: true });
  });

  it('does not flag a selection of exactly the limit', async () => {
    const text = 'x'.repeat(MAX_SELECTION_CHARS);
    const got = await readFieldSelection(textarea(text, 0, text.length));
    expect(got).not.toBeNull();
    expect(got!.tooLong).toBeUndefined();
  });

  it('is null for an adapter without selection()', async () => {
    const a = textarea('a big dog', 2, 5);
    delete (a as { selection?: unknown }).selection;
    expect(await readFieldSelection(a)).toBeNull();
  });

  it('reads an async selection (Google Docs) and clamps it to the text', async () => {
    const a = {
      getText: async () => 'hello world',
      selection: async () => ({ start: 6, end: 40 }),
    } as unknown as EditorAdapter;
    expect(await readFieldSelection(a)).toEqual({ start: 6, end: 11, text: 'world' });
  });
});

describe('textarea selection()', () => {
  it('is the raw range, or null when collapsed', () => {
    expect(textarea('a big dog', 1, 6).selection!()).toEqual({ start: 1, end: 6 });
    expect(textarea('a big dog', 4, 4).selection!()).toBeNull();
  });
});

describe('contenteditable selection()', () => {
  it('maps a selection that crosses a <b> boundary', async () => {
    const root = editable('<p>I has <b>a big</b> cat</p>');
    const p = root.firstChild!;
    // from "has" in the first text node to "big" inside <b>
    select(p.firstChild!, 2, p.childNodes[1]!.firstChild!, 5);
    const a = createContentEditableAdapter(root, 'c1');
    expect(await a.getText()).toBe('I has a big cat');
    expect(await readFieldSelection(a)).toEqual({ start: 2, end: 11, text: 'has a big' });
  });

  it('is null when collapsed', () => {
    const root = editable('<p>I has a cat</p>');
    select(root.firstChild!.firstChild!, 3, root.firstChild!.firstChild!, 3);
    expect(createContentEditableAdapter(root, 'c1').selection!()).toBeNull();
  });

  it('is null when the selection is outside the field', () => {
    const root = editable('<p>I has a cat</p>');
    const other = document.createElement('p');
    other.textContent = 'elsewhere';
    document.body.appendChild(other);
    select(other.firstChild!, 0, other.firstChild!, 5);
    expect(createContentEditableAdapter(root, 'c1').selection!()).toBeNull();
  });

  it('is null when the selection starts inside the field and ends outside it', () => {
    const root = editable('<p>I has a cat</p>');
    const other = document.createElement('p');
    other.textContent = 'elsewhere';
    document.body.appendChild(other);
    select(root.firstChild!.firstChild!, 2, other.firstChild!, 4);
    expect(createContentEditableAdapter(root, 'c1').selection!()).toBeNull();
  });
});

describe('readPageSelection (the side panel gets what no field holds)', () => {
  it("the page's selected text", () => {
    const p = document.createElement('p');
    p.textContent = 'Nothing to see here.';
    document.body.append(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    document.getSelection()!.addRange(range);
    expect(readPageSelection(document)).toBe('Nothing to see here.');
  });

  it("'' with nothing selected", () => {
    expect(readPageSelection(document)).toBe('');
  });
});
