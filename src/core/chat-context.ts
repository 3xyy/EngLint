import { splitParagraphs } from './paragraphs';

/** The most document text the chat sends (characters). */
export const CHAT_CONTEXT_MAX = 12_000;

const GAP = '…';
const SEP = '\n';
/** The longest first sentence kept for a paragraph that isn't sent whole. */
const BRIEF_MAX = 200;
/** The share of the budget kept for the first sentences of the other paragraphs. */
const BRIEF_SHARE = 1 / 3;

/** A paragraph's first sentence (at most BRIEF_MAX characters), with "…" when the rest is left out. */
function briefOf(text: string): string {
  const t = text.trim();
  const m = /^[\s\S]*?[.!?][)"'”’\]]*(?=\s|$)/.exec(t);
  let first = (m ? m[0] : t).trim();
  if (first.length > BRIEF_MAX) {
    const cut = first.slice(0, BRIEF_MAX);
    const space = cut.lastIndexOf(' ');
    first = space > BRIEF_MAX / 2 ? cut.slice(0, space) : cut;
  }
  return first.length < t.length ? `${first} ${GAP}` : first;
}

/** The paragraph index that holds `at`: the one it falls in, else the next one, else the last. */
function indexAt(paras: { start: number; text: string }[], at: number): number {
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!;
    if (at <= p.start + p.text.length) return i;
  }
  return paras.length - 1;
}

/**
 * At most `max` characters around `at` in one paragraph: "…" where the paragraph was cut, or a "…" line where
 * only the paragraphs before or after it were left out.
 */
function windowAround(text: string, at: number, max: number, moreBefore: boolean, moreAfter: boolean): string {
  const room = max - 2 * (GAP.length + SEP.length);
  const from = Math.max(0, Math.min(at - Math.floor(room / 2), text.length - room));
  const to = Math.min(text.length, from + room);
  const head = from > 0 ? GAP : moreBefore ? GAP + SEP : '';
  const tail = to < text.length ? GAP : moreAfter ? SEP + GAP : '';
  return `${head}${text.slice(from, to)}${tail}`;
}

/**
 * The document text for the chat, at most `max` characters. A text that fits is sent whole. Otherwise: the
 * paragraph(s) holding the focus (the caret or selection; the start of the text when null) whole, then
 * neighbouring paragraphs whole, alternately after and before, then the first sentence of each paragraph
 * further out. Everything stays in document order, and "…" marks text that was left out.
 */
export function chatContext(text: string, focus: { start: number; end: number } | null, max = CHAT_CONTEXT_MAX): string {
  if (text.length <= max) return text;
  const paras = splitParagraphs(text);
  if (paras.length === 0) return '';
  const n = paras.length;
  const at = Math.min(Math.max(focus?.start ?? 0, 0), text.length);
  let L = indexAt(paras, at);
  let R = L;
  // The "…" lines for the paragraphs left out at either end count toward the cap too.
  const cost = (l: number, r: number, k: number) => k + (l > 0 ? GAP.length + SEP.length : 0) + (r < n - 1 ? GAP.length + SEP.length : 0);
  // A selection over several paragraphs sends them all, when they fit.
  if (focus && focus.end > focus.start) {
    const end = indexAt(paras, Math.min(focus.end, text.length));
    const span = paras.slice(L, end + 1).reduce((s, p) => s + p.text.length, 0) + (end - L) * SEP.length;
    if (cost(L, end, span) <= max) R = end;
  }
  const pieces = new Map<number, string>();
  let kept = 0; // the length of the pieces in L..R, separators between them included
  for (let i = L; i <= R; i++) {
    pieces.set(i, paras[i]!.text);
    kept += paras[i]!.text.length + (i > L ? SEP.length : 0);
  }
  const first = paras[L]!;
  if (cost(L, R, kept) > max) return windowAround(first.text, at - first.start, max, L > 0, R < n - 1);

  const briefs = paras.map((p) => briefOf(p.text));
  let briefTotal = 0;
  for (let i = 0; i < n; i++) if (i < L || i > R) briefTotal += briefs[i]!.length + SEP.length;
  const reserve = Math.min(briefTotal, Math.floor(max * BRIEF_SHARE));

  /** Grows the window by one paragraph on a side, using `piece`, while the total stays within `budget`. */
  const grow = (budget: number, piece: (i: number) => string) => {
    let open = { after: true, before: true };
    let after = true;
    while (open.after || open.before) {
      const side = (after && open.after) || !open.before ? 'after' : 'before';
      after = !after;
      const i = side === 'after' ? R + 1 : L - 1;
      if (i < 0 || i >= n) {
        open = { ...open, [side]: false };
        continue;
      }
      const p = piece(i);
      const k = kept + p.length + SEP.length;
      const fits = side === 'after' ? cost(L, i, k) <= budget : cost(i, R, k) <= budget;
      if (!fits) {
        open = { ...open, [side]: false };
        continue;
      }
      pieces.set(i, p);
      kept = k;
      if (side === 'after') R = i;
      else L = i;
    }
  };
  grow(max - reserve, (i) => paras[i]!.text);
  grow(max, (i) => briefs[i]!);

  const out: string[] = [];
  if (L > 0) out.push(GAP);
  for (let i = L; i <= R; i++) out.push(pieces.get(i)!);
  if (R < n - 1) out.push(GAP);
  return out.join(SEP);
}
