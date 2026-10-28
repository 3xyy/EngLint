import { kindInfo } from './kinds';
import type { Mode } from './types';

export type PresetId = 'rewrite' | 'shorter' | 'formal' | 'confident' | 'friendlier' | 'casual' | 'expand' | 'voice';

export interface Preset {
  id: PresetId;
  title: string;
  instruction: string;
  /** The modes that offer it; absent: every mode. */
  modes?: readonly Mode[];
}

/** The problem a note flagged, so a rewrite addresses it. `reason` is model text: it is data, never instructions. */
export interface Focus {
  kind: string;
  label: string;
  reason: string;
}

export const MAX_FOCUS_REASON = 300;

/** The focus for a note (its reason cut to MAX_FOCUS_REASON characters): its kind's plain label, or the kind's own words for a kind not listed. */
export function focusFor(issue: { kind: string; reason: string }): Focus {
  return { kind: issue.kind, label: kindInfo(issue.kind)?.label ?? issue.kind.replace(/_/g, ' '), reason: issue.reason.slice(0, MAX_FOCUS_REASON) };
}

/** What a tool asks for: a rewrite, synonyms, or the word-limit tool (whose target the writer picks next). */
export type ToolRequest =
  | { kind: 'preset'; presetId: PresetId; focus?: Focus }
  | { kind: 'custom'; instruction: string }
  | { kind: 'synonyms' }
  | { kind: 'wordLimit' };

export type RewriteToolRequest = Exclude<ToolRequest, { kind: 'synonyms' } | { kind: 'wordLimit' }>;

/** In bar order (BAR_ACTIONS); the title is the word the bar, the right-click menu and the side panel show. */
export const BUILTIN_PRESETS: readonly Preset[] = [
  {
    id: 'rewrite',
    title: 'Improve',
    instruction: 'Improve this: clearer, simpler and smoother, with the same meaning and voice.',
  },
  {
    id: 'shorter',
    title: 'Shorter',
    instruction: "Make this shorter. Cut filler and repetition, and keep every idea and the writer's voice.",
  },
  {
    id: 'formal',
    title: 'Formal',
    instruction: 'Make this more formal and polished, without stiff or fancy wording, and keep the meaning.',
  },
  {
    id: 'confident',
    title: 'Confident',
    instruction: "Make this sound more confident and direct: cut hedges and apologies, keep every idea and the writer's voice.",
  },
  {
    id: 'friendlier',
    title: 'Friendly',
    instruction: "Make this warmer and friendlier without adding new ideas, keeping the writer's voice.",
  },
  {
    id: 'casual',
    title: 'Casual',
    instruction: 'Make this more relaxed and conversational, keeping every idea.',
  },
  {
    id: 'expand',
    title: 'Expand',
    instruction: 'Expand this a little: develop the ideas already there with a bit more detail, adding no new facts or claims.',
    modes: ['standard', 'casual'],
  },
  {
    // Answers with the generic patterns it found and one version without them (prompts/rewrite.ts).
    id: 'voice',
    title: 'My voice',
    instruction:
      'Make this sound like the writer, not like a template: remove generic phrasing such as stock words, staged contrasts, inflated claims and filler, and keep the meaning and every fact, name, number and quote.',
  },
];

/** Whether a request is My voice (Sound like me): its variants stage answers with tells and one final version. */
export const isVoice = (request: ToolRequest) => request.kind === 'preset' && request.presetId === 'voice';

/** The presets offered in `mode`, in menu order. */
export function presetsFor(mode: Mode): readonly Preset[] {
  return BUILTIN_PRESETS.filter((p) => !p.modes || p.modes.includes(mode));
}

/** The built-in preset with this id. */
export function presetById(id: PresetId): Preset {
  const preset = BUILTIN_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return preset;
}

// ---- the selection bar: the presets bundled into a few actions ----

/** What a bar button or menu item runs: a tool request, or 'custom-prompt' (the "Ask anything…" box). */
export type BarRun = ToolRequest | 'custom-prompt';

