import { describe, expect, it, vi } from 'vitest';
import { BADGE_SHIFT, badgePosition } from '../../src/content/badge-placement';

type Probe = (x: number, y: number) => boolean;

// A field's visible box: left 100, top 50, 300 × 120 (right 400, bottom 170).
const FIELD = new DOMRect(100, 50, 300, 120);
const free: Probe = () => false;
const covered: Probe = () => true;
const place = (caret: DOMRect | null, blocked: Probe = free) => badgePosition(FIELD, { inset: 6, size: 20, blocked, caret });

describe('badgePosition', () => {
  it('sits in the bottom-right corner, 6 px in, and probes its own centre', () => {
    const blocked = vi.fn(free);
    expect(badgePosition(FIELD, { inset: 6, size: 20, blocked, caret: null })).toEqual({ x: 374, y: 144, hidden: false });
    expect(blocked.mock.calls).toEqual([[384, 154]]);
  });

  it('takes the inset it is given (12 px in the Docs editor)', () => {
    expect(badgePosition(FIELD, { inset: 12, size: 20, blocked: free, caret: null })).toEqual({ x: 368, y: 138, hidden: false });
  });

  it('moves left 28 px while something else covers its spot', () => {
    expect(BADGE_SHIFT).toBe(28);
    const blocked = vi.fn<Probe>((x) => x === 384);
    expect(place(null, blocked)).toEqual({ x: 346, y: 144, hidden: false });
    expect(blocked.mock.calls).toEqual([
      [384, 154],
      [356, 154],
    ]);
    expect(place(null, (x) => x === 384 || x === 356)).toEqual({ x: 318, y: 144, hidden: false });
  });

  it('moves at most 3 times, and hides when the fourth spot is covered too', () => {
    expect(place(null, (x) => x > 300)).toEqual({ x: 290, y: 144, hidden: false });
    const always = vi.fn<Probe>(covered);
    expect(place(null, always)).toMatchObject({ x: 290, hidden: true });
    expect(always.mock.calls.map(([x]) => x)).toEqual([384, 356, 328, 300]);
  });

  it('never moves out of the field: a narrow field hides once its last spot inside is covered', () => {
    const narrow = new DOMRect(0, 0, 60, 40); // spots at x 34, then 6; the next (-22) would leave it
    const always = vi.fn<Probe>(covered);
    expect(badgePosition(narrow, { inset: 6, size: 20, blocked: always, caret: null })).toMatchObject({ hidden: true });
    expect(always.mock.calls.map(([x]) => x)).toEqual([44, 16]);
    expect(badgePosition(narrow, { inset: 6, size: 20, blocked: (x) => x === 44, caret: null })).toEqual({ x: 6, y: 14, hidden: false });
  });

  it('hides while the caret box overlaps the badge box', () => {
    expect(place(new DOMRect(100, 150, 300, 20))).toEqual({ x: 374, y: 144, hidden: true }); // the caret's line crosses it
    expect(place(new DOMRect(100, 130, 300, 20)).hidden).toBe(true); // reaches 6 px into it from above
    expect(place(new DOMRect(380, 150, 2, 20)).hidden).toBe(true); // a caret-wide box under it
  });

  it('shows while the caret box only touches it or misses it, and with no caret', () => {
    expect(place(new DOMRect(100, 124, 300, 20)).hidden).toBe(false); // ends at 144, where the badge starts
    expect(place(new DOMRect(100, 164, 300, 20)).hidden).toBe(false); // starts at 164, where the badge ends
    expect(place(new DOMRect(100, 60, 300, 20)).hidden).toBe(false); // the first line
    expect(place(null).hidden).toBe(false);
    // The caret overlaps only the corner spot, and the badge moved left of it.
    expect(place(new DOMRect(380, 150, 2, 20), (x) => x === 384)).toEqual({ x: 346, y: 144, hidden: false });
  });

  it('a field too small to hold it hides it; a short field centres it vertically', () => {
    const fit = (field: DOMRect) => badgePosition(field, { inset: 6, size: 20, blocked: free, caret: null });
    expect(fit(new DOMRect(0, 0, 31, 100)).hidden).toBe(true); // narrower than 20 + 2 × 6
    expect(fit(new DOMRect(0, 0, 200, 19)).hidden).toBe(true); // shorter than the badge
    expect(fit(new DOMRect(0, 10, 200, 24))).toEqual({ x: 174, y: 12, hidden: false }); // 2 px above and below
    expect(fit(new DOMRect(0, 0, 0, 0)).hidden).toBe(true);
    expect(fit(new DOMRect(Number.NaN, 0, 200, 100)).hidden).toBe(true);
  });
});
