// What the selection bar opens: the tools popover's logic. It sends the rewrite and synonyms requests
// (in Essay mode, the critique first), follow-up questions about their results and the word-limit tool's search for
// cuts, shows each answer through the overlay (ToolsPopover.tsx draws it), and applies a pick back into the field
// only while the selected text is still there. Late answers (after a close, a newer request or another open) are
// dropped. Nothing here logs page text or model output.
import { changesClaims } from '../../core/claims';
import { contextAround, isSingleWord, sentenceAround, voiceSampleAround } from '../../core/context';
import { countWords } from '../../core/doc-stats';
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
import { isVoice, presetsFor, requestTitle, type PresetId, type RewriteToolRequest, type ToolRequest } from '../../core/presets';
import type { CheckStatus, Mode } from '../../core/types';
import { MAX_SHOWN_CUTS, MAX_WORD_LIMIT_CHARS, applyCuts, validTarget, withFound, type CutsShown, type WordLimitCut } from '../../core/word-limit';
import type { OpenToolsRequest, sendMessage } from '../../shared/messages';
import { providerInfoNow } from '../provider-info';
import { APPLY_FAILED, APPLY_FAILED_COPIED, toolStatusText } from '../../shared/status-text';
import type { Field } from '../field-host';
import { boxAround, scrollMovesText } from '../overlay/anchor';
import type { OverlayHandle } from '../overlay/mount';

/**
 * Whether a Sound like me version (or a light fix or follow-up version after one) may be applied: it differs from the
 * selection and keeps every number, name, date and quote. Sentence openers may go or change at any sentence start.
 */
const voiceApplies = (original: string, version: string) =>
  version.trim() !== original.trim() && !changesClaims(original, version, { sentenceStarts: 'lenient' });

export type ToolsView =
  /**
   * The selection bar, focused (the shortcut). `singleWord`: the selection is one word, so Synonyms is its own button.
   * `focus: 'custom'`: the "Ask anything…" box is open and takes focus instead of the first button ("Ask anything…"
   * from the right-click menu). `tooLong`: over 2,000 characters, so only Fit a word limit is on.
   */
  | { phase: 'menu'; mode: Mode; singleWord?: true; focus?: 'custom'; tooLong?: 'rewrites' }
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
  /** Fit a word limit's target picker: the selection's words, by the local counter. Nothing is sent before Find cuts. */
  | { phase: 'wordLimitPick'; words: number }
  /**
   * Fit a word limit's cuts for the selection `original` (`words` long) and the `target` asked for. `selected`: the
   * cuts picked to start with (the popover keeps the writer's picks from there). `version`: the full version at or
   * under the target, or null; `versionChangesFacts`: it changes a number, name, date or quote (shown with the fact
   * note; it still applies, since the writer picks it). `more`: Find more cuts is offered; `noneNew`: the last search
   * for more found none; `error`: it failed, and this is its status (the cuts and the picks stay).
   */
  | {
      phase: 'wordLimit';
      original: string;
      words: number;
      target: number;
      cuts: WordLimitCut[];
      selected: boolean[];
      version: string | null;
      versionChangesFacts: boolean;
      more: boolean;
      noneNew?: true;
      error?: string;
    }
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
  /** Fit a word limit: searches for cuts that bring the selection to `target` words. */
  findCuts(target: number): void;
  /** Fit a word limit: searches for cuts other than those shown; `selected` is the writer's picks so far, kept. */
  moreCuts(selected: boolean[]): void;
  /** Fit a word limit: puts the selection with the `selected` cuts applied in its place, once. */
  applySelected(selected: boolean[]): void;
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
  /** Over MAX_SELECTION_CHARS: only the word-limit tool (up to MAX_WORD_LIMIT_CHARS) sends anything for it. */
  tooLong?: true;
}

export interface ToolsDeps {
  overlay: Pick<OverlayHandle, 'showTools' | 'flash'>;
  host: string;
  getMode(): Mode;
  send: typeof sendMessage;
  /** The user closed the popover (Esc, Close or a click outside) with nothing applied. */
  onClosedByUser?(): void;
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
  /** Under the bar (and the panel's buttons) for a selection only Fit a word limit takes. */
  onlyLimit: 'Only Fit a word limit works on selections this long.',
  tooLongForLimit: 'Select up to about 5,000 characters to fit a word limit.',
  oneWord: 'Select more than one word to fit a word limit.',
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
  findingCuts: 'Finding cuts…',
  findingMore: 'Finding more cuts…',
  /** Under the cuts, after a search for more found none. */
  noMoreCuts: 'No other cuts found.',
  /** In place of the follow-up box once a popover has had all its follow-ups. */
  noMoreFollowUps: 'Start a new request for more.',
  /** A preset the page's mode doesn't offer (the right-click menu lists them all). */
  essayOnlyNot: "Expand isn't offered for essays.",
  /** Beside a version that changes a claim: Sound like me's (Copy only) and Fit a word limit's full version (still applies). */
  checkFacts: 'Check the facts: this version changes a number, name or quote.',
  /** After Sound like me's critique (Essay): its one version, in place of "Show 3 rewrites". */
  showVersion: 'Show the version',
} as const;

