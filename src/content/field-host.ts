// The page side shared by every content script: fields (adapter + FieldSession), the overlay, reports
// to the background, the panel's requests, and this host's settings. content.ts finds fields by focus;
// gdocs.content.ts attaches the one Docs field.
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { canApply, locateEdit, type ChatFocus } from '../core/chat-format';
import { contextAround, isSingleWord, sentenceAround, trimRange } from '../core/context';
import type { SuggestionPolicy } from '../core/match';
import { defaultFamilies, effectiveMode } from '../core/modes';
import { focusFor } from '../core/presets';
import { findQuote } from '../core/quotes';
import { isPageDisabled } from '../core/sites';
import type { CheckStatus, FamilyToggles, LocatedIssue, Mode } from '../core/types';
import { carryTypography, dictionaryForm } from '../core/typography';
import { onMessage, sendMessage, type ApplyEditResult, type OpenToolsRequest } from '../shared/messages';
import {
  dictionaryItem,
  disabledSitesItem,
  essaySitesItem,
  localChecksItem,
  readSuggestionFamilies,
  rulesItem,
  showBadgeItem,
  siteModesItem,
  suggestionFamiliesByModeItem,
} from '../shared/settings';
import { APPLY_FAILED, APPLY_FAILED_COPIED } from '../shared/status-text';
import type { EditorAdapter } from './adapters/types';
import { cardAction, offerAfterDismiss } from './card-actions';
import { deepActiveElement } from './detect';
import { type FieldSelection, MAX_SELECTION_CHARS, overLimit, readFieldSelection } from './tools/selection';
import { createToolsController, TOOLS_COPY, type ToolsController, type ToolsRange } from './tools/tools-controller';
import { boxAround, findLayerAnchor, scrollMoves, scrollMovesText, visibleBox } from './overlay/anchor';
import { topFamily } from './overlay/Badge';
import type { CardSide } from './overlay/Card';
import { mountOverlay, type OverlayHandle } from './overlay/mount';
import { FieldSession } from './session';

const NOTICE_MS = 5000;
/** Characters of the field's text each side of an issue that its card's preview gets (it shows up to 6 words). */
const PREVIEW_CHARS = 100;
/** Shown when the badge's click couldn't open the side panel. */
export const OPEN_PANEL_NOTICE = 'Open the full panel from the EngLint icon in the toolbar.';
/** A selection settles this long before the bar follows it (drags and shift-arrows fire many events). */
export const SELECTION_DEBOUNCE_MS = 150;
/**
 * A field whose layer the page kept taking out (RenderResult `unstable`) draws in the fixed layer this
 * long, or until its next focus, then tries its own layer again. A page still at it gets held again.
 */
export const LAYER_RETRY_MS = 30_000;
/**
 * While a selection sits in a focused field, the frame says so this often (fieldFocused): a worker that slept
 * since gets it back before the shortcut (background/menus.ts), and the messages keep it awake meanwhile.
 */
export const FOCUS_HEARTBEAT_MS = 10_000;
/** The badge sits this far in from the focused field's bottom-right corner, px, unless the host says otherwise. */
export const BADGE_INSET = 6;
/** More inset on both axes for a resizable field, so the badge leaves its resize grip alone. */
export const RESIZE_GRIP = 16;
/** Keys that move the caret: on keyup, a caret inside an issue opens its card (see FieldHost.openAtCaret). */
export const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export interface Field {
  el: Element;
  fieldId: string;
  adapter: EditorAdapter;
  session: FieldSession;
  renderSeq: number;
  sentKey: string; // last issuesUpdated sent, to skip identical ones (the session emits per keystroke)
  /** Where the last render drew: the field layer's anchor (overlay/anchor.ts), or null for the fixed layer. */
  anchor: Element | null;
  /** The field layer couldn't be rendered at the anchor: this field draws in the fixed layer from now on. */
  fixedLayer: boolean;
  /**
   * The page kept taking the field's layer out: it draws in the fixed layer until this timer (LAYER_RETRY_MS)
   * or its next focus tries the layer again. Null when not held.
   */
  layerHeld: number | null;
}

export interface PageSettings {
  mode(): Mode;
  /** The writer's suggestion settings for `mode`: its family toggles, its rules, and the dictionary. */
  policy(mode: Mode): SuggestionPolicy;
  /** Calls `onChange()` whenever the family toggles, the rules, the dictionary or "Instant local checks" change. */
  watchPolicy(onChange: () => void): void;
  /** Calls `onChange(enabled)` whenever the site is switched on or off; returns whether it is on now. */
  watchEnabled(onChange: (enabled: boolean) => void): boolean;
  /** "Show the EngLint badge". */
  showBadge(): boolean;
  /** Calls `onChange()` whenever that switch changes. */
  watchBadge(onChange: () => void): void;
  /** "Instant local checks": the local Harper checker is asked and shown. */
  localChecks(): boolean;
}

/**
 * This host's settings, kept current until the context is invalidated. In a frame, `topHost` is the tab's
 * top-level host: switching that site off switches this frame off too.
 */
