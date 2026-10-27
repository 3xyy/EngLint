import type { RawIssue } from './types';

/** Where an issue came from: Claude, the local Harper checker, or the local generic-phrasing detectors. */
export type SourceId = 'claude' | 'harper' | 'tells';

export type SourcedIssue = RawIssue & {
  source: SourceId;
  /** `harper:<RuleName>` or `tell:<name>`. */
  ruleId: string;
  /**
   * Where `original` starts, relative to the exact paragraph text whose hash keys the entry, when the
   * source knows; tried before searching.
   */
  at?: number;
  /** How many fixes the source offered (Harper); the instant floor needs exactly one. */
  suggestionCount?: number;
};

/** One paragraph's issues per source. A `claude` entry, even an empty one, means Claude has answered it. */
export interface ParagraphRaw {
  claude?: RawIssue[];
  harper?: SourcedIssue[];
  tells?: SourcedIssue[];
}

/**
 * Harper rules shown before Claude answers (and whenever it can't), each past its guards in merge.ts: SpellCheck
 * only on a word starting lowercase, RepeatedWords only on a word in NEVER_DOUBLED, AnA never before an acronym.
 */
export const HARPER_INSTANT: ReadonlySet<string> = new Set(['AnA', 'RepeatedWords', 'ItsContraction', 'SpellCheck']);
/** Harper rules still shown after Claude answers, past the same guards, where they don't overlap a Claude error. */
export const HARPER_TRUSTED: ReadonlySet<string> = new Set(['AnA']);
/** Every Harper rule the merge can show; the offscreen document returns no other lints. */
export const HARPER_SHOWN: ReadonlySet<string> = new Set([...HARPER_INSTANT, ...HARPER_TRUSTED]);
/**
 * Words never correctly written twice in a row. Harper flags any doubled word, also good English ("I had had
 * enough", "what it is is", "came in in a hurry", "very very good"), so only these count as instant.
 */
export const NEVER_DOUBLED: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'of', 'to', 'for', 'with', 'from', 'my', 'your', 'our', 'their',
]);

/** The rule name in a `harper:<RuleName>` id. */
export const harperRule = (ruleId: string): string => ruleId.replace(/^harper:/, '');
