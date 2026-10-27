import type { Paragraph } from './types';

/** cyrb53 string hash, returned as lowercase hex. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Split on \r\n, \n or lone \r. Blank lines (whitespace or zero-width spaces only) are skipped; offsets are UTF-16 indices. */
export function splitParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  const lineBreak = /\r\n|\n|\r/g;
  let start = 0;
  const push = (end: number) => {
    const line = text.slice(start, end);
    if (line.replace(/\u200b/g, '').trim() !== '') { // trim() already drops U+FEFF; editors park the caret in U+200B
      out.push({ id: `p${out.length}`, text: line, start, hash: hashText(line) });
    }
  };
  let m: RegExpExecArray | null;
  while ((m = lineBreak.exec(text)) !== null) {
    push(m.index);
    start = m.index + m[0].length;
  }
  push(text.length);
  return out;
}