export async function loadPageSettings(ctx: ContentScriptContext, host: string, topHost?: string | null): Promise<PageSettings> {
  const [siteModes, essaySites, disabledSites, families, rules, dictionary, showBadge, localChecks] = await Promise.all([
    siteModesItem.getValue(),
    essaySitesItem.getValue(),
    disabledSitesItem.getValue(),
    readSuggestionFamilies(),
    rulesItem.getValue(),
    dictionaryItem.getValue(),
    showBadgeItem.getValue(),
    localChecksItem.getValue(),
  ]);
  const settings = { siteModes, essaySites, disabledSites, families, rules, dictionary, showBadge, localChecks };
  const enabledListeners = new Set<(enabled: boolean) => void>();
  const policyListeners = new Set<() => void>();
  const badgeListeners = new Set<() => void>();
  // The policy is read on every selection (each keystroke): built once per mode, until a setting changes.
  const policies = new Map<Mode, SuggestionPolicy>();
  const policyChanged = (apply: () => void) => {
    apply();
    policies.clear();
    policyListeners.forEach((cb) => cb());
  };
  const unwatch = [
    siteModesItem.watch((v) => (settings.siteModes = v)),
    essaySitesItem.watch((v) => (settings.essaySites = v)),
    disabledSitesItem.watch((list) => {
      settings.disabledSites = list;
      const enabled = !isPageDisabled(list, host, topHost);
      enabledListeners.forEach((cb) => cb(enabled));
    }),
    // Removed from storage: readSuggestionFamilies migrates again (a saved clarityByMode, else the defaults) and
    // writes the result, which runs this again.
    suggestionFamiliesByModeItem.watch((v) =>
      v ? policyChanged(() => (settings.families = v)) : void readSuggestionFamilies().catch(() => {}),
    ),
    rulesItem.watch((v) => policyChanged(() => (settings.rules = v))),
    dictionaryItem.watch((v) => policyChanged(() => (settings.dictionary = v))),
    // Off hides Harper's held issues at once; on asks it about the text (FieldSession.refilter).
    localChecksItem.watch((v) => policyChanged(() => (settings.localChecks = v))),
    showBadgeItem.watch((v) => {
      settings.showBadge = v;
      badgeListeners.forEach((cb) => cb());
    }),
  ];
  ctx.onInvalidated(() => {
    unwatch.forEach((u) => u());
    enabledListeners.clear();
    policyListeners.clear();
    badgeListeners.clear();
  });
  const familiesOf = (mode: Mode): FamilyToggles => ({ ...(settings.families[mode] ?? defaultFamilies(mode)) });
  return {
    mode: () => effectiveMode(host, settings.siteModes, settings.essaySites),
    policy(mode) {
      let policy = policies.get(mode);
      if (!policy) {
        policy = {
          mode,
          families: familiesOf(mode),
          rules: new Set(settings.rules.filter((r) => r.mode === mode).map((r) => r.kind)),
          dictionary: new Set(settings.dictionary.map(dictionaryForm)),
        };
        policies.set(mode, policy);
      }
      return policy;
    },
    watchPolicy(onChange) {
      policyListeners.add(onChange);
    },
    watchEnabled(onChange) {
      enabledListeners.add(onChange);
      return !isPageDisabled(settings.disabledSites, host, topHost);
    },
    showBadge: () => settings.showBadge,
    watchBadge(onChange) {
      badgeListeners.add(onChange);
    },
    localChecks: () => settings.localChecks,
  };
}

export interface FieldHostOptions {
  host: string;
  settings: PageSettings;
  /** Whether focus is in the field (the panel follows focus). Default: the deep active element is inside it. */
  isFocused?(el: Element): boolean;
  /** Called after a field detached: its element left, its adapter died, or detach()/detachAll() was called. */
  onDetach?(f: Field): void;
  /** How far in from the field's corner the badge sits, px (default BADGE_INSET; Docs' editor: 12). */
  badgeInset?: number;
}

export interface FieldHost {
  /** The field of `el`, attaching one (with `create`'s adapter) if there is none. */
  attach(el: Element, create: (fieldId: string) => EditorAdapter, fieldId?: string): Field;
  get(el: Element): Field | undefined;
  detach(f: Field): void;
  detachAll(): void;
  /** Sends the field's issues to the background; identical consecutive reports are skipped unless forced. */
  report(f: Field, force?: boolean): void;
  /** Opens the card of the issue the field's caret is inside, if any. */
  openAtCaret(f: Field): Promise<void>;
  /** The field gained focus: a layer held back after the page kept removing it is tried again now. */
  focused(f: Field): void;
  /** Closes the open card, if the overlay is mounted (never mounts it). */
  closeCard(): void;
  /** Closes the undo chip, if the overlay is mounted (never mounts it). */
  closeUndo(): void;
  /**
   * The selection may have changed (a key or the pointer where this document can't see it, such as Docs'
   * text-event iframe): the bar follows it shortly.
   */
  selectionChanged(): void;
  /** Hides the selection bar now; `stay`: it stays hidden until the selection changes (Esc). */
  hideSelection(stay?: boolean): void;
  /**
   * Focus may have moved where this document's focus events can't tell (Docs' text-event iframe): the
   * background hears whether this frame still has a focused field, once focus has landed.
   */
  focusChanged(): void;
  /** The overlay, mounted on first use. */
  overlay(): Promise<OverlayHandle>;
  /** The attached field that has focus, if any. */
  focusedField(): Field | undefined;
  /**
   * Opens the tools popover on `range` of `f` (the right-click menu, the shortcut, the selection bar),
   * mounting the overlay first if needed. The popover takes the bar's place. False when `f` left meanwhile.
   */
  openTools(f: Field, range: ToolsRange, request?: OpenToolsRequest): Promise<boolean>;
  /** A notice that hides itself after a few seconds. */
  notify(text: string): Promise<void>;
}

