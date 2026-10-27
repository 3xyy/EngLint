import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findLayerAnchor,
  firstVisible,
  layerAfter,
  layerParent,
  layerZIndex,
  scrollMoves,
  showsText,
  visibleBox,
} from '../../src/content/overlay/anchor';

// happy-dom doesn't expand the overflow shorthand: fixtures set overflow-x/overflow-y.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
});

function html(markup: string): void {
  document.body.innerHTML = markup;
}
const $ = (id: string) => document.getElementById(id)!;

describe('findLayerAnchor', () => {
  it('a positioned scroller is the anchor', () => {
    html('<div id="s" style="position: relative; overflow-y: auto"><p><textarea id="f"></textarea></p></div>');
    expect(findLayerAnchor($('f'))).toBe($('s'));
  });

  it('a positioned wrapper inside a static scroller is the anchor', () => {
    html('<div id="s" style="overflow-y: scroll"><div id="w" style="position: relative"><div><textarea id="f"></textarea></div></div></div>');
    expect(findLayerAnchor($('f'))).toBe($('w'));
  });

  it('the nearest positioned element wins over one further up', () => {
    html('<div style="position: relative"><div id="w" style="position: absolute"><textarea id="f"></textarea></div></div>');
    expect(findLayerAnchor($('f'))).toBe($('w'));
  });

  it('a static scroller with nothing positioned below it: null, the fixed-layer fallback', () => {
    html('<div style="position: relative"><div style="overflow-y: auto"><div><textarea id="f"></textarea></div></div></div>');
    expect(findLayerAnchor($('f'))).toBeNull();
  });

  it('hidden and clip count as scroll containers too', () => {
    for (const value of ['hidden', 'clip', 'scroll']) {
      html(`<div style="position: relative"><div style="overflow-x: ${value}"><textarea id="f"></textarea></div></div>`);
      expect(findLayerAnchor($('f')), value).toBeNull();
    }
  });

  it('nothing positioned and no scroller up to the document: the document', () => {
    html('<main><div><textarea id="f"></textarea></div></main>');
    expect(findLayerAnchor($('f'))).toBe(document.documentElement);
  });

  it('a fixed-position widget is the anchor', () => {
    html('<div id="w" style="position: fixed; bottom: 0"><div><textarea id="f"></textarea></div></div>');
    expect(findLayerAnchor($('f'))).toBe($('w'));
  });

  it('a positioned body is the anchor', () => {
    document.body.style.position = 'relative';
    html('<div><textarea id="f"></textarea></div>');
    expect(findLayerAnchor($('f'))).toBe(document.body);
  });

  it('a transform on the anchor or any of its ancestors: null', () => {
    html('<div style="transform: scale(2)"><div id="s" style="position: relative; overflow-y: auto"><textarea id="f"></textarea></div></div>');
    expect(findLayerAnchor($('f'))).toBeNull();
    html('<div id="s" style="position: relative; transform: translateX(4px)"><textarea id="f"></textarea></div>');
    expect(findLayerAnchor($('f'))).toBeNull();
    html('<div id="s" style="position: relative; translate: 4px"><textarea id="f"></textarea></div>');
    expect(findLayerAnchor($('f'))).toBeNull();
    // The document anchor: a transformed <html> falls back too.
    html('<div><textarea id="f"></textarea></div>');
    document.documentElement.style.transform = 'scale(1.5)';
    expect(findLayerAnchor($('f'))).toBeNull();
  });

  it('a transform between the field and the anchor is fine (it moves with the text)', () => {
    html('<div id="s" style="position: relative; overflow-y: auto"><div style="transform: scale(2)"><textarea id="f"></textarea></div></div>');
    expect(findLayerAnchor($('f'))).toBe($('s'));
  });

  it('crosses shadow roots to their hosts, open or closed', () => {
    for (const mode of ['open', 'closed'] as const) {
      html('<div id="s" style="position: relative; overflow-y: auto"><div id="host"></div></div>');
      const shadow = $('host').attachShadow({ mode });
      shadow.innerHTML = '<div><textarea></textarea></div>';
      expect(findLayerAnchor(shadow.querySelector('textarea')!), mode).toBe($('s'));
    }
  });

  it('a positioned element inside a shadow root is found before the host', () => {
    html('<div id="host" style="position: relative"></div>');
    const shadow = $('host').attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<div id="inner" style="position: relative"><textarea></textarea></div>';
    expect(findLayerAnchor(shadow.querySelector('textarea')!)).toBe(shadow.getElementById('inner'));
  });

  it('a slotted field is followed through its slot into the shadow tree', () => {
    html('<div id="host"><textarea id="f"></textarea></div>');
    const shadow = $('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="scroller" style="position: relative; overflow-y: auto"><slot></slot></div>';
    // happy-dom has no slot assignment: give the field the slot Chrome would.
    Object.defineProperty($('f'), 'assignedSlot', { value: shadow.querySelector('slot') });
    expect(findLayerAnchor($('f'))).toBe(shadow.getElementById('scroller'));
  });

  it('never the field itself, even when it is positioned and scrolls', () => {
    html('<div><textarea id="f" style="position: relative; overflow-y: auto"></textarea></div>');
    expect(findLayerAnchor($('f'))).toBe(document.documentElement);
    html('<div id="w" style="position: relative"><div id="f" contenteditable="true" style="position: absolute; overflow-y: auto"></div></div>');
    expect(findLayerAnchor($('f'))).toBe($('w'));
  });

  it('display: contents ancestors have no box: skipped', () => {
    html('<div id="s" style="position: relative; overflow-y: auto"><div style="display: contents; position: relative; overflow-y: hidden"><textarea id="f"></textarea></div></div>');
    expect(findLayerAnchor($('f'))).toBe($('s'));
  });

  it("body's overflow belongs to the viewport unless html sets its own", () => {
    html('<div><textarea id="f"></textarea></div>');
    document.body.style.overflowY = 'auto';
    expect(findLayerAnchor($('f'))).toBe(document.documentElement); // the page scrolls: the document anchor
    document.documentElement.style.overflowY = 'hidden'; // now body itself scrolls
    expect(findLayerAnchor($('f'))).toBeNull();
    document.body.style.position = 'relative';
    expect(findLayerAnchor($('f'))).toBe(document.body);
  });

  it("never an anchor inside an editor's content: an editable anchor or one inside an editing host falls back", () => {
    html('<div contenteditable="true" style="position: relative"><p>Text <textarea id="f"></textarea></p></div>');
    expect(findLayerAnchor($('f'))).toBeNull();
    html('<div contenteditable="true"><div id="island" contenteditable="false" style="position: relative"><textarea id="f"></textarea></div></div>');
    expect(findLayerAnchor($('f'))).toBeNull();
    // A contenteditable field itself: its ancestors aren't editable, so they anchor as usual.
    html('<div id="w" style="position: relative"><div id="f" contenteditable="true"><p>Text</p></div></div>');
    expect(findLayerAnchor($('f'))).toBe($('w'));
  });

  it('a field slotted through a closed shadow root is followed into it (chrome.dom finds the root)', () => {
    html('<div id="host" style="position: relative"><textarea id="f"></textarea></div>');
    const closed = $('host').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<div id="scroller" style="overflow-y: auto"><slot></slot></div>';
    const slot = closed.querySelector('slot')!;
    // happy-dom has no slot assignment: the slot reports the field as Chrome would.
    vi.spyOn(slot, 'assignedNodes').mockReturnValue([$('f')]);
    // Without chrome.dom the closed root is invisible: the walk goes straight to the host.
    expect(findLayerAnchor($('f'))).toBe($('host'));
    vi.stubGlobal('chrome', { dom: { openOrClosedShadowRoot: (el: Element) => (el === $('host') ? closed : null) } });
    expect(findLayerAnchor($('f'))).toBeNull(); // through the slot: a static scroller inside the component
    (closed.getElementById('scroller') as HTMLElement).style.overflowY = 'visible';
    expect(findLayerAnchor($('f'))).toBe($('host'));
  });

  it('a scroll root (Docs: the field is the scroller) is the anchor when positioned and untransformed', () => {
    html('<div id="wrap"><div id="editor" style="position: relative; overflow-y: auto"><div id="tiles"></div></div></div>');
    expect(findLayerAnchor($('editor'), $('editor'))).toBe($('editor'));
    $('editor').style.position = 'static';
    expect(findLayerAnchor($('editor'), $('editor'))).toBeNull();
    $('editor').style.position = 'absolute';
    $('wrap').style.transform = 'scale(0.5)';
    expect(findLayerAnchor($('editor'), $('editor'))).toBeNull();
  });
});

describe('layerParent', () => {
  it('the anchor itself in the light DOM', () => {
    html('<div id="s" style="position: relative"><textarea id="f"></textarea></div>');
    expect(layerParent($('s'), $('f'))).toBe($('s'));
    expect(layerParent(document.documentElement, $('f'))).toBe(document.documentElement);
  });

  it("the anchor's shadow root when the field sits in it (closed) or is slotted through it (open)", () => {
    html('<div id="host" style="position: relative"></div><div id="open" style="position: relative"><textarea id="slotted"></textarea></div>');
    const closed = $('host').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<div><textarea></textarea></div>';
    expect(layerParent($('host'), closed.querySelector('textarea')!)).toBe(closed);
    const open = $('open').attachShadow({ mode: 'open' });
    open.innerHTML = '<slot></slot>';
    expect(layerParent($('open'), $('slotted'))).toBe(open);
  });
});

describe('layerParent with chrome.dom', () => {
  it("a host's closed shadow root, so the layer is never slotted into a page component", () => {
    html('<div id="host" style="position: relative"><textarea id="f"></textarea></div>');
    const closed = $('host').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<slot></slot>';
    expect(layerParent($('host'), $('f'))).toBe($('host')); // can't see the root: the light DOM
    vi.stubGlobal('chrome', { dom: { openOrClosedShadowRoot: (el: Element) => (el === $('host') ? closed : null) } });
    expect(layerParent($('host'), $('f'))).toBe(closed);
  });
});

describe('visibleBox and firstVisible', () => {
  const rect = (el: Element, r: DOMRect, client = { width: r.width, height: r.height }) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(r);
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: client.width });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: client.height });
  };

  it("the anchor's visible part: its own box when it scrolls, its scrolling ancestors', and the viewport", () => {
    html('<div id="outer" style="overflow-y: auto"><div id="s" style="position: relative; overflow-y: auto"></div></div>');
    rect($('outer'), new DOMRect(0, 50, 400, 300));
    rect($('s'), new DOMRect(10, 100, 300, 600), { width: 290, height: 600 }); // a 10px scrollbar on the right
    expect(visibleBox($('s'))).toEqual({ left: 10, top: 100, right: 300, bottom: 350 });
  });

  it('the document anchor: the viewport', () => {
    expect(visibleBox(document.documentElement)).toEqual({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  });

  it('firstVisible: the index of the first rect with some area in the box, or -1', () => {
    const box = { left: 0, top: 100, right: 300, bottom: 400 };
    const hidden = new DOMRect(10, 80, 50, 18); // above the box
    const touching = new DOMRect(10, 82, 50, 18); // its bottom is the box's top: nothing shows
    const shown = new DOMRect(10, 104, 50, 18);
    expect(firstVisible([hidden, touching, shown], box)).toBe(2);
    expect(firstVisible([shown, hidden], box)).toBe(0);
    expect(firstVisible([hidden], box)).toBe(-1);
  });
});

