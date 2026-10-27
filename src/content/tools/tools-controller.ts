// What the selection button opens: the tools popover's logic. It sends the rewrite and synonyms requests
// (in Essay mode, the critique first) and follow-up questions about their results, shows each answer through
// the overlay (ToolsPopover.tsx draws it), and applies a pick back into the field only while the selected text
// is still there. Late answers (after a close, a newer request or another open) are dropped. Nothing here logs
// page text or model output.
import { changesClaims } from '../../core/claims';
import { contextAround, sentenceAround, voiceSampleAround } from '../../core/context';
import {
  MAX_FOLLOW_UPS,
  MAX_QUESTION_CHARS,
  clip,
  shownAnswer,
  shownCritique,
  shownSynonyms,
  shownVariants,
  shownVoice,
} from '../../core/follow-up';
import { isVoice, presetsFor, type PresetId, type RewriteToolRequest, type ToolRequest } from '../../core/presets';
import type { CheckStatus, Mode } from '../../core/types';
import type { OpenToolsRequest, sendMessage } from '../../shared/messages';
import { providerInfoNow } from '../provider-info';
import { APPLY_FAILED, APPLY_FAILED_COPIED, toolStatusText } from '../../shared/status-text';
import type { Field } from '../field-host';
import { scrollMovesText } from '../overlay/anchor';
import type { OverlayHandle } from '../overlay/mount';

/**
 * Whether a Sound like me version (or a light fix or follow-up version after one) may be applied: it differs from the
 * selection and keeps every number, name, date and quote. Sentence openers may go or change at any sentence start.
 */
const voiceApplies = (original: string, version: string) =>
  version.trim() !== original.trim() && !changesClaims(original, version, { sentenceStarts: 'lenient' });

export type ToolsView =
  /** `focus: 'custom'`: the custom input takes focus instead of the first item ("Custom instruction…"). */
  | { phase: 'menu'; mode: Mode; focus?: 'custom' }
  | { phase: 'loading'; label: string }
  /**
   * `original`: the selected text, the light fix's diff is against it. `voice`: Sound like me's critique, whose
   * light fix applies only when `canApply` (`voiceApplies`: it differs from the selection and keeps every number,
   * name and quote).
   */
  | { phase: 'critique'; weakness: string; lightFix: string; original: string; voice?: true; canApply?: boolean }
  | { phase: 'variants'; variants: string[]; original: string }
  /**
   * Sound like me: the generic patterns found and the one version without them. `canApply`: the version keeps
   * every number, name and quote of `original` (core/claims.ts); otherwise it is offered to copy only.
   * `unchanged`: nothing generic was found and the passage came back as it was: nothing to apply.
   */
  | { phase: 'voice'; tells: string[]; final: string; original: string; canApply: boolean; unchanged?: true }
  | { phase: 'synonyms'; options: { text: string; nuance: string }[] }
  /**
   * A follow-up's answer: the message, then its versions as diffs against `original`. `exhausted`: this popover
   * has had all its follow-ups, so the box says to start a new request instead. `canApply`: after Sound like me,
   * whether each version may be applied (`voiceApplies`; the others are offered to copy only).
   */
  | { phase: 'answer'; message: string; variants: string[]; original: string; exhausted?: true; canApply?: boolean[] }
  /** `retry`: a failed request that Retry sends again (only for a status that may pass on its own). */
  | { phase: 'error'; text: string; retry?: boolean };

export interface ToolsHandlers {
  pick(r: ToolRequest): void;
  apply(text: string): void;
  /** Copies `text` (Sound like me's version when it can't be applied); resolves whether the clipboard took it. */
  copy(text: string): Promise<boolean>;
  /** From the Essay critique: the three versions for the same request. */
  showVariants(): void;
  retry(): void;
  /** A follow-up question about the result shown. */
  ask(question: string): void;
  /**
   * The user closed the popover. `returnFocus` (default true, Esc): focus and the selection go back to the
   * field. False: a click outside, which already put focus where it landed.
   */
  close(returnFocus?: boolean): void;
}

/** The selection the popover works on (tools/selection.ts readFieldSelection). */
export interface ToolsRange {
  start: number;
  end: number;
  text: string;
  /** Over the limit: the popover only says so, and sends nothing. */
  tooLong?: true;
}

export interface ToolsDeps {
  overlay: Pick<OverlayHandle, 'showTools' | 'flash'>;
  host: string;
  getMode(): Mode;
  send: typeof sendMessage;
}