/** Random per content-script instance, so field ids stay unique across a tab's frames. */
function frameToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
}

/** The user can be at this frame's field now: its tab is shown and its window has focus. */
const userHere = () => document.visibilityState === 'visible' && document.hasFocus();

const containsFocus = (el: Element) => {
  const active = deepActiveElement(document);
  return !!active && el.contains(active); // focus may sit on an element inside an editing host
};

/** The element's client box in the viewport: inside its border and scrollbars (its border box when it has none, inline). */
function clientBox(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if (el.clientWidth === 0 && el.clientHeight === 0) return r;
  return new DOMRect(r.left + el.clientLeft, r.top + el.clientTop, el.clientWidth, el.clientHeight);
}

/** The part of `box` inside `clip` (empty when they don't meet). */
function within(box: DOMRect, clip: { left: number; top: number; right: number; bottom: number }): DOMRect {
  const left = Math.max(box.left, clip.left);
  const top = Math.max(box.top, clip.top);
  return new DOMRect(left, top, Math.max(0, Math.min(box.right, clip.right) - left), Math.max(0, Math.min(box.bottom, clip.bottom) - top));
}

/** Where the caret's line was measured: relative to the field's client box, at the field's own scroll then. */
interface CaretLine {
  top: number;
  height: number;
  scrollTop: number;
}

/**
 * The caret's line: that of the character after the caret, or of the one before when that has no box (a line
 * break, the end of the text); with a range selected, the line where it ends (where the selection button
 * sits). Null with neither, or nothing there to measure (an empty line). It asks the adapter for the caret and
 * for rects, never for the whole text, but in Docs each of those reads the text through the bridge (caret() to
 * clamp it, each rectsFor to find the lines): two or three round trips. So it runs only when the caret may have
 * moved, and one at a time (see remeasureCaret).
 */
async function caretLine(adapter: EditorAdapter): Promise<CaretLine | null> {
  const at = await adapter.caret?.();
  let rect: DOMRect | undefined;
  if (at !== null && at !== undefined) {
    rect = (await adapter.rectsFor(at, at + 1))[0] ?? (at > 0 ? (await adapter.rectsFor(at - 1, at)).at(-1) : undefined);
  } else {
    const range = await adapter.selection?.();
    if (range) rect = (await adapter.rectsFor(range.start, range.end)).at(-1);
  }
  if (!rect) return null;
  const el = adapter.element;
  return { top: rect.top - clientBox(el).top, height: rect.height, scrollTop: el.scrollTop };
}