describe('scrollMoves', () => {
  it('the document, the element and its ancestors move it; anything else does not', () => {
    html('<div id="outer" style="overflow-y: auto"><div id="s" style="position: relative; overflow-y: auto"><textarea id="f"></textarea></div></div><div id="other"></div>');
    expect(scrollMoves(document, $('s'))).toBe(true);
    expect(scrollMoves($('s'), $('s'))).toBe(true);
    expect(scrollMoves($('outer'), $('s'))).toBe(true);
    expect(scrollMoves($('f'), $('s'))).toBe(false); // the field's own scroll: re-measure
    expect(scrollMoves($('other'), $('s'))).toBe(false);
    expect(scrollMoves(window, $('s'))).toBe(false);
  });

  it('crosses shadow roots from the anchor up', () => {
    html('<div id="s" style="overflow-y: auto"><div id="host"></div></div>');
    const shadow = $('host').attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<div style="position: relative"></div>';
    expect(scrollMoves($('s'), shadow.firstElementChild!)).toBe(true);
  });
});

describe('layerZIndex', () => {
  it('none: auto (null) when nothing positioned from the paint element to the anchor has a z-index', () => {
    html('<div id="a" style="position: relative"><div style="position: relative"><textarea id="f"></textarea></div></div>');
    expect(layerZIndex($('f'), $('a'))).toBeNull();
  });

  it("Docs: the tile container itself (position: absolute; z-index: 22) gives 23", () => {
    html('<div id="editor" style="position: relative"><div><div id="tiles" style="position: absolute; z-index: 22"><p>Text</p></div></div></div>');
    expect(layerZIndex($('tiles'), $('editor'))).toBe(23);
  });

  it('the outermost positioned ancestor with a z-index sets the level, up to the anchor (exclusive)', () => {
    html('<div id="a" style="position: relative; z-index: 50"><div style="position: relative; z-index: 3"><div style="position: absolute; z-index: 40"><textarea id="f" style="position: relative; z-index: 7"></textarea></div></div></div>');
    expect(layerZIndex($('f'), $('a'))).toBe(4); // 3: the anchor's own 50 doesn't count
  });

  it("a z-index on a static element doesn't apply, and a negative one is a level too", () => {
    html('<div id="a" style="position: relative"><div style="z-index: 9"><textarea id="f" style="position: relative; z-index: -2"></textarea></div></div>');
    expect(layerZIndex($('f'), $('a'))).toBe(-1);
  });

  it("a paint element outside the anchor: auto (null), nothing above the anchor counts", () => {
    html('<div style="position: relative; z-index: 4"><div id="a" style="position: relative"></div><div id="p" style="position: relative; z-index: 8"></div></div>');
    expect(layerZIndex($('p'), $('a'))).toBeNull();
  });

  it('crosses shadow roots on the way up', () => {
    html('<div id="a" style="position: relative"><div id="host" style="position: relative; z-index: 2"></div></div>');
    const shadow = $('host').attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<textarea></textarea>';
    expect(layerZIndex(shadow.querySelector('textarea')!, $('a'))).toBe(3);
  });
});