/** What a request asked for, kept so Retry can send it again. */
type Ask =
  | { kind: 'rewrite'; request: RewriteToolRequest; stage: 'critique' | 'variants' }
  | { kind: 'synonyms' }
  | { kind: 'followUp'; question: string }
  /** `more`: Find more cuts, which sends the cuts shown (the session's `limit`). */
  | { kind: 'wordLimit'; target: number; more: boolean };

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
  /** The results header: the action asked for last ("Improve", "Tone · Formal"); a follow-up keeps it. */
  title: string | null;
  /** The follow-ups answered so far, oldest first. */
  history: { q: string; a: string }[];
  /** Fit a word limit's cuts shown, once a search answered: kept apart from the view, so a search for more that fails loses none. */
  limit: CutsShown | null;
  /** The error shown offers Retry. */
  retryable: boolean;
  applying: boolean;
  stopWatch(): void;
}

/**
 * Statuses that may pass on their own, so Retry is offered. The cap, the key, credit and a switched-off site
 * are fixed outside the popover: no Retry.
 */
const RETRYABLE: ReadonlySet<CheckStatus> = new Set(['rate_limited', 'overloaded', 'offline', 'bad_response']);

/** A failed request's status as shown: ok without its payload is an unusable answer. */
const shownStatus = (status: CheckStatus): CheckStatus => (status === 'ok' ? 'bad_response' : status);
/** Whether a request that failed with `status` is worth sending again (Retry, or Find more cuts): it may pass on its own. */
export const retryable = (status: CheckStatus) => RETRYABLE.has(shownStatus(status));
const statusLine = (status: CheckStatus) => toolStatusText(shownStatus(status), undefined, providerInfoNow()) ?? '';

function failed(status: CheckStatus): ToolsView {
  const text = statusLine(status);
  return retryable(status) ? { phase: 'error', text, retry: true } : { phase: 'error', text };
}

/** Whether `mode` offers the preset. */
const offered = (id: PresetId, mode: Mode) => presetsFor(mode).some((p) => p.id === id);

/** Whether the range is too long for `ask`: the word-limit tool takes up to MAX_WORD_LIMIT_CHARS, the rest up to MAX_SELECTION_CHARS. */
const tooLongFor = (range: ToolsRange, ask: { kind: string }) => (ask.kind === 'wordLimit' ? range.text.length > MAX_WORD_LIMIT_CHARS : !!range.tooLong);

/**
 * Fit a word limit's view for the session's selection and cuts. After a search for more: `noneNew`, it found none;
 * `failed`, it failed with this status, shown under the cuts, with Find more cuts kept only when it may pass on its own.
 */