export interface ToolsController {
  /**
   * Opens the popover on `range` (closing any other); with a request, sends it at once; with 'custom-prompt',
   * shows the menu with the custom input focused.
   */
  open(f: Field, range: ToolsRange, request?: OpenToolsRequest): void;
  /** Closes the popover, if open, and leaves focus where it is. */
  close(): void;
  /** Whether the popover is open (for `f`, when given). */
  isOpen(f?: Field): boolean;
  /**
   * Sends a follow-up question about the result shown, with the conversation so far, and shows the answer.
   * Nothing is sent before a result, for a blank question, or after MAX_FOLLOW_UPS answers (the view says so).
   */
  ask(question: string): Promise<void>;
}

/** The popover's own copy; the side panel's Tools use the same words. */
export const TOOLS_COPY = {
  tooLong: 'Select up to about 2,000 characters.',
  changed: 'The text changed. Select it again.',
  /** The menu (or a stale shortcut) where no field EngLint edits has focus: an <input>, say. */
  cantEdit: "EngLint can't edit this box. Select text in a text area or document.",
  siteOff: 'EngLint is off for this site.',
  copied: APPLY_FAILED_COPIED,
  notApplied: APPLY_FAILED,
  rewriting: 'Rewriting…',
  critiquing: 'Reading it over…',
  synonyms: 'Finding words…',
  answering: 'Thinking it over…',
  /** In place of the follow-up box once a popover has had all its follow-ups. */
  noMoreFollowUps: 'Start a new request for more.',
  /** A preset the page's mode doesn't offer (the right-click menu lists them all). */
  essayOnlyNot: "Expand isn't offered for essays.",
  /** Sound like me, beside a version that changes a claim: Copy only. */
  checkFacts: 'Check the facts: this version changes a number, name or quote.',
  /** After Sound like me's critique (Essay): its one version, in place of "Show 3 rewrites". */
  showVersion: 'Show the version',
} as const;

/** What a request asked for, kept so Retry can send it again. */
type Ask =
  | { kind: 'rewrite'; request: RewriteToolRequest; stage: 'critique' | 'variants' }
  | { kind: 'synonyms' }
  | { kind: 'followUp'; question: string };

interface Session {
  f: Field;
  range: ToolsRange;
  /** The selection's box in the viewport, measured once at open. */
  anchor: DOMRect | null;
  last: Ask | null;
  /** The view shown now. */
  view: ToolsView | null;
  /** The request whose results were shown: what follow-ups are about (null until a result is shown). */
  origin: RewriteToolRequest | { kind: 'synonyms' } | null;
  /** Each result shown for it, as text (the Essay critique, then the versions). */
  shown: string[];
  /** The follow-ups answered so far, oldest first. */
  history: { q: string; a: string }[];
  /** The error shown offers Retry. */
  retryable: boolean;
  applying: boolean;
  stopWatch(): void;
}

/** The box around every line of the selection; null when nothing of it is in view. */
function boxAround(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Statuses that may pass on their own, so Retry is offered. The cap, the key, credit and a switched-off site
 * are fixed outside the popover: no Retry.
 */
const RETRYABLE: ReadonlySet<CheckStatus> = new Set(['rate_limited', 'overloaded', 'offline', 'bad_response']);

function failed(status: CheckStatus): ToolsView {
  const shown = status === 'ok' ? 'bad_response' : status; // ok without its payload: an unusable answer
  const text = toolStatusText(shown, undefined, providerInfoNow()) ?? '';
  return RETRYABLE.has(shown) ? { phase: 'error', text, retry: true } : { phase: 'error', text };
}

/** Whether `mode` offers the preset. */
const offered = (id: PresetId, mode: Mode) => presetsFor(mode).some((p) => p.id === id);

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // no clipboard here, or no focus or permission
  }
}

