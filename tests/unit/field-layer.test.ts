import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFieldLayer, placeFieldLayer, setLayerZ } from '../../src/content/overlay/field-layer';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const rects = (n: number) => Array.from({ length: n }, () => new DOMRect(0, 0, 0, 0)) as unknown as DOMRectList;

describe('placeFieldLayer', () => {
  it('appends the layer as the last child, and again after the page removed it', () => {
    const anchor = document.createElement('div');
    anchor.append(document.createElement('p'));
    document.body.append(anchor);
    const layer = createFieldLayer('');
    vi.spyOn(layer.host, 'getClientRects').mockReturnValue(rects(1));
    expect(placeFieldLayer(layer, anchor, anchor)).toBe('ok');
    expect(anchor.lastElementChild).toBe(layer.host);
    layer.host.remove();
    expect(placeFieldLayer(layer, anchor, anchor)).toBe('ok');
    expect(layer.host.parentNode).toBe(anchor);
  });

  it('right after `after` (Docs: the tile branch), so later UI at the same z-index paints over it; kept and put back there', () => {
    const anchor = document.createElement('div');
    const [branch, fab, late, between] = Array.from({ length: 4 }, () => document.createElement('div'));
    anchor.append(branch!, fab!);
    document.body.append(anchor);
    const layer = createFieldLayer('');
    vi.spyOn(layer.host, 'getClientRects').mockReturnValue(rects(1));
    const order = () => Array.from(anchor.children);
    expect(placeFieldLayer(layer, anchor, anchor, branch)).toBe('ok');
    expect(order()).toEqual([branch, layer.host, fab]);
    anchor.append(late!); // the page adds more UI: the layer stays where it is
    placeFieldLayer(layer, anchor, anchor, branch);
    expect(order()).toEqual([branch, layer.host, fab, late]);
    layer.host.remove(); // the page took it out: it comes back in the same place, not at the end
    placeFieldLayer(layer, anchor, anchor, branch);
    expect(order()).toEqual([branch, layer.host, fab, late]);
    branch!.after(between!); // something lands between the branch and the layer: it goes back right after the branch
    placeFieldLayer(layer, anchor, anchor, branch);
    expect(order()).toEqual([branch, layer.host, between, fab, late]);
  });

  it('an `after` that is no longer a child of the parent (moved elsewhere): the last child, as without one', () => {
    const anchor = document.createElement('div');
    anchor.append(document.createElement('p'));
    const elsewhere = document.createElement('section');
    const moved = document.createElement('div');
    elsewhere.append(moved, document.createElement('p'));
    document.body.append(anchor, elsewhere);
    const layer = createFieldLayer('');
    vi.spyOn(layer.host, 'getClientRects').mockReturnValue(rects(1));
    expect(placeFieldLayer(layer, anchor, anchor, moved)).toBe('ok');
    expect(anchor.lastElementChild).toBe(layer.host);
    expect(elsewhere.contains(layer.host)).toBe(false);
  });

  it("'unrendered' only when the anchor is rendered and the layer isn't (no slot for it); 'hidden' while the anchor isn't", () => {
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const layer = createFieldLayer('');
    vi.spyOn(layer.host, 'getClientRects').mockReturnValue(rects(0));
    const anchorRects = vi.spyOn(anchor, 'getClientRects').mockReturnValue(rects(1));
    expect(placeFieldLayer(layer, anchor, anchor)).toBe('unrendered');
    anchorRects.mockReturnValue(rects(0)); // e.g. Docs' editor in a hidden container: a transient state
    expect(placeFieldLayer(layer, anchor, anchor)).toBe('hidden');
  });
});

describe('setLayerZ', () => {
  it('a :host z-index rule after the reset (so it wins), or none for auto', () => {
    const layer = createFieldLayer('.x {}');
    setLayerZ(layer, 23);
    const css = () => Array.from(layer.root.getRootNode().childNodes).map((n) => n.textContent ?? '').join('\n');
    expect(css()).toMatch(/:host \{ z-index: 23 !important; \}\s*$/);
    expect(css().indexOf('all: initial')).toBeLessThan(css().indexOf('z-index: 23'));
    setLayerZ(layer, null);
    expect(css()).not.toMatch(/z-index: \d/);
  });
});