export function createFieldHost(ctx: ContentScriptContext, opts: FieldHostOptions): FieldHost {
  const { host, settings } = opts;
  const isFocused = opts.isFocused ?? containsFocus;
  const fields = new Map<Element, Field>();
  const ids = new WeakMap<Element, string>();
  const token = frameToken();
  let nextId = 0;
  const byId = (fieldId: string) => [...fields.values()].find((f) => f.fieldId === fieldId);

  // ---- overlay (mounted on the first underline or badge, so pages without issues or a focused field get no host element) ----
  let overlay: Promise<OverlayHandle> | null = null;
  let mounted: OverlayHandle | null = null; // the same, once mounted
  // The tools popover, created with the overlay. It opens through openTools only.
  let tools: ToolsController | null = null;
  const getOverlay = () =>
    (overlay ??= mountOverlay(ctx).then((o) => {
      mounted = o;
      tools = createToolsController({
        overlay: o,
        host,
        getMode: settings.mode,
        send: sendMessage,
        // Closed with nothing applied: the bar comes back for the same selection, to try another action.
        onClosedByUser: () => {
          dismissedKey = null;
          selectionChanged();
        },
      });
      o.onAccept((fieldId, issueId) => {
        const f = byId(fieldId);
        if (f) void accept(f, issueId);
      });
      o.onRewrite((fieldId, issueId) => {
        const f = byId(fieldId);
        if (f) void rewriteSentence(f, issueId);
      });
      o.onDismiss((fieldId, issueId, at, side) => {
        const f = byId(fieldId);
        if (!f) return;
        const issue = f.session.issues().find((i) => i.id === issueId); // gone from the session once dismissed
        void f.session.dismiss(issueId);
        if (issue) void offerAfterDismissal(o, f, issue, at, side);
      });
      // "Stop suggesting" / "Add to dictionary": the write re-filters every field (watchPolicy below).
      o.cardActions((fieldId, issue) => {
        const action = cardAction(issue, settings.mode());
        if (!action) return null;
        return {
          label: action.label,
          run: (at, side) =>
            void action
              .apply()
              .then(({ text, undo }) => o.showUndo(fieldId, at, text, () => void undo().catch(() => {}), side))
              .catch(() => {}), // storage refused: nothing changed, so no chip
        };
      });
      o.onLayerLost((fieldId) => {
        const f = byId(fieldId);
        if (f) scheduleRender(f); // puts the layer back
      });
      // The click is the user's (the badge checks isTrusted): the background opens the panel within its gesture.
      // A browser may refuse the relayed gesture (or have no side panel): then the click says where the panel is.
      o.onBadgeClick(
        () =>
          void sendMessage('openPanel', undefined).then(
            (reply) => {
              if (!reply?.opened) void notify(OPEN_PANEL_NOTICE);
            },
            () => void notify(OPEN_PANEL_NOTICE),
          ),
      );
      return o;
    }));

  /** After Dismiss: counts it, and shows the offer it leads to (stop a kind, add a name) where the card was, if any. */
  async function offerAfterDismissal(o: OverlayHandle, f: Field, issue: LocatedIssue, at: DOMRect, side: CardSide) {
    try {
      const text = await f.adapter.getText();
      // Typing since the check can move the issue: then the word's place (and the dictionary offer) is unknown.
      const offer = await offerAfterDismiss(issue, settings.mode(), text.slice(issue.start, issue.end) === issue.original ? text.slice(0, issue.start) : null);
      if (!offer) return;
      const answer = (apply: boolean) => () =>
        void (apply
          ? offer.accept().then(({ text, undo }) => o.showUndo(f.fieldId, at, text, () => void undo().catch(() => {}), side))
          : offer.decline()
        ).catch(() => {}); // storage refused: nothing changed, so no chip
      o.showOffer(f.fieldId, at, offer.question, offer.yes, answer(true), answer(false), side);
    } catch {
      // no text or no storage: no offer
    }
  }

  let noticeTimer: number | undefined;
  async function notify(text: string) {
    try {
      const o = await getOverlay();
      o.showNotice(text);
      clearTimeout(noticeTimer);
      noticeTimer = ctx.setTimeout(() => o.showNotice(null), NOTICE_MS);
    } catch {
      // no overlay, no notice
    }
  }

  async function accept(f: Field, issueId: string): Promise<boolean> {
    const issue = f.session.issues().find((i) => i.id === issueId);
    const flash = mounted?.armFlash(f.fieldId, issueId); // its rects now: the fix moves the text
    const ok = await f.session.accept(issueId);
    if (ok) flash?.();
    if (!ok && issue && issue.replacement !== null) {
      let copied = false;
      if (issue.replacement !== '') {
        try {
          await navigator.clipboard.writeText(issue.replacement);
          copied = true;
        } catch {
          // clipboard refused (no focus or permission)
        }
      }
      void notify(copied ? APPLY_FAILED_COPIED : APPLY_FAILED);
    }
    return ok;
  }

  /**
   * A card's "Rewrite sentence" (a note's primary, or in the "⋯" menu): the tools popover opens on the issue's sentence,
   * Rewrite first.
   */
  async function rewriteSentence(f: Field, issueId: string): Promise<boolean> {
    const issue = f.session.issues().find((i) => i.id === issueId);
    if (!issue) return false;
    try {
      const text = await f.adapter.getText();
      if (text.slice(issue.start, issue.end) !== issue.original) {
        void notify(TOOLS_COPY.changed); // typed since the check
        return false;
      }
      const sentence = sentenceAround(text, issue.start, issue.end);
      const range = trimRange(text, sentence.start, sentence.end);
      if (!range) return false;
      const chosen: ToolsRange = { ...range, text: text.slice(range.start, range.end) };
      if (chosen.text.length > MAX_SELECTION_CHARS) chosen.tooLong = true;
      return await openTools(f, chosen, { kind: 'preset', presetId: 'rewrite', focus: focusFor(issue) });
    } catch {
      return false;
    }
  }

  // ---- the side panel's Chat: the field's text before each message, and a chat edit's Apply ----
  // Neither reads more than the adapter's text, selection and caret, and nothing here logs the text.

  async function fieldText(f: Field): Promise<{ ok: boolean; text?: string; focus?: ChatFocus; mode?: Mode }> {
    try {
      const text = await f.adapter.getText();
      const range = await f.adapter.selection?.();
      const caret = range ? null : await f.adapter.caret?.();
      // A selection or caret read a moment ago may lie past the end of a text that shrank since.
      const inText = (n: number) => Math.min(Math.max(0, n), text.length);
      let focus: ChatFocus = null;
      if (range) focus = { start: inText(range.start), end: inText(range.end) };
      else if (typeof caret === 'number') focus = { start: inText(caret), end: inText(caret) };
      return { ok: true, text, focus, mode: settings.mode() };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Checks the edit again on the text now (the panel judged an older read) and puts the replacement, in the
   * text's own curled quotes, where the one occurrence is. The adapter reads the write back, as for a card fix.
   */
  async function applyEdit(f: Field, original: string, replacement: string): Promise<ApplyEditResult> {
    try {
      const text = await f.adapter.getText();
      const check = canApply(text, { original, replacement }, settings.mode());
      if (check !== 'ok') return check === 'missing' ? 'changed' : check;
      const at = locateEdit(text, original);
      if (typeof at === 'string') return 'changed'; // not reached: canApply found it once
      const next = carryTypography(text.slice(at.start, at.end), replacement);
      if (!(await f.adapter.replace(at.start, at.end, next))) return 'failed';
      void flashText(f, at.start, at.start + next.length);
      return 'applied';
    } catch {
      return 'failed';
    }
  }

  /** Selects the first place `quote` is in the field's text, redraws for the scroll, and flashes it. */
  async function revealText(f: Field, quote: string): Promise<{ found: boolean }> {
    try {
      const at = findQuote(await f.adapter.getText(), quote);
      if (!at) return { found: false };
      await f.adapter.select(at.start, at.end);
      await renderField(f); // selecting may scroll the passage into view; the underlines need their new rects
      void flashText(f, at.start, at.end);
      return { found: true };
    } catch {
      return { found: false };
    }
  }

  /** The accept flash over a range of the field's text. */
  async function flashText(f: Field, start: number, end: number) {
    try {
      const o = await getOverlay();
      o.flash(f.fieldId, await f.adapter.rectsFor(start, end));
    } catch {
      // no overlay or no rects: no flash
    }
  }

  // ---- the selection bar: the focused field's selection, after a settled selection event ----
  // FieldHost alone shows and hides the bar (`shown`). A pick on it, the menu and the shortcut all open the
  // tools popover through openTools, which hides it; while that is open (the controller knows), none is shown.
  let selTimer: number | undefined;
  let selSeq = 0; // a newer refresh or a hide makes an older one stop
  let shown: { field: Field; key: string } | null = null;
  // Esc on the bar, or the popover opened on it: hidden until the selection changes (or the popover closes unapplied).
  let dismissedKey: string | null = null;
  const hideButton = () => {
    selSeq++;
    clearTimeout(selTimer);
    shown = null;
    mounted?.showSelectionBar(null);
  };
  function hideSelection(stay = false) {
    if (stay && shown) dismissedKey = shown.key;
    hideButton();
  }
  function selectionChanged() {
    clearTimeout(selTimer);
    selTimer = ctx.setTimeout(() => {
      void refreshSelection();
      scheduleBadge(true); // the caret may have moved onto, or off, the badge's line
    }, SELECTION_DEBOUNCE_MS);
  }
  const focusedField = () => [...fields.values()].find((each) => isFocused(each.el));

  // ---- fieldFocused: the shortcut's map in the background knows whether this frame has a focused field ----
  // Sent on each change (focus, blur, a field attaching or leaving), and forced while a selection sits in a
  // focused field: when it settles, and every FOCUS_HEARTBEAT_MS after, but only while the user can be
  // there: a hidden tab or an unfocused window never keeps the worker awake.
  let sentFocus = false; // what the background last heard from this frame; at first it knows nothing
  let heartbeat: number | undefined;
  function reportFocus(force = false) {
    const focused = focusedField() !== undefined;
    if (focused === sentFocus && !(force && focused)) return;
    sentFocus = focused;
    sendMessage('fieldFocused', { focused }).catch(() => {});
  }
  const focusChanged = () =>
    void ctx.setTimeout(() => {
      reportFocus();
      scheduleBadge(true);
    }, 0);
  function keepFocusWarm(on: boolean) {
    if (!on) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    } else {
      heartbeat ??= ctx.setInterval(() => {
        if (!focusedField()) keepFocusWarm(false);
        else if (userHere()) reportFocus(true);
      }, FOCUS_HEARTBEAT_MS);
    }
  }
  for (const type of ['focusin', 'focusout']) ctx.addEventListener(document, type, focusChanged, { capture: true });
  ctx.onInvalidated(() => keepFocusWarm(false));

  async function openTools(f: Field, range: ToolsRange, request?: OpenToolsRequest): Promise<boolean> {
    if (!tools) await getOverlay(); // the menu or shortcut may come before anything was drawn
    if (!tools || fields.get(f.el) !== f) return false;
    hideButton();
    dismissedKey = `${f.fieldId}:${range.start}:${range.end}`; // after an apply, not back for the same words
    tools.open(f, range, request);
    return true;
  }
  async function refreshSelection() {
    const seq = ++selSeq;
    const f = focusedField();
    let selection: FieldSelection | null = null;
    let anchor: DOMRect | null = null;
    try {
      selection = f ? await readFieldSelection(f.adapter) : null;
      if (f && selection) {
        // The highlight as the editor painted it, where it can be read; otherwise the range, measured.
        const painted = await Promise.resolve()
          .then(() => f.adapter.selectionRects?.())
          .catch(() => null);
        // A painted box counts only on the range's last line: an older highlight may still be recorded.
        const lines = await f.adapter.rectsFor(selection.start, selection.end);
        const measured = lines.at(-1);
        const last = painted?.at(-1);
        const sameLine = last && measured && last.top < measured.bottom && last.bottom > measured.top;
        // The bar sits above the whole selection: its measured lines, with the last line as painted when it is.
        anchor = boxAround(last && (sameLine || !measured) ? [...lines, last] : lines);
      }
    } catch {
      // no selection to show
    }
    if (seq !== selSeq) return;
    keepFocusWarm(!!f && !!selection);
    if (f && selection) reportFocus(true); // a worker that slept learns it again before the shortcut
    const key = f && selection ? `${f.fieldId}:${selection.start}:${selection.end}` : null;
    if (!key) dismissedKey = null;
    if (!f || !selection || !anchor || !key || key === dismissedKey || tools?.isOpen()) {
      shown = null;
      mounted?.showSelectionBar(null);
      return;
    }
    const o = await getOverlay();
    if (seq !== selSeq || tools?.isOpen()) return;
    shown = { field: f, key };
    const chosen = selection;
    const tooLong = overLimit(chosen.text);
    o.showSelectionBar({
      at: anchor,
      mode: settings.mode(),
      singleWord: isSingleWord(chosen.text),
      ...(tooLong ? { tooLong } : {}),
      onPick: (run) => void openTools(f, chosen, run),
    });
  }
  for (const type of ['selectionchange', 'mouseup', 'keyup']) ctx.addEventListener(document, type, selectionChanged, { capture: true });
  ctx.addEventListener(document, 'keydown', (e) => e.key === 'Escape' && hideSelection(true), { capture: true });
  ctx.addEventListener(document, 'input', () => hideSelection(), { capture: true });
  ctx.onInvalidated(() => clearTimeout(selTimer));

  // A family toggle, rule or dictionary word changed (here, in another frame, or in Options): the held
  // results are selected again, with no request.
  settings.watchPolicy(() => {
    for (const f of fields.values()) f.session.refilter();
  });

  // ---- reporting and drawing ----
  function report(f: Field, force = false, issues: LocatedIssue[] = f.session.issues(), status: CheckStatus = f.session.status()) {
    const focused = isFocused(f.el);
    const m = settings.mode();
    const key = `${status}|${m}|${focused}|${issues.map((i) => i.id).join(',')}`;
    if (!force && key === f.sentKey) return;
    f.sentKey = key;
    sendMessage('issuesUpdated', { fieldId: f.fieldId, host, mode: m, status, focused, issues }).catch(() => {});
  }

  const dirty = new Set<Field>();
  let frame = 0;
  function scheduleRender(f: Field) {
    dirty.add(f);
    scheduleBadge(); // whatever moved the text may have moved the field
    if (!frame) {
      frame = ctx.requestAnimationFrame(() => {
        frame = 0;
        const batch = [...dirty];
        dirty.clear();
        for (const each of batch) void renderField(each);
      });
    }
  }

  /** Holds the field in the fixed layer (its own layer was `unstable`) until the retry time or a focus. */
  function holdLayer(f: Field) {
    f.layerHeld = ctx.setTimeout(() => releaseLayer(f), LAYER_RETRY_MS);
  }
  /** Ends a hold: the next render tries the field's own layer again. */
  function releaseLayer(f: Field) {
    if (f.layerHeld === null) return;
    clearTimeout(f.layerHeld);
    f.layerHeld = null;
    if (fields.get(f.el) === f) scheduleRender(f);
  }

  // A native field's anchor resizing (Docs' editor when a side panel opens; the document growing as an
  // image above the field loads) moves the text without a scroll or a field resize: re-measure then. Only
  // while the field has issues: on pages whose height keeps changing (feeds, streaming replies), a field
  // with nothing drawn must not re-render on each change.
  const anchorWatches = new Map<Field, { observer: ResizeObserver; el: Element | null }>();
  function watchAnchor(f: Field, anchor: Element | null) {
    if (typeof ResizeObserver === 'undefined') return;
    let watch = anchorWatches.get(f);
    if (watch?.el === anchor) return;
    if (!watch) anchorWatches.set(f, (watch = { observer: new ResizeObserver(() => scheduleRender(f)), el: null }));
    if (watch.el) watch.observer.unobserve(watch.el);
    if (anchor) watch.observer.observe(anchor);
    watch.el = anchor;
  }

  async function renderField(f: Field) {
    try {
      if (fields.get(f.el) !== f) return;
      if (!f.adapter.isAlive()) return detach(f);
      const seq = ++f.renderSeq;
      const issues = f.session.issues();
      if (!overlay && issues.length === 0) return;
      const o = await getOverlay();
      // The field's own layer, anchored in the page's scrolled content; null: the fixed layer.
      const anchor = f.fixedLayer || f.layerHeld !== null ? null : findLayerAnchor(f.adapter.element, f.adapter.scrollRoot?.());
      const opts = anchor ? { clipUntil: anchor } : undefined;
      const ranges = issues.map(({ start, end }) => ({ start, end }));
      // One mirror layout for all issues when the adapter can batch.
      const rects = f.adapter.rectsForMany
        ? await f.adapter.rectsForMany(ranges, opts)
        : await Promise.all(ranges.map((r) => f.adapter.rectsFor(r.start, r.end, opts)));
      if (seq !== f.renderSeq || fields.get(f.el) !== f) return; // superseded, or the field is gone
      // No await from the rect read to here: the layer's origin is read in the same frame.
      const text = f.session.text(); // the text these issues' offsets slice
      const items = issues.map((issue, i) => ({
        issue,
        rects: rects[i] ?? [],
        context: contextAround(text, issue.start, issue.end, PREVIEW_CHARS),
      }));
      const drawn = o.render(f.fieldId, items, {
        field: f.adapter.element,
        anchor,
        paint: f.adapter.paintRoot?.(),
        surface: f.adapter.hitRegion?.(),
      });
      if (drawn === 'unrendered' || drawn === 'unstable') {
        if (drawn === 'unrendered') f.fixedLayer = true; // for good: there's no place for its layer
        else holdLayer(f); // for now: the page keeps taking it out
        f.anchor = null;
        watchAnchor(f, null);
        scheduleRender(f);
        return;
      }
      f.anchor = anchor;
      watchAnchor(f, issues.length > 0 ? anchor : null);
    } catch {
      // a failed frame is redrawn on the next update or layout change
    }
  }

  // ---- the badge: the focused field's counts and status, in its corner of the fixed overlay ----
  // Redrawn on the next frame after anything that changes what it shows or where it goes: issues, status, a
  // check in flight, focus, the switch, scrolls and resizes. The caret's line is measured again, at most once a
  // frame and one measure at a time, only when the caret may have moved (an edit, a settled selection, focus, a
  // resize); a scroll, or Docs redrawing its lines, reuses it, shifted by the field's own scroll since, so neither
  // makes the badge read the text.
  const badgeInset = opts.badgeInset ?? BADGE_INSET;
  let badgeOwner: Field | null = null; // whose badge the overlay shows
  let badgeFrame = 0;
  let caretWanted = false; // a measure is due on the next frame (once, however many asked)
  let caretMemo: (CaretLine & { field: Field }) | null = null;
  // One measure at a time (in Docs each is several bridge round trips): asks while one is on its way make one more
  // after it. Every adapter's caret and rects settle (Docs' bridge times out), so this never stays set.
  let caretMeasuring = false;
  let caretAgain = false;
  // Only while this window has focus: a frame the user left keeps its activeElement, and must not keep a badge.
  const badgeField = () => (settings.showBadge() && document.hasFocus() ? focusedField() : undefined);
  const resizable = (el: Element) => {
    const resize = getComputedStyle(el).resize;
    return !!resize && resize !== 'none';
  };

  function scheduleBadge(measureCaret = false) {
    if (measureCaret) caretWanted = true;
    if (badgeFrame) return;
    badgeFrame = ctx.requestAnimationFrame(() => {
      badgeFrame = 0;
      if (caretWanted) {
        caretWanted = false;
        remeasureCaret(); // its answer draws again
      }
      void drawBadge();
    });
  }

  function remeasureCaret() {
    if (caretMeasuring) {
      caretAgain = true;
      return;
    }
    const f = badgeField();
    if (!f) {
      caretMemo = null;
      return;
    }
    caretMeasuring = true;
    void caretLine(f.adapter)
      .catch(() => null)
      .then((line) => {
        caretMeasuring = false;
        caretMemo = line && { ...line, field: f };
        const again = caretAgain;
        caretAgain = false;
        scheduleBadge(again); // draws its answer; what was asked meanwhile is measured on that frame
      });
  }

  function hideBadge() {
    if (!badgeOwner) return;
    mounted?.setBadge(badgeOwner.fieldId, null);
    badgeOwner = null;
  }

  async function drawBadge() {
    try {
      const f = badgeField();
      if (!f || !f.adapter.isAlive()) return hideBadge();
      const o = mounted ?? (await getOverlay());
      if (fields.get(f.el) !== f || badgeField() !== f) return; // changed while the overlay mounted: a later frame draws
      if (badgeOwner && badgeOwner !== f) o.setBadge(badgeOwner.fieldId, null);
      badgeOwner = f;
      // No await from here: the boxes are read in the frame the badge is placed in.
      const el = f.adapter.element;
      const box = clientBox(el);
      const line = caretMemo?.field === f ? caretMemo : null;
      const caret = line ? new DOMRect(box.left, box.top + line.top - (el.scrollTop - line.scrollTop), box.width, line.height) : null;
      const issues = f.session.issues();
      const errors = issues.filter((i) => i.severity === 'error').length;
      o.setBadge(f.fieldId, {
        anchor: within(box, visibleBox(el)),
        errors,
        suggestions: issues.length - errors,
        busy: f.session.busy(),
        status: f.session.status(),
        checked: f.session.checked(),
        family: topFamily(issues),
        caret,
        field: el,
        inset: badgeInset + (resizable(el) ? RESIZE_GRIP : 0),
      });
    } catch {
      // a failed frame is redrawn on the next change
    }
  }
  settings.watchBadge(() => scheduleBadge(true));
  for (const type of ['focus', 'blur']) ctx.addEventListener(window, type, () => scheduleBadge(true));

  // ---- fields ----
  function attach(el: Element, create: (fieldId: string) => EditorAdapter, explicitId?: string): Field {
    const existing = fields.get(el);
    if (existing) return existing;
    let fieldId = explicitId ?? ids.get(el);
    if (!fieldId) ids.set(el, (fieldId = `f-${token}-${++nextId}`));
    const adapter = create(fieldId);
    const session = new FieldSession(adapter, {
      host,
      getMode: settings.mode,
      policy: settings.policy,
      send: (req) => sendMessage('check', req),
      sendHarper: (req) => sendMessage('harperCheck', req),
      localChecks: settings.localChecks,
      persistDismissal: (key) => sendMessage('dismiss', key),
      onUpdate: (issues, status) => {
        report(f, false, issues, status);
        scheduleRender(f);
        scheduleBadge(true); // an edit moves the caret
      },
      onBusyChange: () => scheduleBadge(),
    });
    const f: Field = { el, fieldId, adapter, session, renderSeq: 0, sentKey: '', anchor: null, fixedLayer: false, layerHeld: null };
    // removed by adapter.dispose()
    adapter.onLayoutChange((scrolled, redrawn) => {
      // The badge is fixed in the viewport too: it follows every scroll; a resize may rewrap the caret's line. The
      // editor redrawing its lines alone (Docs' tiles) doesn't move the caret: an edit that did reaches onUpdate.
      scheduleBadge(!scrolled && !redrawn);
      // The button is fixed in the viewport: a scroll that moves this field's text leaves it behind.
      if (scrolled && shown?.field === f && scrollMovesText(scrolled, adapter.element)) hideButton();
      // The page scrolled the underlines along with the text: no re-measure, unless the field moved within its
      // anchor since the last render (content above it grew); the drift probe tells.
      if (scrolled && f.anchor && scrollMoves(scrolled, f.anchor)) {
        if (mounted?.drifted(f.fieldId)) scheduleRender(f);
        return;
      }
      scheduleRender(f);
    });
    fields.set(el, f);
    listenToPanel();
    session.start();
    focusChanged(); // Docs attaches after its gate, often with focus already inside
    return f;
  }

  function detach(f: Field) {
    if (fields.get(f.el) !== f) return;
    fields.delete(f.el);
    dirty.delete(f);
    if (shown?.field === f) hideButton();
    if (tools?.isOpen(f)) tools.close(); // an answer still on its way is dropped
    focusChanged(); // the heartbeat stops itself once no field has focus
    f.session.dispose();
    anchorWatches.get(f)?.observer.disconnect();
    anchorWatches.delete(f);
    if (f.layerHeld !== null) clearTimeout(f.layerHeld);
    f.layerHeld = null;
    if (badgeOwner === f) hideBadge();
    if (caretMemo?.field === f) caretMemo = null;
    overlay?.then((o) => o.clear(f.fieldId)).catch(() => {});
    sendMessage('issuesUpdated', {
      fieldId: f.fieldId,
      host,
      mode: settings.mode(),
      status: f.session.status(),
      focused: false,
      issues: [],
      removed: true,
    }).catch(() => {});
    opts.onDetach?.(f);
  }

  // Keyboard "focus" on an issue: the caret moved inside an underlined span.
  async function openAtCaret(f: Field) {
    try {
      const caret = (await f.adapter.caret?.()) ?? null;
      if (caret === null || fields.get(f.el) !== f) return;
      const hit = f.session.issues().find((i) => i.start < caret && caret < i.end);
      if (hit) (await overlay)?.open(f.fieldId, hit.id);
    } catch {
      // no caret, no card
    }
  }

  // ---- panel / popup requests (registered once this frame has a field) ----
  let listening = false;
  function listenToPanel() {
    if (listening) return;
    listening = true;
    const offs = [
      onMessage('applyFix', async ({ data }) => {
        const f = byId(data.fieldId);
        return { ok: f ? await accept(f, data.issueId) : false };
      }),
      onMessage('rewriteSentence', async ({ data }) => {
        const f = byId(data.fieldId);
        return { opened: f ? await rewriteSentence(f, data.issueId) : false };
      }),
      onMessage('dismissIssue', async ({ data }) => {
        await byId(data.fieldId)?.session.dismiss(data.issueId);
      }),
      onMessage('acceptAllErrors', async ({ data }) => {
        return (await byId(data.fieldId)?.session.acceptAllErrors()) ?? { applied: 0, failed: 0 };
      }),
      onMessage('jumpTo', async ({ data }) => {
        const f = byId(data.fieldId);
        const issue = f?.session.issues().find((i) => i.id === data.issueId);
        if (!f || !issue) return;
        await f.adapter.select(issue.start, issue.end);
        await renderField(f); // selecting may scroll the issue into view; the card needs its new rects
        (await getOverlay()).open(f.fieldId, issue.id);
      }),
      onMessage('fieldText', async ({ data }) => {
        const f = byId(data.fieldId);
        return f ? fieldText(f) : { ok: false };
      }),
      onMessage('revealText', async ({ data }) => {
        const f = byId(data.fieldId);
        return f ? revealText(f, data.quote) : { found: false };
      }),
      onMessage('applyEdit', async ({ data }) => {
        const f = byId(data.fieldId);
        // A field that left took its text with it: the edit no longer applies.
        return { result: f ? await applyEdit(f, data.original, data.replacement) : 'changed' };
      }),
      // Sends whatever has no result yet and re-locates the rest (the background cache answers repeats).
      onMessage('recheckAll', () => {
        for (const f of fields.values()) void f.session.checkNow();
      }),
    ];
    ctx.onInvalidated(() => offs.forEach((off) => off()));
  }

  return {
    attach,
    get: (el) => fields.get(el),
    detach,
    detachAll: () => [...fields.values()].forEach(detach),
    report,
    openAtCaret,
    focused: releaseLayer,
    closeCard: () => void overlay?.then((o) => o.close()).catch(() => {}),
    closeUndo: () => void overlay?.then((o) => o.closeUndo()).catch(() => {}),
    selectionChanged,
    hideSelection,
    focusChanged,
    overlay: getOverlay,
    notify,
    focusedField,
    openTools,
  };
}