export function createToolsController(deps: ToolsDeps): ToolsController {
  let session: Session | null = null;
  /** Bumped by every request, apply, open and close: an answer to anything older is dropped. */
  let token = 0;

  const handlers: ToolsHandlers = {
    pick: (r) => void pick(r),
    apply: (text) => void apply(text),
    copy: (text) => copyText(text),
    showVariants() {
      const last = session?.last;
      if (session && last?.kind === 'rewrite') void run(session, { ...last, stage: 'variants' });
    },
    retry() {
      if (session?.last && session.retryable) void run(session, session.last);
    },
    ask: (question) => void ask(question),
    close: (returnFocus = true) => close(returnFocus),
  };

  const show = (s: Session, view: ToolsView) => {
    if (session !== s) return;
    s.view = view;
    s.retryable = view.phase === 'error' && !!view.retry;
    deps.overlay.showTools(s.anchor, view, handlers);
  };

  function open(f: Field, range: ToolsRange, request?: OpenToolsRequest) {
    close(false);
    const s: Session = {
      f,
      range,
      anchor: null,
      last: null,
      view: null,
      origin: null,
      shown: [],
      history: [],
      retryable: false,
      applying: false,
      stopWatch: () => {},
    };
    session = s;
    token++;
    // The popover is fixed in the viewport: a scroll that moves the field's text leaves it behind.
    s.stopWatch = f.adapter.onLayoutChange((scrolled) => {
      if (session === s && !s.applying && scrolled && scrollMovesText(scrolled, f.adapter.element)) close(false);
    });
    void (async () => {
      let rects: DOMRect[] = [];
      try {
        rects = await f.adapter.rectsFor(range.start, range.end);
      } catch {
        // placed against the field instead
      }
      if (session !== s) return;
      s.anchor = boxAround(rects) ?? f.adapter.element.getBoundingClientRect();
      if (range.tooLong) show(s, { phase: 'error', text: TOOLS_COPY.tooLong });
      else if (request === 'custom-prompt') show(s, { phase: 'menu', mode: deps.getMode(), focus: 'custom' });
      else if (request) await pick(request);
      else show(s, { phase: 'menu', mode: deps.getMode() });
    })();
  }

  async function pick(r: ToolRequest) {
    const s = session;
    if (!s) return;
    if (r.kind === 'custom' && r.instruction.trim() === '') return;
    if (r.kind === 'preset' && !offered(r.presetId, deps.getMode())) return show(s, { phase: 'error', text: TOOLS_COPY.essayOnlyNot });
    // The Essay gate: a rewrite there starts with the critique; synonyms never do.
    const stage = deps.getMode() === 'essay' ? 'critique' : 'variants';
    await run(s, r.kind === 'synonyms' ? { kind: 'synonyms' } : { kind: 'rewrite', request: r, stage });
  }

  async function ask(question: string) {
    const s = session;
    const q = question.trim();
    if (!s || !s.origin || q === '') return;
    if (s.history.length >= MAX_FOLLOW_UPS) {
      if (s.view?.phase === 'answer') show(s, { ...s.view, exhausted: true });
      return;
    }
    await run(s, { kind: 'followUp', question: q.slice(0, MAX_QUESTION_CHARS) });
  }

  /** Sends `ask` for the session's range against the field's text now, and shows the answer. */
  async function run(s: Session, ask: Ask) {
    if (session !== s || s.range.tooLong || s.applying) return;
    const t = ++token;
    const current = () => session === s && token === t;
    s.last = ask;
    const label =
      ask.kind === 'synonyms'
        ? TOOLS_COPY.synonyms
        : ask.kind === 'followUp'
          ? TOOLS_COPY.answering
          : ask.stage === 'critique'
            ? TOOLS_COPY.critiquing
            : TOOLS_COPY.rewriting;
    show(s, { phase: 'loading', label });
    let view: ToolsView;
    try {
      const text = await s.f.adapter.getText();
      if (!current()) return;
      view = text.slice(s.range.start, s.range.end) === s.range.text ? await answer(s, ask, text) : { phase: 'error', text: TOOLS_COPY.changed };
    } catch {
      view = failed('offline'); // the message never reached the background
    }
    if (current()) show(s, record(s, ask, view));
  }

  /** Keeps what follow-ups need from an answer: a result becomes context for them; a follow-up's answer joins the history. */
  function record(s: Session, ask: Ask, view: ToolsView): ToolsView {
    switch (view.phase) {
      case 'critique':
      case 'variants':
      case 'voice':
      case 'synonyms':
        s.origin = ask.kind === 'rewrite' ? ask.request : { kind: 'synonyms' };
        s.shown.push(shownResult(view));
        return view;
      case 'answer':
        if (ask.kind === 'followUp') s.history.push({ q: ask.question, a: clip(shownAnswer(view)) });
        return s.history.length >= MAX_FOLLOW_UPS ? { ...view, exhausted: true } : view;
      default:
        return view;
    }
  }

  function shownResult(view: Extract<ToolsView, { phase: 'critique' | 'variants' | 'voice' | 'synonyms' }>): string {
    switch (view.phase) {
      case 'critique':
        return shownCritique(view);
      case 'variants':
        return shownVariants(view.variants);
      case 'voice':
        return shownVoice(view);
      case 'synonyms':
        return shownSynonyms(view.options);
    }
  }

  async function answer(s: Session, ask: Ask, text: string): Promise<ToolsView> {
    const { host } = deps;
    const { range } = s;
    const mode = deps.getMode();
    const { before, after } = contextAround(text, range.start, range.end);
    if (ask.kind === 'followUp') {
      if (!s.origin) return failed('bad_response');
      const res = await deps.send('followUp', {
        host,
        mode,
        request: s.origin,
        text: range.text,
        before,
        after,
        shown: clip(s.shown.join('\n\n')),
        history: [...s.history],
        question: ask.question,
      });
      if (res.status !== 'ok' || !res.message) return failed(res.status);
      const variants = res.variants ?? [];
      return {
        phase: 'answer',
        message: res.message,
        variants,
        original: range.text,
        ...(isVoice(s.origin) ? { canApply: variants.map((v) => voiceApplies(range.text, v)) } : {}),
      };
    }
    if (ask.kind === 'synonyms') {
      // The sentence around the target, cut to the context limit (≤ 300 characters each side, I2): a long
      // sentence (or a paragraph with no full stop) never goes whole.
      const around = sentenceAround(text, range.start, range.end);
      const lo = Math.max(Math.min(around.start, range.start), range.start - before.length);
      const hi = Math.min(Math.max(around.end, range.end), range.end + after.length);
      const res = await deps.send('synonyms', { host, mode, target: range.text, sentence: text.slice(lo, hi), targetStart: range.start - lo });
      return res.status === 'ok' && res.options?.length ? { phase: 'synonyms', options: res.options } : failed(res.status);
    }
    const voice = isVoice(ask.request);
    // Sound like me's version hears the writer in the field's other paragraphs (the background drops them for a
    // style profile); its critique only names the weakness, so it goes without.
    const voiceSample = voice && ask.stage === 'variants' ? voiceSampleAround(text, range.start, range.end) : '';
    const res = await deps.send('rewrite', {
      host,
      mode,
      request: ask.request,
      text: range.text,
      before,
      after,
      stage: ask.stage,
      ...(voiceSample ? { voiceSample } : {}),
    });
    if (ask.stage === 'critique') {
      if (res.status !== 'ok' || !res.critique) return failed(res.status);
      const { critique } = res;
      return voice
        ? { phase: 'critique', ...critique, original: range.text, voice: true, canApply: voiceApplies(range.text, critique.lightFix) }
        : { phase: 'critique', ...critique, original: range.text };
    }
    if (voice) {
      const final = res.variants?.[0];
      if (res.status !== 'ok' || !final) return failed(res.status);
      const tells = res.tells ?? [];
      if (tells.length === 0 && final === range.text.trim()) {
        return { phase: 'voice', tells, final, original: range.text, canApply: false, unchanged: true };
      }
      return { phase: 'voice', tells, final, original: range.text, canApply: voiceApplies(range.text, final) };
    }
    return res.status === 'ok' && res.variants?.length ? { phase: 'variants', variants: res.variants, original: range.text } : failed(res.status);
  }

  /** Puts `next` in place of the range, but only if the range still holds the text it was opened on. */
  async function apply(next: string) {
    const s = session;
    if (!s || s.applying || s.range.tooLong) return;
    // After Sound like me, a version that changes a number, name or quote is offered to copy only (and one equal to
    // the selection has nothing to apply).
    if (s.origin && isVoice(s.origin) && !voiceApplies(s.range.text, next)) return;
    s.applying = true;
    token++; // an answer still on its way must not replace this
    const { f, range } = s;
    try {
      const text = await f.adapter.getText();
      if (session !== s) return;
      if (text.slice(range.start, range.end) !== range.text) return show(s, { phase: 'error', text: TOOLS_COPY.changed });
      if (await f.adapter.replace(range.start, range.end, next)) {
        if (session === s) close(false);
        else if (session) return; // another popover opened meanwhile: its focus stays
        const end = range.start + next.length;
        await f.adapter.select(range.start, end); // focus back in the field, on the new text
        deps.overlay.flash(f.fieldId, await f.adapter.rectsFor(range.start, end));
        return;
      }
      show(s, { phase: 'error', text: (await copyText(next)) ? TOOLS_COPY.copied : TOOLS_COPY.notApplied });
    } catch {
      show(s, { phase: 'error', text: TOOLS_COPY.notApplied });
    } finally {
      s.applying = false;
    }
  }

  function close(returnFocus: boolean) {
    const s = session;
    if (!s) return;
    session = null;
    token++;
    s.stopWatch();
    deps.overlay.showTools(null, null, handlers);
    if (returnFocus) void s.f.adapter.select(s.range.start, s.range.end).catch(() => {});
  }

  return {
    open,
    close: () => close(false),
    isOpen: (f) => !!session && (!f || session.f === f),
    ask,
  };
}
