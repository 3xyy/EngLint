// Each field's view in the overlay. Its underline layer's lifecycle inside the page (overlay/field-layer.ts):
// created, placed in its anchor (overlay/anchor.ts), stacked, watched for the page taking it out, and given
// up for the fixed layer, for a while, when the page keeps doing so (`unstable`). The conversion between viewport rects and the
// layer's own coordinates, the drift probe, and the draw-in bookkeeping: each issue draws in once, the
// first time it is shown in its field.
import { layerAfter, layerParent, layerZIndex } from './anchor';
import { createFieldLayer, type FieldLayer, placeFieldLayer, setLayerZ } from './field-layer';
import type { OverlayItem } from './Underlines';

/** Where a field's underlines go: `field` is the field's element; `anchor`, its layer's anchor (overlay/anchor.ts), or null for the fixed layer. */
export interface LayerTarget {
  field: Element;
  anchor: Element | null;
  /**
   * Where the text paints, when that isn't the field (Docs' tile container): the layer joins its stacking
   * level and goes right after the branch holding it.
   */
  paint?: Element | null;
  /** Where the pointer lands over the text, when that isn't all of the field (Docs' hit region). */
  surface?: Element | null;
}

/**
 * `drawn`; `skipped`, the anchor isn't rendered now (nothing changed: try again on the next render);
 * `unrendered`, the field's own layer can't be used there: draw it in the fixed layer from now on;
 * `unstable`, the page keeps taking the layer out (MAX_LOSSES in LOSS_WINDOW_MS): draw it in the fixed
 * layer for now, and try the layer again later (FieldHost: after a while, or on the field's next focus).
 */
export type RenderResult = 'drawn' | 'skipped' | 'unrendered' | 'unstable';

export interface FieldView {
  /** Rects in the coordinates of the layer they're drawn in: the field layer's own, or the viewport's. */
  items: OverlayItem[];
  /** The field's own layer, or null: the fixed layer. */
  layer: FieldLayer | null;
  /** The field's element. With a layer, its text must be what's under the pointer for a hover to count. */
  field: Element | null;
  /** With a layer: where the pointer lands over the text (the field, or Docs' hit region inside it). */
  surface: Element | null;
  /** With a layer: its anchor, whose visible box says which rects can be seen. */
  anchor: Element | null;
  /** With a layer: its z-index inside the anchor (null: auto). What stacks at or above it covers the text. */
  z: number | null;
  /** Issues shown in this field for the first time just now: their underlines draw in. */
  drawing: ReadonlySet<string>;
}

/** overlay.css: the draw-in. */
export const DRAW_MS = 260;
/** A field layer is put back after the page removes it, unless that happens this often: then the fixed layer. */
const MAX_LOSSES = 3;
const LOSS_WINDOW_MS = 2000;
/** The field moved within its anchor by more than this: re-measure. */
const DRIFT_PX = 0.5;

export interface Point {
  x: number;
  y: number;
}

export const shift = (r: DOMRect, dx: number, dy: number) => new DOMRect(r.x + dx, r.y + dy, r.width, r.height);

/** Viewport rects in a layer's own coordinates: rect − the layer's origin, both read in the same frame. */
export function toLocal(items: OverlayItem[], origin: Point): OverlayItem[] {
  return items.map((item) => ({ ...item, rects: item.rects.map((r) => shift(r, -origin.x, -origin.y)) }));
}

/** A layer's own rects back in the viewport, at the layer's origin now. */
export function toViewport(rects: DOMRect[], origin: Point): DOMRect[] {
  return rects.map((r) => shift(r, origin.x, origin.y));
}

