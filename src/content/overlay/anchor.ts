// Where a field's underline layer goes. The layer sits inside the page's scrolled content, so the browser scrolls the underlines with the text in the same frame and no scroll
// needs a re-measure. Fields with no usable place keep the page-wide fixed layer (the fallback).

/** A computed overflow value that clips: the element is a scroll container (or clips like one). */
const clipsValue = (v: string) => /\b(auto|scroll|hidden|clip)\b/.test(v);
/** Either axis clips. The shorthand is read too: some environments (happy-dom) don't expand it. */
const clips = (cs: CSSStyleDeclaration) => clipsValue(cs.overflowX) || clipsValue(cs.overflowY) || clipsValue(cs.overflow);
const positioned = (cs: CSSStyleDeclaration) => cs.position !== '' && cs.position !== 'static';
const FLEX_OR_GRID = /^(inline-)?(flex|grid)$/;
const set = (v: string) => v !== '' && v !== 'none';
/** A transform (or zoom) scales or moves local coordinates: they'd need un-scaling, so these fall back. */
const transformed = (cs: CSSStyleDeclaration) =>
  set(cs.transform) || set(cs.translate) || set(cs.rotate) || set(cs.scale) || (cs.zoom !== '' && cs.zoom !== '1' && cs.zoom !== 'normal');

type OpenOrClosed = (el: HTMLElement) => ShadowRoot | null;
/** Chrome's content-script API that sees closed shadow roots too (absent outside an extension). */
const openOrClosed = (): OpenOrClosed | undefined =>
  (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: OpenOrClosed } } }).chrome?.dom?.openOrClosedShadowRoot;