export interface BarItem {
  /**
   * Unique among the bar's items as shown: "synonyms" is both a button (a one-word selection) and a More item (a longer
   * one), which never show together.
   */
  id: string;
  label: string;
  run: BarRun;
  /** The results header after it ("Tone · Formal"); the label when absent. */
  title?: string;
  /** The modes that offer it; absent: every mode. */
  modes?: readonly Mode[];
  /** 'multi': only for a selection of more than one word. */
  words?: 'multi';
}

export type BarAction =
  | { kind: 'button'; id: 'improve' | 'voice' | 'synonyms'; label: string; run: ToolRequest; /** 'single': only for a one-word selection. */ words?: 'single' }
  | { kind: 'menu'; id: 'shorten' | 'tone' | 'more'; label: string; items: readonly BarItem[] };

const preset = (presetId: PresetId): ToolRequest => ({ kind: 'preset', presetId });
const presetItem = (presetId: PresetId, title?: string): BarItem => {
  const p = presetById(presetId);
  return { id: presetId, label: p.title, run: preset(presetId), ...(title ? { title } : {}), ...(p.modes ? { modes: p.modes } : {}) };
};
const toneItem = (presetId: PresetId) => presetItem(presetId, `Tone · ${presetById(presetId).title}`);

/** "Fit a word limit…" under Shorten: the target picker, then cuts to choose from. A single word has nothing to fit. */
export const WORD_LIMIT_ITEM: BarItem = { id: 'wordLimit', label: 'Fit a word limit…', run: { kind: 'wordLimit' }, title: 'Fit a word limit', words: 'multi' };

/**
 * The bar, left to right: Improve, Shorten ▾, Tone ▾, My voice, Synonyms (a one-word selection only) and More ▾.
 * Every built-in preset is on it once; the right-click menu and the side panel's Tools follow it.
 */
export const BAR_ACTIONS: readonly BarAction[] = [
  { kind: 'button', id: 'improve', label: presetById('rewrite').title, run: preset('rewrite') },
  { kind: 'menu', id: 'shorten', label: 'Shorten', items: [presetItem('shorter', 'Shorten'), WORD_LIMIT_ITEM] },
  { kind: 'menu', id: 'tone', label: 'Tone', items: [toneItem('formal'), toneItem('confident'), toneItem('friendlier'), toneItem('casual')] },
  { kind: 'button', id: 'voice', label: presetById('voice').title, run: preset('voice') },
  { kind: 'button', id: 'synonyms', label: 'Synonyms', run: { kind: 'synonyms' }, words: 'single' },
  {
    kind: 'menu',
    id: 'more',
    label: 'More',
    items: [presetItem('expand'), { id: 'synonyms', label: 'Synonyms', run: { kind: 'synonyms' }, words: 'multi' }, { id: 'custom', label: 'Ask anything…', run: 'custom-prompt' }],
  },
];

/** The bar for a selection in `mode`: Expand only where the mode offers it; Synonyms its own button for one word, in More otherwise. */
export function barActionsFor(mode: Mode, singleWord: boolean): readonly BarAction[] {
  const keep = (x: BarAction | BarItem) => !('words' in x) || !x.words || (x.words === 'single') === singleWord;
  return BAR_ACTIONS.filter(keep).map((a) =>
    a.kind === 'menu' ? { ...a, items: a.items.filter((i) => keep(i) && (!i.modes || i.modes.includes(mode))) } : a,
  );
}

const sameRun = (run: BarRun, r: ToolRequest) =>
  run !== 'custom-prompt' && run.kind === r.kind && (run.kind !== 'preset' || (r.kind === 'preset' && run.presetId === r.presetId));

/** The results header for a request: the bar's name for it ("Improve", "Tone · Formal", "Fit a word limit"), or a custom instruction in quotes. */
export function requestTitle(r: ToolRequest): string {
  if (r.kind === 'custom') return `“${r.instruction.trim()}”`;
  for (const a of BAR_ACTIONS) {
    if (a.kind === 'button' && sameRun(a.run, r)) return a.label;
    const item = a.kind === 'menu' ? a.items.find((i) => sameRun(i.run, r)) : undefined;
    if (item) return item.title ?? item.label;
  }
  return r.kind === 'preset' ? presetById(r.presetId).title : 'Synonyms';
}
