// Where the in-field badge goes: pure maths over boxes the caller measured. The caller reads the page (the
// field's visible box, the caret's line, what covers a point); nothing here touches the DOM.

/** How far the badge moves left each time something else covers its spot, px. */
export const BADGE_SHIFT = 28;
/** Moves left at most this many times. */
const MAX_SHIFTS = 3;

export interface BadgePlacement {
  /** The badge's top-left corner in the viewport. */
  x: number;
  y: number;
  /** Not shown: the field can't hold it, every spot is covered, or the caret's line overlaps it. */
  hidden: boolean;
}

const overlaps = (a: DOMRect, left: number, top: number, size: number) =>
  a.left < left + size && a.right > left && a.top < top + size && a.bottom > top;

/**
 * The badge's spot in `field` (the field's visible box, viewport px): its bottom-right corner, `inset` px in.
 * A field shorter than the badge plus two insets gets it centred vertically. While `blocked` says something
 * else is on top at the spot's centre (another extension's badge, page UI), it moves left BADGE_SHIFT px, at
 * most MAX_SHIFTS times and never out of the field; it hides when every spot is covered. It also hides while
 * `caret` (the caret's line box) overlaps it, so it never covers what is being typed.
 */
export function badgePosition(
  field: DOMRect,
  opts: { inset: number; size: 20; blocked: (x: number, y: number) => boolean; caret: DOMRect | null },
): BadgePlacement {
  const { inset, size, blocked, caret } = opts;
  const finite = [field.x, field.y, field.width, field.height].every(Number.isFinite);
  const fits = finite && field.width >= size + 2 * inset && field.height >= size;
  const y = field.height >= size + 2 * inset ? field.bottom - inset - size : field.top + (field.height - size) / 2;
  let x = field.right - inset - size;
  if (!fits) return { x, y, hidden: true };
  for (let shifts = 0; blocked(x + size / 2, y + size / 2); shifts++) {
    const next = x - BADGE_SHIFT;
    if (shifts === MAX_SHIFTS || next < field.left + inset) return { x, y, hidden: true };
    x = next;
  }
  return { x, y, hidden: !!caret && overlaps(caret, x, y, size) };
}