describe('layerZIndex: flex and grid items stack too', () => {
  it('a static flex or grid item with a z-index sets the level', () => {
    for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid']) {
      html(`<div id="a" style="position: relative"><div style="display: ${display}"><textarea id="f" style="z-index: 5"></textarea></div></div>`);
      expect(layerZIndex($('f'), $('a')), display).toBe(6);
    }
  });

  it("a static element in a block (or contents) parent still doesn't stack", () => {
    for (const display of ['block', 'contents', 'inline']) {
      html(`<div id="a" style="position: relative"><div style="display: ${display}"><textarea id="f" style="z-index: 5"></textarea></div></div>`);
      expect(layerZIndex($('f'), $('a')), display).toBeNull();
    }
  });

  it('a flex item further up is a level too, and the outermost level wins', () => {
    html('<div id="a" style="position: relative; display: grid"><div style="z-index: 2"><div style="position: relative; z-index: 9"><textarea id="f"></textarea></div></div></div>');
    expect(layerZIndex($('f'), $('a'))).toBe(3);
  });
});

describe('layerAfter: where the layer goes when the text paints in its own branch (Docs)', () => {
  it("the parent's child that holds the paint element: Docs' tile branch in the editor", () => {
    html('<div id="editor"><div id="branch"><div class="kix-rotatingtilemanager"><div id="tiles"></div></div></div><div id="fab"></div></div><div id="other"></div>');
    expect(layerAfter($('editor'), $('tiles'))).toBe($('branch'));
    expect(layerAfter($('editor'), $('branch'))).toBe($('branch'));
  });

  it('null when the paint element is not under the parent, or is the parent itself', () => {
    html('<div id="editor"><div id="branch"></div></div><div id="other"></div>');
    expect(layerAfter($('editor'), $('other'))).toBeNull();
    expect(layerAfter($('editor'), $('editor'))).toBeNull();
  });

  it("the anchor's shadow root as the parent", () => {
    html('<div id="host" style="position: relative"></div>');
    const root = $('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="branch"><p id="text"></p></div><div></div>';
    expect(layerAfter(root, root.getElementById('text')!)).toBe(root.getElementById('branch'));
  });
});

describe('layerZIndex: joining the paint root\'s level (Docs)', () => {
  it("Docs: the layer takes the tiles' own level (22), not one above; the generic rule stays +1", () => {
    html('<div id="editor" style="position: relative"><div><div id="tiles" style="position: absolute; z-index: 22"><p>Text</p></div></div></div>');
    expect(layerZIndex($('tiles'), $('editor'), true)).toBe(22);
    expect(layerZIndex($('tiles'), $('editor'))).toBe(23);
    $('tiles').style.zIndex = 'auto';
    expect(layerZIndex($('tiles'), $('editor'), true)).toBeNull();
  });
});

describe('showsText: a hover counts only where the field shows its own text', () => {
  /** Our layer's element, as the anchor's last child (where it goes for a generic field). */
  const layerIn = (anchor: Element) => anchor.appendChild(document.createElement('englint-field-layer'));

  it('the field or what is inside it: yes; anything else, or nothing: no', () => {
    html('<div id="a" style="position: relative"><div id="f" contenteditable="true"><p id="p">I has a cat.</p></div><div id="other"></div></div><textarea id="t"></textarea>');
    const at = { field: $('f'), surface: $('f'), anchor: $('a'), z: null, layer: layerIn($('a')) };
    expect(showsText($('f'), at)).toBe(true);
    expect(showsText($('p'), at)).toBe(true);
    expect(showsText($('other'), at)).toBe(false);
    expect(showsText(null, at)).toBe(false);
    const html_ = document.documentElement;
    const ta = { field: $('t'), surface: $('t'), anchor: html_, z: null, layer: layerIn(html_) };
    expect(showsText($('t'), ta)).toBe(true); // a textarea is its own text surface
  });

  // The live editor: the tile branch (tiles at 22, the floating button at 23),
  // our layer at 22 right after it, then the UI container at 41 with the caret.
  const DOCS =
    '<div id="editor" style="position: relative"><div id="branch"><div id="hit" class="kix-rotatingtilemanager">' +
    '<div id="tiles" style="position: absolute; z-index: 22"><div id="page" style="position: relative; z-index: 1"><svg id="svg"></svg></div></div></div>' +
    '<div id="fab" class="docs-gm3-filled-button" role="button" style="position: fixed; z-index: 23"><span id="label"></span></div></div>' +
    '<englint-field-layer id="layer"></englint-field-layer>' +
    '<div id="ui" style="position: absolute; z-index: 41"><div id="cursor" style="position: absolute; z-index: 27"><div id="caret"></div></div></div>' +
    '<div id="ruler"></div></div>';

  it("Docs: the text at the tiles' level (22, before the layer) shows; the button, the caret and other editor UI don't", () => {
    html(DOCS);
    const at = { field: $('editor'), surface: $('hit'), anchor: $('editor'), z: 22, layer: $('layer') };
    expect(showsText(document.getElementById('svg'), at)).toBe(true); // a tie at 22, and before the layer: under it
    expect(showsText($('page'), at)).toBe(true);
    expect(showsText($('label'), at)).toBe(false);
    expect(showsText($('fab'), at)).toBe(false);
    expect(showsText($('caret'), at)).toBe(false); // outside the hit region, and at 41
    expect(showsText($('ruler'), at)).toBe(false); // inside the editor, outside its hit region
    expect(showsText($('branch'), at)).toBe(false);
  });

  it('at the same level, only an element after the layer in tree order covers it (Docs without a hit region found)', () => {
    html(DOCS);
    const late = document.createElement('div');
    late.style.cssText = 'position: absolute; z-index: 22';
    $('editor').append(late);
    const at = { field: $('editor'), surface: $('editor'), anchor: $('editor'), z: 22, layer: $('layer') };
    expect(showsText(document.getElementById('svg'), at)).toBe(true);
    expect(showsText(late, at)).toBe(false);
    expect(showsText($('caret'), at)).toBe(false); // 41 > 22
  });

  it('an interactive element on the way up to the field: a button, a link, a [role=button], an input', () => {
    html(
      '<div id="a" style="position: relative"><div id="f" contenteditable="true"><p>Hi <span contenteditable="false">' +
        '<button id="b"><i id="bi">x</i></button><a id="l" href="#">ref</a><span id="rb" role="button">chip</span><input id="in">' +
        '</span> <a id="link" href="#">linked <b id="lb">words</b></a></p></div></div>',
    );
    const at = { field: $('f'), surface: $('f'), anchor: $('a'), z: null, layer: layerIn($('a')) };
    for (const id of ['b', 'bi', 'l', 'rb', 'in']) expect(showsText($(id), at), id).toBe(false);
    // A link in the user's own editable text is text: its words get cards too.
    expect(showsText($('link'), at)).toBe(true);
    expect(showsText($('lb'), at)).toBe(true);
  });

  it("an element stacked above the layer's z-index covers the text; one at or below it, before the layer, doesn't", () => {
    html(
      '<div id="a" style="position: relative"><div id="f" contenteditable="true"><p id="p">Text</p>' +
        '<div style="position: absolute; z-index: 7"><b id="pb">tip</b></div>' +
        '<div style="position: absolute; z-index: 6"><b id="tb">tie</b></div>' +
        '<div style="position: relative; z-index: 4"><b id="lob">low</b></div>' +
        '<div style="position: relative; z-index: 0"><b id="zb">zero</b></div>' +
        '<div style="display: flex"><span id="flex" style="z-index: 7">flex item</span></div></div></div>',
    );
    const at = { field: $('f'), surface: $('f'), anchor: $('a'), z: 6 as number | null, layer: layerIn($('a')) };
    expect(showsText($('p'), at)).toBe(true);
    expect(showsText($('pb'), at)).toBe(false); // 7 > 6
    expect(showsText($('flex'), at)).toBe(false); // a flex item stacks too
    expect(showsText($('tb'), at)).toBe(true); // 6: a tie, and the layer comes later
    expect(showsText($('lob'), at)).toBe(true); // 4 < 6
    // A layer at auto (level 0): anything stacked above 0 covers it; a z-index of 0 paints before it.
    at.z = null;
    expect(showsText($('lob'), at)).toBe(false);
    expect(showsText($('zb'), at)).toBe(true);
    expect(showsText($('p'), at)).toBe(true);
  });
});
