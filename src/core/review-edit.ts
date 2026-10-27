import type { Edit } from './chat-format';
import { locateEdit } from './chat-format';

/** How far, in characters, the window may grow on each side of the issue. */
const MAX_GROW = 120;

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** Where the word before `i` starts (skipping the whitespace before `i` first). */
function wordLeft(text: string, i: number): number {
  let j = i;
  while (j > 0 && isSpace(text[j - 1])) j--;
  while (j > 0 && !isSpace(text[j - 1])) j--;
  return j;
}

/** Where the word after `i` ends (skipping the whitespace after `i` first). */
function wordRight(text: string, i: number): number {
  let j = i;
  while (j < text.length && isSpace(text[j])) j++;
  while (j < text.length && !isSpace(text[j])) j++;
  return j;
}

/**
 * The smallest edit that applyEdit can place: `text[start, end)` replaced by `replacement`, widened a word at a
 * time (left, then right, alternately, at most 120 characters each side) until the widened original occurs in
 * `text` exactly once. The replacement carries the same prefix and suffix, so the change itself is the same.
 * Null when no window is unique.
 */
export function uniqueEdit(text: string, start: number, end: number, replacement: string): Edit | null {
  if (!(start >= 0 && start < end && end <= text.length)) return null;
  let s = start;
  let e = end;
  let growLeft = true;
  let leftOpen = true;
  let rightOpen = true;
  for (;;) {
    const at = locateEdit(text, text.slice(s, e));
    if (typeof at === 'object') {
      return { original: text.slice(s, e), replacement: text.slice(s, start) + replacement + text.slice(end, e) };
    }
    if (!leftOpen && !rightOpen) return null;
    if (growLeft && leftOpen) {
      const next = wordLeft(text, s);
      if (next === s || start - next > MAX_GROW) leftOpen = false;
      else s = next;
    } else if (!growLeft && rightOpen) {
      const next = wordRight(text, e);
      if (next === e || next - end > MAX_GROW) rightOpen = false;
      else e = next;
    }
    growLeft = !growLeft;
  }
}
