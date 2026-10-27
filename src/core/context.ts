import { splitParagraphs } from './paragraphs';

/** Sound like me: the most characters of the writer's other paragraphs sent as a voice sample. */
export const MAX_VOICE_SAMPLE_CHARS = 1_500;

const BREAK = /[\r\n]/;
const SPACE = /\s/;

/** The character at i, or '' outside the string. */
const at = (text: string, i: number) => text[i] ?? '';

function paragraphBounds(text: string, start: number, end: number): { lo: number; hi: number } {
  let lo = start;
  while (lo > 0 && !BREAK.test(at(text, lo - 1))) lo--;
  let hi = end;
  while (hi < text.length && !BREAK.test(at(text, hi))) hi++;
  return { lo, hi };
}

/** Shrink [start, end) past edge whitespace; null if only whitespace is left. */
export function trimRange(text: string, start: number, end: number): { start: number; end: number } | null {
  let s = start;
  let e = end;
  while (s < e && SPACE.test(at(text, s))) s++;
  while (e > s && SPACE.test(at(text, e - 1))) e--;
  return s < e ? { start: s, end: e } : null;
}

/** Up to `max` characters each side of the range, inside its paragraph, cut at a word boundary. */
export function contextAround(text: string, start: number, end: number, max = 300): { before: string; after: string } {
  const { lo, hi } = paragraphBounds(text, start, end);
  let before = text.slice(Math.max(lo, start - max), start);
  if (start - max > lo && before !== '' && !SPACE.test(at(text, start - max - 1)) && !SPACE.test(at(before, 0))) {
    const ws = before.search(/\s/);
    before = ws === -1 ? '' : before.slice(ws + 1);
  }
  let after = text.slice(end, Math.min(hi, end + max));
  if (end + max < hi && after !== '' && !SPACE.test(at(text, end + max)) && !SPACE.test(at(after, after.length - 1))) {
    let i = after.length - 1;
    while (i >= 0 && !SPACE.test(at(after, i))) i--;
    after = after.slice(0, Math.max(i, 0));
  }
  return { before, after };
}

/** The sentence(s) touching [start, end), within the paragraph. A boundary is [.!?]+ then optional closing quotes then whitespace. */
export function sentenceAround(text: string, start: number, end: number): { start: number; end: number } {
  const { lo, hi } = paragraphBounds(text, start, end);
  const segments: { start: number; end: number }[] = [];
  const skipSpace = (i: number) => {
    while (i < hi && SPACE.test(at(text, i))) i++;
    return i;
  };
  const terminator = /[.!?]+["'”’)\]]*(?=\s)/g;
  const para = text.slice(lo, hi);
  let segStart = skipSpace(lo);
  let m: RegExpExecArray | null;
  while ((m = terminator.exec(para)) !== null) {
    const segEnd = lo + m.index + m[0].length;
    if (segEnd > segStart) segments.push({ start: segStart, end: segEnd });
    segStart = skipSpace(segEnd);
  }
  let tail = hi;
  while (tail > segStart && SPACE.test(at(text, tail - 1))) tail--;
  if (tail > segStart) segments.push({ start: segStart, end: tail });
  const fallback = segments[segments.length - 1];
  if (!fallback) return { start, end };
  const lastEnd = Math.max(end, start + 1);
  const first = segments.find((s) => s.end > start) ?? fallback;
  const last = [...segments].reverse().find((s) => s.start < lastEnd) ?? first;
  return { start: first.start, end: Math.max(first.end, last.end) };
}

/** `text` cut to at most `room` characters at a word boundary ('' when not even one word fits). */
function cutAtWord(text: string, room: number): string {
  if (room <= 0) return '';
  if (text.length <= room) return text;
  const head = text.slice(0, room);
  if (SPACE.test(at(text, room))) return head.trimEnd();
  const lastSpace = head.search(/\s\S*$/);
  return lastSpace === -1 ? '' : head.slice(0, lastSpace).trimEnd();
}

/**
 * Sound like me's voice sample: the field's other paragraphs, never one the selection [start, end) touches, the
 * preceding ones nearest first, then the following ones, joined by blank lines, at most `max` characters. The
 * paragraph that doesn't fit is cut at a word and ends it. '' when the field has no other paragraph.
 */
export function voiceSampleAround(text: string, start: number, end: number, max = MAX_VOICE_SAMPLE_CHARS): string {
  const paragraphs = splitParagraphs(text);
  const before = paragraphs.filter((p) => p.start + p.text.length <= start).reverse();
  const after = paragraphs.filter((p) => p.start >= end);
  let out = '';
  for (const p of [...before, ...after]) {
    const sep = out === '' ? '' : '\n\n';
    const room = max - out.length - sep.length;
    const piece = p.text.trim();
    if (piece.length <= room) {
      out += sep + piece;
      continue;
    }
    const cut = cutAtWord(piece, room);
    if (cut !== '') out += sep + cut;
    break;
  }
  return out;
}