const limitView = (range: ToolsRange, limit: CutsShown, last: { noneNew?: boolean; failed?: CheckStatus } = {}): ToolsView => ({
  phase: 'wordLimit',
  original: range.text,
  words: countWords(range.text),
  ...limit,
  more: !last.noneNew && (last.failed === undefined || retryable(last.failed)) && limit.cuts.length < MAX_SHOWN_CUTS,
  ...(last.noneNew ? { noneNew: true as const } : {}),
  ...(last.failed !== undefined ? { error: statusLine(last.failed) } : {}),
});

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
    findCuts(target) {
      const s = session;
      if (s && validTarget(target, countWords(s.range.text))) void run(s, { kind: 'wordLimit', target, more: false });
    },
    moreCuts(selected) {
      const s = session;
      if (!s?.limit || s.limit.cuts.length >= MAX_SHOWN_CUTS) return;
      s.limit = { ...s.limit, selected: s.limit.cuts.map((_, i) => !!selected[i]) };
      void run(s, { kind: 'wordLimit', target: s.limit.target, more: true });
    },
    applySelected(selected) {
      const s = session;
      const cuts = s?.limit?.cuts.filter((_, i) => selected[i]) ?? [];
      if (s && cuts.length > 0) void apply(applyCuts(s.range.text, cuts));
    },
    close(returnFocus = true) {
      if (!session) return;
      close(returnFocus);
      deps.onClosedByUser?.();
    },
  };

  const show = (s: Session, view: ToolsView) => {
    if (session !== s) return;
    s.view = view;
    s.retryable = view.phase === 'error' && !!view.retry;
    deps.overlay.showTools(s.anchor, view, handlers, s.title ?? undefined);
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
      title: null,
      history: [],
      limit: null,
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
      const bar: Extract<ToolsView, { phase: 'menu' }> = {
        phase: 'menu',
        mode: deps.getMode(),
        ...(isSingleWord(range.text) ? { singleWord: true as const } : {}),
        ...(range.tooLong ? { tooLong: 'rewrites' as const } : {}),
      };
      // A request checks the range's length for itself; the bar opens for anything one tool can take.
      if (request && request !== 'custom-prompt') await pick(request);
      else if (range.text.length > MAX_WORD_LIMIT_CHARS || (range.tooLong && request === 'custom-prompt')) show(s, { phase: 'error', text: TOOLS_COPY.tooLong });
      else if (request === 'custom-prompt') show(s, { ...bar, focus: 'custom' });
      else show(s, bar);
    })();
  }

  async function pick(r: ToolRequest) {
    const s = session;
    if (!s) return;
    if (r.kind === 'wordLimit') return pickLimit(s);
    if (s.range.tooLong) return show(s, { phase: 'error', text: TOOLS_COPY.tooLong });
    if (r.kind === 'custom' && r.instruction.trim() === '') return;
    if (r.kind === 'preset' && !offered(r.presetId, deps.getMode())) return show(s, { phase: 'error', text: TOOLS_COPY.essayOnlyNot });
    // The Essay gate: a rewrite there starts with the critique; synonyms never do.
    const stage = deps.getMode() === 'essay' ? 'critique' : 'variants';
    await run(s, r.kind === 'synonyms' ? { kind: 'synonyms' } : { kind: 'rewrite', request: r, stage });
  }

  /** Fit a word limit: the target picker, for a selection of more than one word and at most MAX_WORD_LIMIT_CHARS. */
  function pickLimit(s: Session) {
    if (s.applying) return;
    token++; // an answer still on its way is for another view
    s.title = requestTitle({ kind: 'wordLimit' });
    s.last = null;
    const words = countWords(s.range.text);
    if (tooLongFor(s.range, { kind: 'wordLimit' })) show(s, { phase: 'error', text: TOOLS_COPY.tooLongForLimit });
    else if (words < 2) show(s, { phase: 'error', text: TOOLS_COPY.oneWord });
    else show(s, { phase: 'wordLimitPick', words });
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
    if (session !== s || tooLongFor(s.range, ask) || s.applying) return;
    const t = ++token;
    const current = () => session === s && token === t;
    s.last = ask;
    if (ask.kind === 'rewrite') s.title = requestTitle(ask.request);
    else if (ask.kind === 'synonyms' || ask.kind === 'wordLimit') s.title = requestTitle({ kind: ask.kind });
    const label =
      ask.kind === 'synonyms'
        ? TOOLS_COPY.synonyms
        : ask.kind === 'followUp'
          ? TOOLS_COPY.answering
          : ask.kind === 'wordLimit'
            ? ask.more
              ? TOOLS_COPY.findingMore
              : TOOLS_COPY.findingCuts
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
      view = failedAsk(s, ask, 'offline'); // the message never reached the background
    }
    if (current()) show(s, record(s, ask, view));
  }

  /** A failed request's view: an error in place of the result, but a failed search for more keeps the cuts shown. */
  function failedAsk(s: Session, ask: Ask, status: CheckStatus): ToolsView {
    return ask.kind === 'wordLimit' && ask.more && s.limit ? limitView(s.range, s.limit, { failed: status }) : failed(status);
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
    if (ask.kind === 'wordLimit') {
      const shown = ask.more && s.limit ? s.limit.cuts : [];
      const res = await deps.send('wordLimit', {
        host,
        mode,
        text: range.text,
        before,
        after,
        target: ask.target,
        ...(shown.length ? { shown: shown.map(({ start, end, original, replacement }) => ({ start, end, original, replacement })) } : {}),
      });
      if (res.status !== 'ok' || !res.cuts) return failedAsk(s, ask, res.status);
      const prior = ask.more ? s.limit : null;
      s.limit = withFound(range.text, ask.target, { cuts: res.cuts, version: res.version, versionChangesFacts: res.versionChangesFacts }, prior);
      return limitView(range, s.limit, { noneNew: !!prior && res.cuts.length === 0 });
    }
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
    if (!s || s.applying || tooLongFor(s.range, { kind: s.limit ? 'wordLimit' : 'rewrite' })) return;
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