/** A closed shadow root, through chrome.dom: null when there is none, or no such API (or it throws). */
function closedRootOf(el: Element): ShadowRoot | null {
  try {
    return openOrClosed()?.(el as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

/** `el`'s shadow root, open or (where Chrome lets us see it) closed. */
function shadowRootOf(el: Element): ShadowRoot | null {
  return el.shadowRoot ?? closedRootOf(el);
}

/** The slot of a closed shadow root that `el` (a light-DOM child of its host) is assigned to. */
function closedSlotOf(el: Element): HTMLSlotElement | null {
  const host = el.parentElement;
  const root = host && !host.shadowRoot ? closedRootOf(host) : null;
  if (!root) return null;
  return Array.from(root.querySelectorAll('slot')).find((slot) => slot.assignedNodes().includes(el)) ?? null;
}

/**
 * The element `el` is rendered inside: its slot when it is slotted into a shadow tree (closed ones too,
 * through chrome.dom), its parent, or the host of the shadow root it sits in.
 */
export function composedParent(el: Element): Element | null {
  const slot = (el as HTMLElement).assignedSlot ?? closedSlotOf(el);
  if (slot) return slot;
  if (el.parentElement) return el.parentElement;
  const parent = el.parentNode;
  return parent instanceof ShadowRoot ? parent.host : null;
}

/**
 * Whether `el` scrolls (or clips) its content. `html` never does: its overflow belongs to the viewport.
 * Neither does `body` unless `html` sets an overflow of its own; otherwise body's moves to the viewport too.
 */
function scrollsContent(el: Element, cs: CSSStyleDeclaration, style: (el: Element) => CSSStyleDeclaration): boolean {
  const doc = el.ownerDocument;
  if (el === doc.documentElement || !clips(cs)) return false;
  return el !== doc.body || clips(style(doc.documentElement));
}

/**
 * The element a field's underline layer is anchored in, or null for the fixed-layer fallback.
 *
 * Walks up from the field's parent (never the field: its content is the user's, and a textarea can't have
 * children), across shadow roots, to the nearest scroll container (or the document). The anchor is the
 * nearest positioned element on that walk, the scroll container included; with none, a scroll container
 * means fallback and the document means the document (`documentElement`). Docs passes `scrollRoot`, its
 * editor scroller, which is the field itself: it is the anchor if positioned. A transform on the anchor or
 * any ancestor means fallback, and so does an anchor in an editor's content (editable, or inside an
 * editing host): our element would become part of what that editor edits.
 */
export function findLayerAnchor(field: Element, scrollRoot?: Element | null): Element | null {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  const style = (el: Element) => view.getComputedStyle(el);

  let anchor: Element | null = null;
  if (scrollRoot) {
    if (positioned(style(scrollRoot))) anchor = scrollRoot;
  } else {
    for (let el = composedParent(field); ; el = composedParent(el)) {
      if (!el || el === doc.documentElement) {
        anchor = doc.documentElement; // the document: scrolls with the page
        break;
      }
      const cs = style(el);
      if (cs.display === 'contents') continue; // no box: neither positions nor scrolls anything
      if (positioned(cs)) {
        anchor = el;
        break;
      }
      if (scrollsContent(el, cs, style)) break; // a scroller with nothing positioned up to it
    }
  }
  if (!anchor) return null;
  for (let el: Element | null = anchor; el; el = composedParent(el)) {
    if (transformed(style(el)) || (el as HTMLElement).isContentEditable) return null;
  }
  return anchor;
}

/**
 * Where the layer element goes for `anchor`: the anchor's shadow root when it has one (open, or closed and
 * seen through chrome.dom), so it is never slotted into a page component; otherwise the anchor itself.
 * Without chrome.dom, a closed root is still found when the field sits inside it.
 */
export function layerParent(anchor: Element, field: Element): Element | ShadowRoot {
  const own = shadowRootOf(anchor);
  if (own) return own;
  for (let root = field.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    if (root.host === anchor) return root; // a closed root, known from the field's side
  }
  return anchor;
}

/**
 * Whether scrolling `scrolled` can move `el`: it is the document, `el` or one of its ancestors. For a layer's
 * anchor, such a scroll moves the layer along with its text (no re-measure); for a field, it can move the
 * field's text.
 */
export function scrollMoves(scrolled: EventTarget, el: Element): boolean {
  if (scrolled === el.ownerDocument) return true; // the page scrolled
  if (!(scrolled instanceof Element)) return false;
  for (let at: Element | null = el; at; at = composedParent(at)) {
    if (at === scrolled) return true;
  }
  return false;
}

/**
 * Whether a scroll of `scrolled` can move the text of `field`: the page, the field or a box around it
 * (scrollMoves), or a scroller inside the field (a code block, a wide table).
 */
export const scrollMovesText = (scrolled: EventTarget, field: Element) =>
  scrollMoves(scrolled, field) || (scrolled instanceof Node && field.contains(scrolled));

/**
 * `el`'s z-index when it stacks with it: a numeric z-index on a positioned element, or on a flex or grid
 * item (its parent's display is flex or grid), which stacks with it too; null otherwise.
 */
function zIndexOf(el: Element, style: (el: Element) => CSSStyleDeclaration): number | null {
  const cs = style(el);
  if (!/^-?\d+$/.test(cs.zIndex)) return null;
  if (positioned(cs)) return Number(cs.zIndex);
  const parent = composedParent(el);
  return parent && FLEX_OR_GRID.test(style(parent).display) ? Number(cs.zIndex) : null;
}

/**
 * The stacking level `el` paints at inside `anchor`: walking from `el` (inclusive) up to `anchor`
 * (exclusive), the z-index of the outermost element that stacks with one (see zIndexOf). Null (auto) when
 * none does; undefined when `el` isn't inside `anchor`.
 */
function stackLevel(el: Element, anchor: Element): number | null | undefined {
  const view = anchor.ownerDocument.defaultView;
  if (!view) return undefined;
  const style = (e: Element) => view.getComputedStyle(e);
  let level: number | null = null;
  for (let at: Element | null = el; at; at = composedParent(at)) {
    if (at === anchor) return level;
    level = zIndexOf(at, style) ?? level;
  }
  return undefined; // the anchor wasn't on the way up
}

/**
 * The z-index the field layer needs to paint above the text, whose paint element (the field, or Docs' tile
 * container) may sit in a stacking level of its own inside the anchor: the outermost one from `paint` up to
 * the anchor (stackLevel). Null (auto) when there is none, or when `paint` isn't inside the anchor.
 * - Over a field: one above that level. +1 even though the layer is the anchor's last child: the page may
 *   append siblings.
 * - `sameLevel` (Docs, the layer right after the tile branch): that level itself. The later tree order puts
 *   the layer over the pages, and Docs' own UI above that level (its floating button at 23, inside the
 *   tile branch; the caret's container at 41) stays over the layer.
 */
export function layerZIndex(paint: Element, anchor: Element, sameLevel = false): number | null {
  const level = stackLevel(paint, anchor);
  if (level === null || level === undefined) return null;
  return sameLevel ? level : level + 1;
}

/**
 * When the text paints in a branch of its own inside the layer's parent (Docs: the editor's first child,
 * holding its tile container), that branch: the layer goes right after it, at the text's own level
 * (layerZIndex `sameLevel`), so it paints over the text and under the page's UI that comes after the
 * branch at or above that level (Docs' caret container at 41). Null when `paint` isn't under `parent`.
 */
export function layerAfter(parent: Element | ShadowRoot, paint: Element): Node | null {
  for (let node: Node | null = paint; node && node !== parent; node = node.parentNode) {
    if (node.parentNode === parent) return node;
  }
  return null;
}

const INTERACTIVE = 'button, a, [role="button"], input';

/**
 * Whether `top`, the element on top at a point (elementFromPoint), shows the field's own text there, so a
 * hover there counts. It must be the text's surface or inside it: the field, or the part of it the text
 * paints in (Docs: the tile manager, the editor's hit region), not other UI the page keeps in the field.
 * Not an interactive element on the way up to the field (a button, a link, a [role=button], an input),
 * unless it is the user's own editable text (a link in a contenteditable). And not painted over the field
 * layer (`layer`, at z-index `z` inside `anchor`; null is auto, level 0): stacked above that level, or at
 * it and after the layer in tree order. The field's own text comes before the layer (it goes after the
 * text's branch, or last), so a tie there is under the layer: Docs' tiles at 22 with the layer at 22.
 */
export function showsText(
  top: Element | null,
  /** `surface`: the field, or the part of it the text paints in. */
  at: { field: Element; surface: Element; anchor: Element; z: number | null; layer: Element },
): boolean {
  if (!top || !(top === at.surface || at.surface.contains(top))) return false;
  for (let el: Element | null = top; el && el !== at.field; el = el.parentElement) {
    if (el.matches(INTERACTIVE) && !(el as HTMLElement).isContentEditable) return false;
  }
  const level = stackLevel(top, at.anchor);
  if (level === null || level === undefined) return true;
  const ours = at.z ?? 0;
  const after = (at.layer.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  return level < ours || (level === ours && !after);
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The viewport box where `anchor`'s content can be seen: the viewport, cut by the client box of the anchor
 * (when it scrolls or clips) and of each scrolling ancestor. For `documentElement`, the viewport.
 */
export function visibleBox(anchor: Element): Box {
  const view = anchor.ownerDocument.defaultView;
  const box: Box = { left: 0, top: 0, right: view?.innerWidth ?? Infinity, bottom: view?.innerHeight ?? Infinity };
  if (!view) return box;
  const style = (el: Element) => view.getComputedStyle(el);
  for (let el: Element | null = anchor; el; el = composedParent(el)) {
    const cs = style(el);
    if (cs.display === 'contents' || !scrollsContent(el, cs, style)) continue;
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft;
    const top = r.top + el.clientTop;
    box.left = Math.max(box.left, left);
    box.top = Math.max(box.top, top);
    box.right = Math.min(box.right, left + el.clientWidth);
    box.bottom = Math.min(box.bottom, top + el.clientHeight);
  }
  return box;
}

/** The index of the first rect with some area inside `box`, or -1. */
export function firstVisible(rects: DOMRect[], box: Box): number {
  return rects.findIndex((r) => r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom);
}

/** The box around every one of `rects` (each line of a selection); null for none. */
export function boxAround(rects: readonly DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}
