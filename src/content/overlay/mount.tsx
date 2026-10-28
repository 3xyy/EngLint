import { Fragment, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { CheckStatus, FamilyToggle, LocatedIssue } from '../../core/types';
import { badgePosition } from '../badge-placement';
import type { ToolsHandlers, ToolsView } from '../tools/tools-controller';
import { firstVisible, scrollMovesText, showsText, visibleBox } from './anchor';
import { providerInfoNow } from '../provider-info';
import { Badge, BADGE_SIZE, type BadgeLook, badgeLook, coveredAt } from './Badge';
import { Card, type CardSide, OfferChip, UndoChip } from './Card';
import { type FieldLayer, SHADOW_MODE } from './field-layer';
import { createFieldViews, type FieldView, type LayerTarget, originOf, type RenderResult, shift, toViewport } from './field-views';
import { type ActiveState, type CardRef, createHoverState, idsOf, sameCard } from './hover-state';
import { SelectionBar, type SelectionBarProps } from './SelectionBar';
import { ToolsPopover } from './ToolsPopover';
import { Flash, type OverlayItem, Underlines } from './Underlines';
import './overlay.css';
import overlayCss from './overlay.css?inline'; // the same styles, for the field layers' own shadow roots

export type { LayerTarget, OverlayItem, RenderResult };

/** The selection bar beside a field's selection: where, for which mode, and what a pick does. */
export type SelectionBarState = Pick<SelectionBarProps, 'at' | 'mode' | 'singleWord' | 'tooLong' | 'onPick'>;

/**
 * A card's setting action, in its "⋯" menu: its label, and what pressing it does (`at`: the viewport rect of the
 * card's text; `side`: which side of it the card was on).
 */
export interface CardSecondary {
  label: string;
  run(at: DOMRect, side?: CardSide): void;
}

/** What the in-field badge is told about the focused field, measured by FieldHost in this same frame. */
export interface BadgeState {
  /** The field's visible box (viewport px): the badge sits in its bottom-right corner. */
  anchor: DOMRect;
  /** Open issues with severity 'error'. */
  errors: number;
  /** Every other open issue. */
  suggestions: number;
  /** A check request is in flight. */
  busy: boolean;
  status: CheckStatus;
  /** The field has had its first answer. */
  checked: boolean;
  /** The top family of the open suggestions: a suggestions count is drawn in its colour. */
  family?: FamilyToggle;
  /** The caret's line box (viewport px), or null: the badge hides while it overlaps it. */
  caret: DOMRect | null;
  /** The field's element: it, and what's inside it, never push the badge aside. */
  field: Element;
  /** How far in from the corner, px. */
  inset: number;
}

export interface OverlayHandle {
  /**
   * Draws a field's issues from viewport rects measured in this same frame: with an anchor, in the field's
   * own layer inside it, which the page scrolls with the text; without, in the page-wide fixed layer.
   */
  render(fieldId: string, items: OverlayItem[], where?: LayerTarget): RenderResult;
  clear(fieldId: string): void;
  /**
   * Whether a native field moved within its anchor (more than 0.5px) since its last render: a scroll the
   * page compensates still needs a re-measure then. One read of the field and one of its layer.
   */
  drifted(fieldId: string): boolean;
  /** `cb(fieldId)` when the page took a field's layer out: draw that field again (it is put back). */
  onLayerLost(cb: (fieldId: string) => void): void;
  onAccept(cb: (fieldId: string, issueId: string) => void): void;
  /** A card's "Rewrite sentence" (in its menu, or a comment-only note's primary) was pressed. */
  onRewrite(cb: (fieldId: string, issueId: string) => void): void;
  /** A card's Dismiss was pressed: the card's text rect and the side of it the card was on come with it. */
  onDismiss(cb: (fieldId: string, issueId: string, at: DOMRect, side: CardSide) => void): void;
  /**
   * Asks `cb` what setting action an issue's card offers in its menu (null: nothing). Pressing it closes the card,
   * then runs the action with the viewport rect of the card's text and the side of it the card was on.
   */
  cardActions(cb: (fieldId: string, issue: LocatedIssue) => CardSecondary | null): void;
  /**
   * Shows the undo chip where a card of `fieldId` was (`anchor`: the viewport rect of its text; `side`: the side
   * of it the card was on): `text`, then Undo, which calls `onUndo` once. It closes after UNDO_MS, on Esc, on
   * any click elsewhere, when another chip replaces it (one at a time), or when its field leaves.
   */
  showUndo(fieldId: string, anchor: DOMRect, text: string, onUndo: () => void, side?: CardSide): void;
  /**
   * Shows a question chip where a card of `fieldId` was, as showUndo places and closes it: `question`, then the
   * `yes` button (`onYes`) and "Not now" (`onNo`). Either closes it and calls its handler once; closing any other
   * way (UNDO_MS, Esc, a click elsewhere) answers neither.
   */
  showOffer(fieldId: string, anchor: DOMRect, question: string, yes: string, onYes: () => void, onNo: () => void, side?: CardSide): void;
  showNotice(text: string | null): void;
  /** Opens an issue's card at once (keyboard caret, jump-to). */
  open(fieldId: string, issueId: string): void;
  /**
   * Shows the selection bar above `bar.at` (the viewport box of a field's selection), or hides it with null.
   * `bar.onPick` runs for a button or menu item. FieldHost owns it: it also hides it on a scroll of the field.
   */
  showSelectionBar(bar: SelectionBarState | null): void;
  /**
   * Shows the tools popover against `anchor` (the selection's viewport box) with `view`, under the header `title`;
   * null closes it. A click outside calls `handlers.close(false)`, Esc `handlers.close()`. tools/tools-controller.ts
   * drives it; FieldHost hides the selection bar when it opens one, so only one of the two shows at a time.
   */
  showTools(anchor: DOMRect | null, view: ToolsView | null, handlers: ToolsHandlers, title?: string): void;
  /** Flashes viewport `rects` of a field green, as an accepted fix does (a tools result was applied). */
  flash(fieldId: string, rects: DOMRect[]): void;
  /** Closes the open card, if any (keys typed where this document can't see them: Docs' text-event iframe). */
  close(): void;
  /** Closes the undo chip, if any (Esc typed where this document can't see it: Docs' text-event iframe). */
  closeUndo(): void;
  /**
   * Takes the issue's drawn rects now, before a fix changes its text; calling the result (once the fix is
   * confirmed) flashes them green.
   */
  armFlash(fieldId: string, issueId: string): () => void;
  /**
   * Shows the badge for `fieldId` (there is one badge: a new field takes it over), placed now: its corner of
   * `state.anchor`, moved aside for whatever covers it there, hidden under the caret's line. Null clears it,
   * if it is still that field's.
   */
  setBadge(fieldId: string, state: BadgeState | null): void;
  /** The user clicked the badge of `fieldId`. */
  onBadgeClick(cb: (fieldId: string) => void): void;
}

const OPEN_DELAY_MS = 180;
/** Long enough to cross from the underline to the card at a normal pace, short enough that leaving feels prompt. */
const CLOSE_DELAY_MS = 150;
/** How long the undo chip stays. */
export const UNDO_MS = 5000;
/** A card whose text a scroll moved further than this closes (unless focus is in it). */
const CARD_MOVE_PX = 2;
/** overlay.css: the accept flash. */
const FLASH_MS = 450;

/** An issue under the pointer, and which of its rects. */
interface Hit extends CardRef {
  rect: number;
}
interface FlashView {
  key: number;
  /** The field layer the rects are local to, or null: viewport rects in the fixed layer. */
  layer: FieldLayer | null;
  rects: DOMRect[];
}
interface OverlayState extends ActiveState {
  fields: ReadonlyMap<string, FieldView>;
  /** Viewport rect of the text the card is placed against. */
  cardAt: DOMRect | null;
  flashes: FlashView[];
  notice: string | null;
  selectionBar: SelectionBarState | null;
  /** `key`: one per open, so the enter animation plays once, not on every view. */
  tools: { key: number; at: DOMRect | null; view: ToolsView; handlers: ToolsHandlers; title?: string } | null;
  /** The undo chip; `key`: one per chip, so a replacing chip enters afresh. */
  undo: { key: number; fieldId: string; at: DOMRect; side?: CardSide; text: string; onUndo(): void; offer?: { yes: string; onNo(): void } } | null;
  /**
   * The in-field badge: whose it is, where, and what it shows; `shown` false while it is hidden; `hot` while the
   * pointer is over its field (it is fully opaque then).
   */
  badge: { fieldId: string; x: number; y: number; shown: boolean; look: BadgeLook; hot: boolean } | null;
}

const sameRect = (a: DOMRect | null, b: DOMRect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

function findItem(state: OverlayState, ref: CardRef | null): OverlayItem | undefined {
  return ref ? state.fields.get(ref.fieldId)?.items.find((i) => i.issue.id === ref.issueId) : undefined;
}

/** The issue is in the field's latest render and has drawn text. */
const hasAnchor = (state: OverlayState, ref: CardRef) => (findItem(state, ref)?.rects.length ?? 0) > 0;

/**
 * Which of the issue's rects (viewport `rects`) can be seen: the first inside its anchor's visible box (a
 * field layer's rects aren't clipped above the anchor), or inside the viewport for the fixed layer. -1: none.
 */
function visibleIndex(state: OverlayState, ref: CardRef, rects: DOMRect[]): number {
  const view = state.fields.get(ref.fieldId);
  return firstVisible(rects, visibleBox(view?.layer && view.anchor ? view.anchor : document.documentElement));
}

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/** An issue's rects in the viewport now. */
function viewportRects(state: OverlayState, ref: CardRef): DOMRect[] {
  const view = state.fields.get(ref.fieldId);
  const item = findItem(state, ref);
  const origin = view && originOf(view);
  return item && origin ? toViewport(item.rects, origin) : [];
}

/**
 * Whether a hover at the point reaches the view's text. A field layer isn't clipped in JS above its anchor,
 * so its rects include text scrolled out of view (under a toolbar, say), and page UI may cover the text (a
 * menu; Docs' floating button inside the editor): the field's own text must be what's under the pointer
 * (anchor.ts showsText). The fixed layer paints over everything: its rects alone decide.
 */
function shownAt(view: FieldView, x: number, y: number): boolean {
  const { layer, field, anchor } = view;
  if (!layer || !field || !anchor) return true;
  const top = (field.getRootNode() as Document).elementFromPoint(x, y); // a ShadowRoot has it too
  return showsText(top, { field, surface: view.surface ?? field, anchor, z: view.z, layer: layer.host });
}

function createStore(initial: OverlayState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<OverlayState>) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
type Store = ReturnType<typeof createStore>;

function OverlayView(props: {
  store: Store;
  onAccept(card: CardRef): void;
  onRewrite(card: CardRef): void;
  onDismiss(card: CardRef, at: DOMRect, side: CardSide): void;
  onClose(): void;
  /** The open card's setting action, for its menu. */
  secondary(card: CardRef, issue: LocatedIssue): CardSecondary | null;
  /** Pressing it: the card closes, then the action runs against the card's text rect and side. */
  onSecondary(action: CardSecondary, at: DOMRect, side: CardSide): void;
  onUndo(): void;
  onNo(): void;
  onBadge(fieldId: string): void;
}) {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get);
  const { badge, card, cardAt, undo } = state;
  const open = findItem(state, card);
  const secondary = card && open ? props.secondary(card, open.issue) : null;
  return (
    <>
      {[...state.fields].map(([fieldId, view]) => {
        const underlines = (
          <Underlines
            items={view.items}
            active={idsOf([state.hover, card], fieldId)}
            fading={idsOf(state.fading, fieldId)}
            drawing={view.drawing}
          />
        );
        return view.layer ? (
          createPortal(underlines, view.layer.root, fieldId)
        ) : (
          <Fragment key={fieldId}>{underlines}</Fragment>
        );
      })}
      {state.flashes.map((f) =>
        f.layer ? createPortal(<Flash rects={f.rects} />, f.layer.root, `flash/${f.key}`) : <Flash key={`flash/${f.key}`} rects={f.rects} />,
      )}
      {/* Before the card, the chip, the button and the popover: EngLint's own UI paints over it and gets its clicks. */}
      {badge?.shown && <Badge x={badge.x} y={badge.y} look={badge.look} hot={badge.hot} onClick={() => props.onBadge(badge.fieldId)} />}
      {card && open && cardAt && (
        <Card
          key={`${card.fieldId}/${card.issueId}`}
          issue={open.issue}
          context={open.context}
          anchor={cardAt}
          onAccept={() => props.onAccept(card)}
          onRewrite={() => props.onRewrite(card)}
          onDismiss={(side) => props.onDismiss(card, cardAt, side)}
          onClose={props.onClose}
          secondary={secondary ? { label: secondary.label, onClick: (side) => props.onSecondary(secondary, cardAt, side) } : undefined}
        />
      )}
      {undo &&
        (undo.offer ? (
          <OfferChip key={undo.key} anchor={undo.at} side={undo.side} question={undo.text} yes={undo.offer.yes} onYes={props.onUndo} onNo={props.onNo} />
        ) : (
          <UndoChip key={undo.key} anchor={undo.at} side={undo.side} text={undo.text} onUndo={props.onUndo} />
        ))}
      {state.selectionBar && <SelectionBar {...state.selectionBar} />}
      {state.tools && (
        <ToolsPopover
          key={state.tools.key}
          anchor={state.tools.at ?? new DOMRect(0, 0, 0, 0)}
          view={state.tools.view}
          handlers={state.tools.handlers}
          title={state.tools.title}
        />
      )}
      <div className="englint-notice" role="status" hidden={!state.notice}>
        {state.notice}
      </div>
    </>
  );
}

/**
 * The page-wide overlay: a fixed, click-through layer in a shadow root, with the card, the notice and the
 * underlines of fields that have no anchor. Every other field draws its underlines in its own layer inside
 * the page (field-layer.ts). Underlines never take pointer events; hover is found by hit-testing the
 * pointer against the drawn rects. This is the event and card controller: each field's view and layer
 * live in field-views.ts, the hover and its tint fade in hover-state.ts.
 */
export async function mountOverlay(ctx: ContentScriptContext): Promise<OverlayHandle> {
  const store = createStore({
    fields: new Map(),
    card: null,
    cardAt: null,
    hover: null,
    fading: [],
    flashes: [],
    notice: null,
    selectionBar: null,
    tools: null,
    undo: null,
    badge: null,
  });
  let flashSeq = 0;
  let toolsSeq = 0;
  let undoSeq = 0;
  let undoTimer: number | null = null;
  let acceptCb: ((fieldId: string, issueId: string) => void) | null = null;
  let rewriteCb: ((fieldId: string, issueId: string) => void) | null = null;
  let dismissCb: ((fieldId: string, issueId: string, at: DOMRect, side: CardSide) => void) | null = null;
  let actionsCb: ((fieldId: string, issue: LocatedIssue) => CardSecondary | null) | null = null;
  let openTimer: number | null = null;
  let closeTimer: number | null = null;
  let pending: CardRef | null = null; // waiting out the open delay
  // Opened without the pointer (caret, jump-to): the pointer being elsewhere doesn't close it.
  // It joins the hover rules once the pointer visits the card or its underline.
  let pinned = false;
  // A scroll that can move the card's text happened since the card was placed: a field redrawn after it
  // (fixed layer, or the field's own scroll) moved with the scroll, not with an edit.
  let cardScrolled = false;
  // Which of the card's issue rects it is placed against.
  let cardIndex = 0;
  let pointer = { x: 0, y: 0 };
  let badgeField: Element | null = null; // the field the badge is for
  let lostCb: ((fieldId: string) => void) | null = null;
  let badgeCb: ((fieldId: string) => void) | null = null;
  const views = createFieldViews({
    css: overlayCss,
    get: (fieldId) => store.get().fields.get(fieldId),
    put(fieldId, view) {
      const fields = new Map(store.get().fields);
      if (view) fields.set(fieldId, view);
      else fields.delete(fieldId);
      store.set({ fields });
    },
    onLost: (fieldId) => lostCb?.(fieldId),
    setTimeout: (cb, ms) => ctx.setTimeout(cb, ms),
  });

  const cancelOpen = () => {
    if (openTimer !== null) clearTimeout(openTimer);
    openTimer = null;
    pending = null;
  };
  const cancelClose = () => {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = null;
  };
  // Every hover or card change goes through `commit`: an issue that stops being active fades its tint out.
  const { commit, setHover } = createHoverState(store, (cb, ms) => ctx.setTimeout(cb, ms));
  /**
   * Opens `card` (or closes, with null). A hover open is placed against the rect under the pointer (`at`);
   * any other (caret, click, jump-to) against the issue's first visible rect, and only if it has one.
   */
  const setCard = (card: CardRef | null, opts: { pin?: boolean; at?: number } = {}) => {
    cancelOpen();
    cancelClose();
    const state = store.get();
    const rects = card ? viewportRects(state, card) : [];
    const index = card ? (opts.at !== undefined && rects[opts.at] ? opts.at : visibleIndex(state, card, rects)) : -1;
    if (index < 0) card = null;
    pinned = !!card && !!opts.pin;
    cardScrolled = false;
    cardIndex = Math.max(index, 0);
    const cardAt = card ? rects[index]! : null;
    if (!sameCard(state.card, card) || !sameRect(state.cardAt, cardAt)) commit({ card, cardAt });
  };
  const closeUndo = () => {
    if (undoTimer !== null) clearTimeout(undoTimer);
    undoTimer = null;
    if (store.get().undo) store.set({ undo: null });
  };
  /** Where the card's text is now: its rect, or the first visible one if that rect went (a reflow); null if none. */
  const cardRect = (state: OverlayState): DOMRect | null => {
    if (!state.card) return null;
    const rects = viewportRects(state, state.card);
    if (!rects[cardIndex]) cardIndex = visibleIndex(state, state.card, rects);
    return rects[cardIndex] ?? null;
  };

  const ui = await createShadowRootUi<Root>(ctx, {
    name: 'englint-overlay',
    mode: SHADOW_MODE, // closed: a page script can't reach the popover, or read its answers
    position: 'inline',
    // Under <html>, not <body>: a transformed body would become the fixed layer's containing block.
    anchor: document.documentElement,
    isolateEvents: true, // keys typed in the card never reach the page's shortcuts
    onMount(container) {
      const layer = document.createElement('div');
      layer.className = 'englint-layer';
      container.append(layer);
      const root = createRoot(layer);
      root.render(
        <OverlayView
          store={store}
          onAccept={(c) => {
            setCard(null);
            acceptCb?.(c.fieldId, c.issueId);
          }}
          onRewrite={(c) => {
            setCard(null);
            rewriteCb?.(c.fieldId, c.issueId);
          }}
          onDismiss={(c, at, side) => {
            setCard(null);
            dismissCb?.(c.fieldId, c.issueId, at, side);
          }}
          onClose={() => setCard(null)}
          secondary={(c, issue) => actionsCb?.(c.fieldId, issue) ?? null}
          onSecondary={(action, at, side) => {
            setCard(null);
            action.run(at, side);
          }}
          onUndo={() => {
            const undo = store.get().undo;
            closeUndo();
            undo?.onUndo();
          }}
          onNo={() => {
            const undo = store.get().undo;
            closeUndo();
            undo?.offer?.onNo();
          }}
          onBadge={(fieldId) => badgeCb?.(fieldId)}
        />,
      );
      return root;
    },
    onRemove(root) {
      root?.unmount();
    },
  });
  ui.mount();
  ctx.onInvalidated(() => views.dropAll());

  /** The issue under the point, and which rect; one origin read per field (field layers move with their page). */
  const hitIssue = (x: number, y: number): Hit | null => {
    for (const [fieldId, view] of store.get().fields) {
      const origin = originOf(view);
      if (!origin) continue;
      let rect = -1;
      const hit = view.items.find(({ rects }) => (rect = rects.findIndex((r) => inside(r, x - origin.x, y - origin.y))) >= 0);
      if (!hit || !shownAt(view, x, y)) continue;
      return { fieldId, issueId: hit.issue.id, rect };
    }
    return null;
  };
  const over = (selector: string, x: number, y: number) => {
    const el = ui.shadow.querySelector(selector);
    return !!el && inside(el.getBoundingClientRect(), x, y);
  };
  const overCard = (x: number, y: number) => over('.englint-card', x, y);
  const cardHasFocus = () => ui.shadow.activeElement !== null;

  /**
   * The card's text is at `now`. After a scroll, a move of more than CARD_MOVE_PX closes the card, unless
   * focus is in it (a keyboard user's card follows its text). Any other move (an edit, a resize) is followed.
   */
  const cardMoved = (now: DOMRect | null, scrolled: boolean) => {
    const { card, cardAt } = store.get();
    if (!card || !cardAt || !now) return;
    if (scrolled) {
      const far = Math.abs(now.x - cardAt.x) > CARD_MOVE_PX || Math.abs(now.y - cardAt.y) > CARD_MOVE_PX;
      if (far && !cardHasFocus()) setCard(null);
      else if (far) store.set({ cardAt: now });
      return;
    }
    if (!sameRect(now, cardAt)) store.set({ cardAt: now });
  };

  /** The pointer is over the badge's field (the browser's own hover, known before the overlay saw any pointer move). */
  const badgeHot = () => !!badgeField?.matches(':hover');
  const updateBadgeHot = () => {
    const { badge } = store.get();
    const hot = badgeHot();
    if (badge && badge.hot !== hot) store.set({ badge: { ...badge, hot } });
  };

  const onPointer = (x: number, y: number) => {
    updateBadgeHot();
    const open = store.get().card;
    const onCard = !!open && overCard(x, y);
    // The undo chip, the badge, the selection bar (and its menu) and the tools popover cover text: the pointer on
    // one of them is on neither the text nor the card.
    const { undo, badge, selectionBar, tools } = store.get();
    const onOurs =
      (undo && over('.englint-undo', x, y)) ||
      (badge && over('.englint-badge', x, y)) ||
      ((selectionBar || tools) && (over('.englint-bar', x, y) || over('.englint-bar .englint-menu', x, y) || over('.englint-tools', x, y)));
    const hit = onCard || onOurs ? null : hitIssue(x, y);
    setHover(hit); // instant feedback, this pointer frame; the card waits out the open delay
    if (open && (onCard || sameCard(hit, open))) {
      pinned = false;
      cancelOpen();
      cancelClose();
      return;
    }
    if (hit) {
      cancelClose();
      if (sameCard(hit, pending)) return;
      cancelOpen();
      pending = hit;
      openTimer = ctx.setTimeout(() => setCard(hit, { at: hit.rect }), OPEN_DELAY_MS);
      return;
    }
    cancelOpen();
    if (open && !pinned && closeTimer === null && !cardHasFocus()) {
      closeTimer = ctx.setTimeout(() => setCard(null), CLOSE_DELAY_MS);
    }
  };

  let frame = 0;
  ctx.addEventListener(
    document,
    'mousemove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (frame) return;
      frame = ctx.requestAnimationFrame(() => {
        frame = 0;
        onPointer(pointer.x, pointer.y);
      });
    },
    { capture: true, passive: true },
  );
  // The pointer left the window: nothing is hovered any more.
  ctx.addEventListener(document, 'mouseout', (e) => {
    if ((e as MouseEvent).relatedTarget !== null) return;
    updateBadgeHot();
    cancelOpen();
    setHover(null);
  });
  // Field layers move with the page's scrolling without a render. The open card is fixed: it closes when its
  // text moves away (or follows, with focus in it). A pending open or a hover whose text left the pointer is
  // dropped.
  const underPointer = (ref: CardRef) => viewportRects(store.get(), ref).some((r) => inside(r, pointer.x, pointer.y));
  ctx.addEventListener(
    document,
    'scroll',
    (e) => {
      const state = store.get();
      const view = state.card && state.fields.get(state.card.fieldId);
      // Only a scroll that can move the card's text counts: the page, a box around the field, the field or a
      // scroller inside it.
      if (view && e.target && (!view.field || scrollMovesText(e.target, view.field))) {
        cardScrolled = true;
        if (view.layer) cardMoved(cardRect(state), true);
      }
      if (pending && !underPointer(pending)) cancelOpen();
      const { hover } = store.get();
      if (hover && !underPointer(hover)) setHover(null);
    },
    { capture: true, passive: true },
  );
  ctx.addEventListener(
    document,
    'click',
    (e) => {
      if (e.composedPath().includes(ui.shadowHost)) return; // a click on the card itself (the chip: see below)
      closeUndo();
      store.get().tools?.handlers.close(false); // focus is where the click put it
      const hit = hitIssue(e.clientX, e.clientY);
      setCard(hit, { at: hit?.rect }); // against the line clicked, as a hover open: a card already there stays
    },
    { capture: true },
  );
  // A click in the overlay but not on the chip (on the card, say) closes the chip too. The page's own listener
  // above can't tell: inside the closed root, the click's path stops at the host.
  ctx.addEventListener(
    ui.shadow,
    'click',
    (e) => {
      const chip = ui.shadow.querySelector('.englint-undo');
      if (chip && !e.composedPath().includes(chip)) closeUndo();
    },
    { capture: true },
  );
  ctx.addEventListener(
    document,
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (ui.shadow.activeElement?.closest('[role="menu"]')) return; // the card's menu closes itself; the card stays
      closeUndo();
      if (store.get().card) setCard(null);
      store.get().tools?.handlers.close(); // also while focus is back in the field
    },
    { capture: true },
  );
  // Typing closes the card (input, not keydown: Enter on the focused fix must still click it).
  ctx.addEventListener(
    document,
    'input',
    () => {
      if (store.get().card) setCard(null);
    },
    { capture: true },
  );

  /** Flashes `rects` (local to `layer`, or viewport rects in the fixed layer) for FLASH_MS. */
  const showFlash = (layer: FieldLayer | null, rects: DOMRect[]) => {
    const flash: FlashView = { key: ++flashSeq, layer, rects };
    store.set({ flashes: [...store.get().flashes, flash] });
    ctx.setTimeout(() => store.set({ flashes: store.get().flashes.filter((f) => f !== flash) }), FLASH_MS);
  };

  const render = (fieldId: string, items: OverlayItem[], where?: LayerTarget): RenderResult => {
    const { card } = store.get();
    const result = views.render(fieldId, items, where);
    if (result !== 'drawn') return result;
    // Ids change on edits: a card or a pending open whose issue left this update goes away, and so
    // does one whose text scrolled out of view (it must not come back by itself when scrolled back).
    const next = store.get();
    if (pending && !hasAnchor(next, pending)) cancelOpen();
    if (next.hover && !hasAnchor(next, next.hover)) setHover(null);
    if (card && !hasAnchor(next, card)) setCard(null);
    else if (card?.fieldId === fieldId) {
      const now = cardRect(next);
      if (!now) setCard(null);
      else cardMoved(now, cardScrolled);
      cardScrolled = false;
    }
    return 'drawn';
  };

  return {
    render,
    clear(fieldId) {
      if (store.get().undo?.fieldId === fieldId) closeUndo();
      void render(fieldId, []);
    },
    drifted: (fieldId) => views.drifted(fieldId),
    onLayerLost(cb) {
      lostCb = cb;
    },
    onAccept(cb) {
      acceptCb = cb;
    },
    onRewrite(cb) {
      rewriteCb = cb;
    },
    onDismiss(cb) {
      dismissCb = cb;
    },
    cardActions(cb) {
      actionsCb = cb;
    },
    showUndo(fieldId, anchor, text, onUndo, side) {
      closeUndo(); // one at a time: the old one's Undo goes with it
      store.set({ undo: { key: ++undoSeq, fieldId, at: anchor, side, text, onUndo } });
      undoTimer = ctx.setTimeout(closeUndo, UNDO_MS);
    },
    showOffer(fieldId, anchor, question, yes, onYes, onNo, side) {
      closeUndo();
      store.set({ undo: { key: ++undoSeq, fieldId, at: anchor, side, text: question, onUndo: onYes, offer: { yes, onNo } } });
      undoTimer = ctx.setTimeout(closeUndo, UNDO_MS);
    },
    showNotice(text) {
      store.set({ notice: text });
    },
    showSelectionBar(bar) {
      if (!bar && !store.get().selectionBar) return;
      store.set({ selectionBar: bar });
    },
    showTools(anchor, view, handlers, title) {
      const open = store.get().tools;
      if (!view) {
        if (open) store.set({ tools: null });
        return;
      }
      store.set({ tools: { key: open?.key ?? ++toolsSeq, at: anchor, view, handlers, title } });
    },
    flash(fieldId, rects) {
      if (rects.length === 0) return;
      // In the field's own layer when it has one (it scrolls with the text, under the page's own UI).
      const view = store.get().fields.get(fieldId);
      const origin = view?.layer ? originOf(view) : null;
      if (view?.layer && origin) showFlash(view.layer, rects.map((r) => shift(r, -origin.x, -origin.y)));
      else showFlash(null, rects);
    },
    open(fieldId, issueId) {
      setCard({ fieldId, issueId }, { pin: true });
    },
    close() {
      setCard(null);
    },
    closeUndo,
    armFlash(fieldId, issueId) {
      const view = store.get().fields.get(fieldId);
      const rects = findItem(store.get(), { fieldId, issueId })?.rects ?? [];
      if (!view || rects.length === 0) return () => {};
      const { layer } = view;
      return () => showFlash(layer, rects);
    },
    setBadge(fieldId, state) {
      const now = store.get().badge;
      if (!state) {
        if (now?.fieldId === fieldId) {
          badgeField = null;
          store.set({ badge: null });
        }
        return;
      }
      badgeField = state.field;
      const at = badgePosition(state.anchor, { inset: state.inset, size: BADGE_SIZE, blocked: coveredAt(state.field), caret: state.caret });
      const look = badgeLook(state, providerInfoNow());
      const next = { fieldId, x: at.x, y: at.y, shown: !at.hidden, look, hot: badgeHot() };
      // Scrolls redraw it every frame: the store changes only when what is shown does.
      const same =
        now?.fieldId === next.fieldId &&
        now.shown === next.shown &&
        (!next.shown || (now.x === next.x && now.y === next.y)) &&
        now.look.face === look.face &&
        now.look.text === look.text &&
        now.look.tone === look.tone &&
        now.look.family === look.family &&
        now.look.label === look.label &&
        now.hot === next.hot;
      if (!same) store.set({ badge: next });
    },
    onBadgeClick(cb) {
      badgeCb = cb;
    },
  };
}
