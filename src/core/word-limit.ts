// Fit a word limit: the target picker's defaults, the cuts applied to a selection, and the counts the results
// show. Every count here is the local word counter's (doc-stats.ts countWords), never a number from the model.
import { countWords } from './doc-stats';

/** The common limits offered as chips (the Common App's 650 among them), each only below the selection's words. */
export const LIMIT_CHIPS = [150, 250, 500, 650] as const;
/** The target the picker starts at: this share of the selection's words, rounded to 5. */
export const DEFAULT_TARGET_SHARE = 0.85;
/**
 * The longest selection the word-limit tool takes, in characters (about 850 words): a whole application essay. Its
 * answer is one version at or under the target and 5 to 12 short cuts, which, with the thinking, fits in its 8,192
 * output tokens. The other tools stop at 2,000 characters because they answer with three full versions.
 */
export const MAX_WORD_LIMIT_CHARS = 5_000;
/** Find more cuts: offered while fewer cuts than this are shown, which the request then sends (the background's limit). */
export const MAX_SHOWN_CUTS = 36;

/** One suggested cut, located in the selection. */
export interface WordLimitCut {
  /** Offsets in the selection's text. */
  start: number;
  end: number;
  original: string;
  /** '' deletes the original. */
  replacement: string;
  /** What the cut loses, or why it is safe: a few words. */
  why: string;
  /** The words it saves, by the local counter. */
  saves: number;
  /** It changes a number, name, date or quote (core/claims.ts): never picked for the writer. */
  changesFacts: boolean;
}

type Splice = Pick<WordLimitCut, 'start' | 'end' | 'replacement'>;

/** The target the picker starts at for a selection of `words`: 85% rounded to 5, from 1 to one under `words`. */
export function defaultTarget(words: number): number {
  return Math.max(1, Math.min(words - 1, Math.round((words * DEFAULT_TARGET_SHARE) / 5) * 5));
}

/** The limit chips for a selection of `words`: the common limits below it. */
export const limitChips = (words: number): number[] => LIMIT_CHIPS.filter((c) => c < words);

/**
 * Whether a full version of `words` fits `target` closely enough to offer: at or under it, and at least 80% of it
 * (whole-number arithmetic, so exactly 80% fits). Further under, it's a summary, not a fit.
 */
export const versionFits = (words: number, target: number) => words <= target && words * 5 >= target * 4;

/** The fewest words the prompt asks the full version for: 90% of `target`, rounded up, so it uses the room it has. */
export const versionFloor = (target: number) => Math.ceil((target * 9) / 10);

/** Whether `target` can be asked for: a whole number of words from 1 to one under the selection's. */
export const validTarget = (target: number, words: number) => Number.isInteger(target) && target >= 1 && target < words;

const EDGE_SPACE_END = /[ \t]+$/;
const EDGE_SPACE_START = /^[ \t]+/;
/** What a space before it would be left stranded against: a line break or closing punctuation. */
const CLOSER = /^(?:\r?\n|[,.;:!?…)\]}”’])/u;
/** Ends with a line break (and maybe spaces after it). */
const LINE_END = /\n[ \t]*$/;
const WORD_END = /[\p{L}\p{N}]$/u;
const WORD_START = /^[\p{L}\p{N}]/u;

/**
 * `text` with `cuts` (offsets in `text`, not overlapping) applied, as one string to replace the selection with once.
 * Every cut is placed by its offsets in the original text, so none moves another, adjacent ones included. Where a
 * deletion leaves its two sides meeting, the spaces are tidied: one space between words, none before a line break
 * or closing punctuation, one paragraph break where a paragraph went, none at the selection's edges, and a space
 * between two words it would join.
 */
export function applyCuts(text: string, cuts: readonly Splice[]): string {
  let out = '';
  let at = 0;
  let joint = false; // a deletion just ended: the next text meets what came before it
  const add = (piece: string) => {
    if (joint) {
      if (out === '' || LINE_END.test(out)) piece = piece.replace(/^\s+/, '');
      else if (EDGE_SPACE_END.test(out) && CLOSER.test(piece)) out = out.replace(EDGE_SPACE_END, '');
      else if (EDGE_SPACE_END.test(out)) piece = piece.replace(EDGE_SPACE_START, '');
      else if (WORD_END.test(out) && WORD_START.test(piece)) piece = ` ${piece}`;
    }
    if (piece === '') return;
    joint = false;
    out += piece;
  };
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    add(text.slice(at, c.start));
    if (c.replacement === '') joint = true;
    else add(c.replacement);
    at = c.end;
  }
  add(text.slice(at));
  return joint ? out.replace(/\s+$/, '') : out;
}

const chosen = <T>(cuts: readonly T[], selected: readonly boolean[]) => cuts.filter((_, i) => selected[i]);

/** The words `text` would have with the `selected` cuts applied. */
export const wordsAfter = (text: string, cuts: readonly Splice[], selected: readonly boolean[]) => countWords(applyCuts(text, chosen(cuts, selected)));

/**
 * The cuts picked for the writer at first: `from` as it is (the choices already made, for the cuts shown before), then
 * the rest in order (the least loss of meaning first) while the words are still over `target`. A cut that changes a
 * fact is never picked.
 */
export function preselect(text: string, cuts: readonly WordLimitCut[], target: number, from: readonly boolean[] = []): boolean[] {
  const selected = cuts.map((_, i) => from[i] ?? false);
  let words = wordsAfter(text, cuts, selected);
  for (let i = from.length; i < cuts.length && words > target; i++) {
    if (cuts[i]!.changesFacts) continue;
    selected[i] = true;
    words = wordsAfter(text, cuts, selected);
  }
  return selected;
}

/**
 * The cuts shown for a target: the cuts, the picks, and the full version (at or under the target), if any, with
 * whether it changes a number, name, date or quote (shown with a note; the writer may still use it).
 */
export interface CutsShown {
  target: number;
  cuts: WordLimitCut[];
  selected: boolean[];
  version: string | null;
  versionChangesFacts: boolean;
}

/**
 * The cuts shown after a search for `target` in `text`: `prior`'s first (a search for more; the writer's picks kept),
 * then the `found` ones, picked in order while the words are still over the target. The first version found stays,
 * and its fact flag with it.
 */
export function withFound(
  text: string,
  target: number,
  found: { cuts: readonly WordLimitCut[]; version?: string | null; versionChangesFacts?: boolean },
  prior: CutsShown | null = null,
): CutsShown {
  const cuts = [...(prior?.cuts ?? []), ...found.cuts];
  const kept = prior?.version ? prior : { version: found.version ?? null, versionChangesFacts: !!found.versionChangesFacts };
  return { target, cuts, selected: preselect(text, cuts, target, prior?.selected), version: kept.version, versionChangesFacts: kept.version !== null && kept.versionChangesFacts };
}

/** The live counter: the words with the selected cuts, and how far that is from the target. */
export function counterText(words: number, target: number): string {
  const gap = words > target ? `${words - target} to go` : words === target ? 'at the limit' : `${target - words} under`;
  return `Selected cuts: ${words} words (${gap})`;
}

/** A cut's pill: "−7 words". */
export const savedText = (saves: number) => `−${saves} ${saves === 1 ? 'word' : 'words'}`;
