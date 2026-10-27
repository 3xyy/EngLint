import { describe, expect, it } from 'vitest';
import { DRAW_MS, DrawIns, shift, toLocal, toViewport } from '../../src/content/overlay/field-views';
import type { OverlayItem } from '../../src/content/overlay/Underlines';
import type { LocatedIssue } from '../../src/core/types';

const issue = (id: string) => ({ id }) as LocatedIssue;
const rect = (x: number, y: number, w = 30, h = 20) => new DOMRect(x, y, w, h);
const item = (id: string, rects: DOMRect[]): OverlayItem => ({ issue: issue(id), rects });
const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

describe('coordinate conversion', () => {
  it("toLocal: each viewport rect minus the layer's origin; sizes and issues are kept", () => {
    const has = issue('has');
    const local = toLocal([{ issue: has, rects: [rect(150, 230), rect(40, 254, 60, 24)] }], { x: 41, y: 160.5 });
    expect(local).toHaveLength(1);
    expect(local[0]!.issue).toBe(has);
    expect(local[0]!.rects.map(box)).toEqual([
      { x: 109, y: 69.5, width: 30, height: 20 },
      { x: -1, y: 93.5, width: 60, height: 24 },
    ]);
  });

  it("toViewport undoes toLocal at the same origin, and follows the layer's origin when it moves (a scroll)", () => {
    const rects = [rect(150, 230), rect(12.25, -40)];
    const origin = { x: 41, y: 160.5 };
    const local = toLocal([item('a', rects)], origin)[0]!.rects;
    expect(toViewport(local, origin).map(box)).toEqual(rects.map(box));
    // The page scrolled its content 30px up: the layer's origin moved with it, and so do the rects.
    expect(toViewport(local, { x: 41, y: 130.5 }).map(box)).toEqual(rects.map((r) => box(shift(r, 0, -30))));
  });
});

describe('DrawIns: the draw-in plays once per issue in a field', () => {
  it('an issue drawn for the first time draws in for DRAW_MS from that render, and not after', () => {
    const d = new DrawIns();
    expect(d.update('f', [item('a', [rect(0, 0)])], 1000)).toEqual(new Set(['a']));
    // A re-render (a resize, a scroll, an edit elsewhere) within DRAW_MS: still the first draw-in, not a new one.
    expect(d.update('f', [item('a', [rect(0, 5)])], 1000 + DRAW_MS - 1)).toEqual(new Set(['a']));
    expect(d.update('f', [item('a', [rect(0, 5)])], 1000 + DRAW_MS)).toEqual(new Set());
    expect(d.update('f', [item('a', [rect(0, 5)])], 9000)).toEqual(new Set());
  });

  it('an issue with no rects yet is not shown: it draws in when its rects first come', () => {
    const d = new DrawIns();
    expect(d.update('f', [item('a', [])], 1000)).toEqual(new Set());
    expect(d.update('f', [item('a', [rect(0, 0)])], 5000)).toEqual(new Set(['a']));
  });

  it("a repaint that drops an issue's rects and adds them back does not replay it (it stayed a current issue)", () => {
    const d = new DrawIns();
    d.update('f', [item('a', [rect(0, 0)])], 1000);
    expect(d.update('f', [item('a', [])], 2000)).toEqual(new Set()); // scrolled out of the painted tiles
    expect(d.update('f', [item('a', [rect(0, 0)])], 3000)).toEqual(new Set()); // painted again
  });

  it('pruned to the current issues: one that left (fixed, or edited away) and comes back draws in again', () => {
    const d = new DrawIns();
    d.update('f', [item('a', [rect(0, 0)]), item('b', [rect(40, 0)])], 1000);
    expect(d.update('f', [item('b', [rect(40, 0)])], 2000)).toEqual(new Set()); // "a" left
    expect(d.update('f', [item('a', [rect(0, 0)]), item('b', [rect(40, 0)])], 3000)).toEqual(new Set(['a']));
    d.update('f', [], 4000); // the field cleared (detach): nothing is remembered
    expect(d.update('f', [item('b', [rect(40, 0)])], 5000)).toEqual(new Set(['b']));
  });

  it('fields are kept apart: the same issue id in another field is a first showing there', () => {
    const d = new DrawIns();
    d.update('f', [item('a', [rect(0, 0)])], 1000);
    expect(d.update('g', [item('a', [rect(0, 0)])], 5000)).toEqual(new Set(['a']));
    expect(d.update('f', [item('a', [rect(0, 0)])], 5000)).toEqual(new Set());
  });

  it('still: those of a drawing set still within DRAW_MS of their first showing (the timed class removal)', () => {
    const d = new DrawIns();
    d.update('f', [item('a', [rect(0, 0)])], 1000);
    d.update('f', [item('a', [rect(0, 0)]), item('b', [rect(40, 0)])], 1100);
    const drawing = new Set(['a', 'b']);
    expect(d.still('f', drawing, 1000 + DRAW_MS - 1)).toEqual(new Set(['a', 'b']));
    expect(d.still('f', drawing, 1000 + DRAW_MS + 5)).toEqual(new Set(['b']));
    expect(d.still('f', drawing, 1100 + DRAW_MS + 5)).toEqual(new Set());
    expect(d.still('other', drawing, 1001)).toEqual(new Set()); // nothing shown there
  });
});
