/** One Text node of the map and the half-open span [start, end) its characters occupy in `text`. */
export interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

export interface DomPoint {
  node: Text;
  offset: number;
}

export interface TextMap {
  /**
   * Plain text: Text node data in document order, with '\n' for block boundaries and <br>, and NBSP as
   * a plain space (Chrome writes U+00A0 for trailing and doubled spaces; the model writes ' '). Every
   * character is still one UTF-16 unit of a node, so offsets are 1:1 with the DOM.
   */
  text: string;
  /** Text nodes in document order (empty ones left out), with their spans in `text`. Node data is raw. */
  segments: readonly TextSegment[];
  /** The segments overlapping [start, end), in order. */
  segmentsIn(start: number, end: number): TextSegment[];
  /**
   * The Text node holding the character at `offset`. An offset on a synthetic '\n' maps to the end
   * of the text before it; the end of the text maps to the end of the last node. `'before'` affinity
   * (for range ends) prefers the end of the previous node where two text nodes touch.
   * Throws a RangeError when the host has no text at all.
   */
  toDom(offset: number, affinity?: 'after' | 'before'): DomPoint;
  /** Text offset of a DOM boundary point inside the host, or null for a point outside it. */
  toOffset(node: Node, offset: number): number | null;
}

const BLOCKS = new Set([
  'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
  'ul', 'ol', 'tr', 'td', 'th', 'caption', 'table', 'section', 'article', 'header', 'footer',
  'dl', 'dt', 'dd', 'figure', 'figcaption', 'hr', 'main', 'nav', 'aside', 'details', 'summary',
]);
const SKIPPED_TAGS = new Set(['script', 'style']);

/** NBSP as a plain space; one unit for one unit, so offsets don't move. */
export function plainSpaces(s: string): string {
  return s.replace(/\u00a0/g, ' ');
}

/** First index whose segment passes `pred`, for a predicate that is false, then true, in document order. */
function firstIndex(segments: readonly TextSegment[], pred: (s: TextSegment) => boolean): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(segments[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Not the user's text: non-editable islands (mentions, widgets), scripts, styles, placeholders. */
function isSkipped(el: Element): boolean {
  return (
    SKIPPED_TAGS.has(el.localName) ||
    el.getAttribute('contenteditable')?.trim().toLowerCase() === 'false' ||
    el.hasAttribute('data-placeholder')
  );
}

export function buildTextMap(root: Element): TextMap {
  const segments: TextSegment[] = [];
  const byNode = new Map<Text, TextSegment>();
  let text = '';
  let pending = 0; // newlines owed before the next text; never leading, and dropped if nothing follows

  const boundary = () => {
    if (text.length > 0) pending = Math.max(pending, 1);
  };

  const walk = (parent: Node) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const node = child as Text;
        if (node.data.length === 0) continue;
        if (pending > 0) text += '\n'.repeat(pending);
        pending = 0;
        const seg = { node, start: text.length, end: text.length + node.data.length };
        segments.push(seg);
        byNode.set(node, seg);
        text += plainSpaces(node.data);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.localName === 'br') {
          if (text.length > 0) pending++;
          continue;
        }
        const block = BLOCKS.has(el.localName);
        if (block) boundary();
        if (!isSkipped(el)) walk(el);
        if (block) boundary();
      }
    }
  };
  walk(root); // the host itself is never skipped (Quill keeps data-placeholder on its root)

  // Segments are sorted by offset and by document order: every lookup below is a binary search.
  const toDom = (offset: number, affinity: 'after' | 'before' = 'after'): DomPoint => {
    if (segments.length === 0) throw new RangeError('no text in this host');
    const at = Math.max(0, Math.min(offset, text.length));
    if (affinity === 'before') {
      const ending = segments[firstIndex(segments, (s) => s.start >= at) - 1];
      if (ending && at <= ending.end) return { node: ending.node, offset: at - ending.start };
    }
    // The last segment starting at or before `at`: it holds the character, or `at` is a synthetic
    // newline (or the very end) right after it, which maps to its end.
    const seg = segments[firstIndex(segments, (s) => s.start > at) - 1] ?? segments[0]!;
    return { node: seg.node, offset: Math.min(Math.max(at - seg.start, 0), seg.end - seg.start) };
  };

  const toOffset = (node: Node, offset: number): number | null => {
    const own = byNode.get(node as Text);
    if (own) return own.start + Math.max(0, Math.min(offset, own.end - own.start));
    if (node !== root && !root.contains(node)) return null;
    // A point between nodes: the first text at or after it, or the end of the text.
    const child = node.nodeType === Node.ELEMENT_NODE ? (node.childNodes[offset] ?? null) : node;
    const i = child
      ? firstIndex(segments, (s) => child.contains(s.node) || follows(child, s.node))
      : firstIndex(segments, (s) => !node.contains(s.node) && follows(node, s.node));
    return segments[i]?.start ?? text.length;
  };

  const segmentsIn = (start: number, end: number): TextSegment[] => {
    const out: TextSegment[] = [];
    for (let i = firstIndex(segments, (s) => s.end > start); i < segments.length && segments[i]!.start < end; i++) {
      out.push(segments[i]!);
    }
    return out;
  };

  return { text, segments, segmentsIn, toDom, toOffset };
}