/** Where a field's drawn rects are in the viewport now: its layer's origin (one read), or 0,0 for the fixed layer. */
export function originOf(view: FieldView): Point | null {
  if (!view.layer) return { x: 0, y: 0 };
  if (!view.layer.host.isConnected) return null; // the page removed it; it comes back on the next render
  const r = view.layer.host.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

/**
 * When each issue of each field was first shown (drawn with rects), so its draw-in plays once: from the
 * render that first draws it, for DRAW_MS. Not again on later renders, scrolls, or a repaint that drops
 * and re-adds its rects (it stays a current issue). Pruned to the field's current issues on every render.
 */
export class DrawIns {
  private readonly shown = new Map<string, Map<string, number>>();

  /** Records a render of the field's `items` at `now`; returns the ids drawing in now. */
  update(fieldId: string, items: readonly OverlayItem[], now: number): Set<string> {
    const seen = this.shown.get(fieldId);
    const shown = new Map<string, number>(); // pruned to the current issues
    for (const { issue, rects } of items) {
      const at = seen?.get(issue.id) ?? (rects.length > 0 ? now : undefined);
      if (at !== undefined) shown.set(issue.id, at);
    }
    if (shown.size > 0) this.shown.set(fieldId, shown);
    else this.shown.delete(fieldId);
    return new Set([...shown].flatMap(([id, at]) => (now - at < DRAW_MS ? [id] : [])));
  }

  /** Those of `drawing` still drawing in at `now`. */
  still(fieldId: string, drawing: ReadonlySet<string>, now: number): Set<string> {
    const shown = this.shown.get(fieldId);
    return new Set([...drawing].filter((id) => now - (shown?.get(id) ?? -Infinity) < DRAW_MS));
  }
}

export interface FieldViewsDeps {
  /** The overlay's CSS, for each field layer's own shadow root. */
  css: string;
  /** The overlay's store of views: a field's view now, and replacing (or, with null, removing) it. */
  get(fieldId: string): FieldView | undefined;
  put(fieldId: string, view: FieldView | null): void;
  /** The page took a field's layer out: draw that field again (it is put back). */
  onLost(fieldId: string): void;
  /** Timers that end with the content script (ctx.setTimeout). */
  setTimeout(cb: () => void, ms: number): unknown;
}

/** The fields' views, and their layers in the page. */
export function createFieldViews(deps: FieldViewsDeps) {
  const layers = new Map<string, FieldLayer>();
  const drawIns = new DrawIns();
  /** Per native field: the field's offset from its layer's origin at the last render (the drift probe). */
  const offsets = new Map<string, { field: Element; x: number; y: number }>();
  /** Per field layer: an observer of its parent's children, which sees the page take the layer out. */
  const watches = new Map<string, { parent: Node; observer: MutationObserver }>();
  const losses = new Map<string, number[]>();
  const unstable = new Set<string>(); // layers the page keeps removing: the fixed layer instead

  const unwatch = (fieldId: string) => {
    watches.get(fieldId)?.observer.disconnect();
    watches.delete(fieldId);
  };
  const dropLayer = (fieldId: string) => {
    unwatch(fieldId); // before removing it: our own removal is no loss
    layers.get(fieldId)?.host.remove();
    layers.delete(fieldId);
    offsets.delete(fieldId);
    losses.delete(fieldId);
    unstable.delete(fieldId);
  };
  /** The page took the layer out of `parent`: draw the field again (it is put back), unless it keeps doing so. */
  const lost = (fieldId: string) => {
    const now = performance.now();
    const recent = (losses.get(fieldId) ?? []).filter((t) => now - t < LOSS_WINDOW_MS);
    recent.push(now);
    losses.set(fieldId, recent);
    if (recent.length >= MAX_LOSSES) unstable.add(fieldId);
    deps.onLost(fieldId);
  };
  /** Watches `parent` (children only) for the layer leaving it; our own re-insert is not a loss. */
  const watchParent = (fieldId: string, layer: FieldLayer, parent: Node) => {
    if (watches.get(fieldId)?.parent === parent) return;
    unwatch(fieldId); // before the layer moves: leaving the old parent is our doing
    const observer = new MutationObserver(() => {
      if (layer.host.parentNode !== parent && layers.get(fieldId) === layer) lost(fieldId);
    });
    observer.observe(parent, { childList: true });
    watches.set(fieldId, { parent, observer });
  };

  /** Takes the draw-in class off issues first shown DRAW_MS ago (a view update: no re-measure needed). */
  const endDrawIn = (fieldId: string) => {
    const view = deps.get(fieldId);
    if (!view || view.drawing.size === 0) return;
    const drawing = drawIns.still(fieldId, view.drawing, performance.now());
    if (drawing.size === view.drawing.size) return;
    deps.put(fieldId, { ...view, drawing });
  };

  /**
   * Draws a field's issues from viewport rects measured in this same frame: with an anchor, in the field's
   * own layer inside it (placed, or put back, there), in that layer's coordinates; without, in the fixed
   * layer. The view is stored (removed when nothing is drawn).
   */
  const render = (fieldId: string, items: OverlayItem[], where?: LayerTarget): RenderResult => {
    const anchor = where?.anchor ?? null;
    let layer: FieldLayer | null = null;
    let z: number | null = null;
    if (anchor && unstable.has(fieldId)) {
      dropLayer(fieldId);
      return 'unstable';
    }
    if (where && anchor && (items.length > 0 || layers.has(fieldId))) {
      layer = layers.get(fieldId) ?? null;
      if (!layer) layers.set(fieldId, (layer = createFieldLayer(deps.css)));
      const parent = layerParent(anchor, where.field);
      watchParent(fieldId, layer, parent);
      // Docs' text paints in a branch of its own: the layer joins the text's level right after that branch,
      // so Docs' UI above that level (its floating button, its caret) stays over it.
      const paint = where.paint && where.paint !== where.field ? where.paint : null;
      const after = paint ? layerAfter(parent, paint) : null;
      const placed = placeFieldLayer(layer, parent, anchor, after);
      if (placed === 'hidden') return 'skipped'; // keep what's drawn; the anchor's resize brings a render
      if (placed === 'unrendered') {
        dropLayer(fieldId);
        return 'unrendered';
      }
      z = paint ? layerZIndex(paint, anchor, true) : layerZIndex(where.field, anchor); // over the text's level
      setLayerZ(layer, z);
    }
    // Local = viewport − the layer's origin, read in the frame the rects were measured in.
    const origin = layer?.host.getBoundingClientRect();
    const drawn = origin ? toLocal(items, { x: origin.left, y: origin.top }) : items;
    // The drift probe needs a field inside the anchor's scrolled content: a field that is the anchor (Docs'
    // editor) stays put while the layer scrolls with its content. Its anchor resize observer covers it instead.
    if (origin && where && where.field !== anchor) {
      const f = where.field.getBoundingClientRect();
      offsets.set(fieldId, { field: where.field, x: f.left - origin.left, y: f.top - origin.top });
    } else offsets.delete(fieldId);
    const drawing = drawIns.update(fieldId, items, performance.now());

    const field = where?.field ?? null;
    const surface = layer ? (where?.surface ?? field) : null;
    deps.put(fieldId, drawn.length > 0 ? { items: drawn, layer, field, surface, anchor: layer ? anchor : null, z, drawing } : null);
    if (drawing.size > 0) deps.setTimeout(() => endDrawIn(fieldId), DRAW_MS + 5);
    if (!layer) dropLayer(fieldId); // drawn in the fixed layer now, or gone
    return 'drawn';
  };

  return {
    render,
    /**
     * Whether a native field moved within its anchor (more than DRIFT_PX) since its last render: a scroll
     * the page compensates still needs a re-measure then. One read of the field and one of its layer.
     */
    drifted(fieldId: string): boolean {
      const probe = offsets.get(fieldId);
      const layer = layers.get(fieldId);
      if (!probe || !layer?.host.isConnected) return false;
      const o = layer.host.getBoundingClientRect();
      const f = probe.field.getBoundingClientRect();
      return Math.abs(f.left - o.left - probe.x) > DRIFT_PX || Math.abs(f.top - o.top - probe.y) > DRIFT_PX;
    },
    /** Takes every field layer out of the page (the content script is going away). */
    dropAll(): void {
      [...layers.keys()].forEach(dropLayer);
    },
  };
}
