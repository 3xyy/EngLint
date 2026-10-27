import { kindInfo } from './kinds';
import type { Mode } from './types';

export type PresetId = 'rewrite' | 'shorter' | 'clearer' | 'formal' | 'confident' | 'friendlier' | 'casual' | 'simpler' | 'expand' | 'voice';

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

/** What a rewrite or synonyms tool call asks for. */
export type ToolRequest =
  | { kind: 'preset'; presetId: PresetId; focus?: Focus }
  | { kind: 'custom'; instruction: string }
  | { kind: 'synonyms' };

export type RewriteToolRequest = Exclude<ToolRequest, { kind: 'synonyms' }>;

export const BUILTIN_PRESETS: readonly Preset[] = [
  {
    id: 'rewrite',
    title: 'Rewrite',
    instruction: 'Rewrite this so it reads better: smoother flow and clearer wording, with the same meaning and the same voice.',
  },
  {
    id: 'shorter',
    title: 'Shorter',
    instruction: "Make this shorter. Cut filler and repetition, and keep every idea and the writer's voice.",
  },
  {
    id: 'clearer',
    title: 'Clearer',
    instruction: 'Make this clearer and easier to follow. Untangle long or confusing sentences, and keep the meaning and the voice.',
  },
  {
    id: 'formal',
    title: 'More formal',
    instruction: 'Make this more formal and polished, without stiff or fancy wording, and keep the meaning.',
  },
  {
    id: 'confident',
    title: 'More confident',
    instruction: "Make this sound more confident and direct: cut hedges and apologies, keep every idea and the writer's voice.",
  },
  {
    id: 'friendlier',
    title: 'Friendlier',
    instruction: "Make this warmer and friendlier without adding new ideas, keeping the writer's voice.",
  },
  {
    id: 'casual',
    title: 'More casual',
    instruction: 'Make this more relaxed and conversational, keeping every idea.',
  },
  {
    id: 'simpler',
    title: 'Simpler',
    instruction: 'Make this simpler and easier to read: shorter sentences and plainer words, with the same meaning.',
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
    title: 'Sound like me',
    instruction:
      'Make this sound like the writer, not like a template: remove generic phrasing such as stock words, staged contrasts, inflated claims and filler, and keep the meaning and every fact, name, number and quote.',
  },
];

/** Whether a request is Sound like me: its variants stage answers with tells and one final version. */
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
