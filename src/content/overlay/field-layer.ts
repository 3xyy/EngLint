// One field's underline layer: our own element, placed as the last child of the field's anchor
// (overlay/anchor.ts) so the page scrolls it with the text; in Docs, right after the editor's tile branch
// instead (anchor.ts layerAfter). Absolute at the anchor's padding-box origin, 0×0 with visible overflow,
// click-through. Its z-index is auto, or one above the field's own stacking level inside the anchor; in
// Docs, the tiles' own level (22), after them in tree order. So it is above the text, and under the page's
// own menus and modals (in Docs, under its floating button at 23 and its caret's container at 41).
// Underlines inside it use coordinates local to it: rect − its origin.

export const FIELD_LAYER_TAG = 'englint-field-layer';

// :host rules from inside the shadow root, !important: they beat any page rule on the host (an inner
// context's important declarations win over the outer context's).
const HOST_CSS = `:host {
  all: initial !important;
  display: block !important;
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  pointer-events: none !important;
}`;

/**
 * EngLint's shadow roots in the page (the field layers and the overlay): closed, so page scripts can't reach
 * in (I3: the overlay's popover spends the user's key); the e2e build opens them so Playwright's locators can.
 */
export const SHADOW_MODE: ShadowRootMode = import.meta.env.ENGLINT_E2E ? 'open' : 'closed';

export interface FieldLayer {
  /** Our element in the page. */
  readonly host: HTMLElement;
  /** Inside the shadow root: what the underlines are rendered into. */
  readonly root: HTMLElement;
  /** The host's z-index rule (see setLayerZ), after the host rules so it wins over their reset. */
  readonly zStyle: HTMLStyleElement;
}

/** A new, unplaced layer whose shadow root carries `css` (the overlay's underline styles). */
export function createFieldLayer(css: string): FieldLayer {
  const host = document.createElement(FIELD_LAYER_TAG);
  const shadow = host.attachShadow({ mode: SHADOW_MODE });
  const style = document.createElement('style');
  style.textContent = `${HOST_CSS}\n${css}`;
  const zStyle = document.createElement('style');
  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  shadow.append(style, zStyle, root);
  return { host, root, zStyle };
}

/**
 * Stacks the layer at `z` (overlay/anchor.ts layerZIndex: just above the text's own stacking level inside
 * the anchor), or at auto with null. Not inline: the :host reset (an inner-context !important) beats it.
 */
export function setLayerZ(layer: FieldLayer, z: number | null): void {
  const css = z === null ? '' : `:host { z-index: ${z} !important; }`;
  if (layer.zStyle.textContent !== css) layer.zStyle.textContent = css;
}

/**
 * How placing went: `ok`; `hidden`, the anchor itself isn't rendered now (a hidden container: try again
 * later); `unrendered`, the anchor is rendered but the layer isn't (a light-DOM child of a shadow host
 * with no slot for it): the caller falls back to the fixed layer for good.
 */
export type Placement = 'ok' | 'hidden' | 'unrendered';

/**
 * Puts the layer in `parent` (the anchor, or its shadow root): right after `after` when that is one of
 * its children (Docs: the tile branch), otherwise as its last child, unless it is already in `parent`. It
 * comes back to the same place after the page removed it (an SPA re-render).
 */
export function placeFieldLayer(
  layer: FieldLayer,
  parent: Element | ShadowRoot,
  anchor: Element,
  after: Node | null = null,
): Placement {
  const { host } = layer;
  if (after && after.parentNode === parent) {
    if (host.previousSibling !== after) parent.insertBefore(host, after.nextSibling);
  } else if (!host.isConnected || host.parentNode !== parent) parent.appendChild(host);
  if (host.getClientRects().length > 0) return 'ok';
  return anchor.getClientRects().length > 0 ? 'unrendered' : 'hidden';
}
