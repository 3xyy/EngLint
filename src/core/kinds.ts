import type { FamilyToggle, RawIssue, SuggestionFamily } from './types';

export interface KindInfo {
  kind: string;
  family: SuggestionFamily | 'correctness';
  /** Plain words, used in "Stop suggesting {label}". */
  label: string;
  ruleEligible: boolean;
  /** What Essay mode does with it: fix (may carry a short replacement), note (comment-only), off. */
  essay: 'fix' | 'note' | 'off';
}

const err = (kind: string, label: string, ruleEligible = false): KindInfo => ({
  kind,
  family: 'correctness',
  label,
  ruleEligible,
  essay: 'fix',
});
const sug = (
  kind: string,
  family: SuggestionFamily,
  label: string,
  essay: KindInfo['essay'],
): KindInfo => ({ kind, family, label, ruleEligible: true, essay });

/**
 * The `kind` labels. The model is told to use only these, but may still invent one: a suggestion with an invented
 * kind is off in Essay and follows its category's toggle elsewhere; an error is shown whatever its kind.
 */
export const KINDS: readonly KindInfo[] = [
  err('spelling', 'spelling mistakes'),
  err('its_vs_it_is', "its and it's mix-ups"),
  err('their_there_theyre', "their, there and they're mix-ups"),
  err('subject_verb_agreement', 'subject-verb agreement'),
  err('verb_tense', 'verb tense'),
  err('article', 'articles'),
  err('preposition', 'prepositions'),
  err('pronoun_agreement', 'pronoun agreement'),
  err('missing_word', 'missing words'),
  err('missing_comma', 'missing commas'),
  err('comma_splice', 'comma splices'),
  err('run_on', 'run-on sentences'),
  err('apostrophe', 'apostrophes'),
  err('capitalization', 'capitalization'),
  err('word_choice', 'word choice'),
  err('oxford_comma', 'the Oxford comma', true),
  err('contraction', 'contractions', true),
  err('sentence_start_conjunction', 'sentences starting with a conjunction', true),
  sug('wordy_phrase', 'clarity', 'wordy phrases', 'fix'),
  sug('redundancy', 'clarity', 'redundant words', 'fix'),
  sug('long_sentence', 'clarity', 'very long sentences', 'note'),
  sug('passive_voice', 'clarity', 'passive voice', 'fix'),
  sug('unclear_reference', 'clarity', 'unclear references', 'note'),
  sug('complex_word', 'clarity', 'complicated words', 'fix'),
  sug('repeated_word', 'engagement', 'repeated words', 'fix'),
  sug('overused_word', 'engagement', 'overused words', 'fix'),
  sug('vague_word', 'engagement', 'vague words', 'note'),
  sug('sentence_variety', 'engagement', 'repetitive sentence openings', 'note'),
  sug('hedging', 'delivery', 'hedging', 'off'),
  sug('formality', 'delivery', "tone that doesn't fit", 'off'),
  sug('inclusive_language', 'delivery', 'non-inclusive terms', 'fix'),
  sug('generic_phrasing', 'delivery', 'generic phrasing', 'fix'),
];

/** Kinds dropped from the taxonomy. selectIssues drops them in every mode, even when the model invents one. */
export const RETIRED_KINDS: readonly string[] = ['politeness'];

export function kindInfo(kind: string): KindInfo | undefined {
  return KINDS.find((k) => k.kind === kind);
}

const SUGGESTION_FAMILIES: readonly string[] = ['clarity', 'engagement', 'delivery'];

/**
 * An error is correctness. A suggestion of a known suggestion kind takes that kind's family, whatever
 * category the model filed it under. Otherwise the category decides: a suggestion
 * category is its family, an error category is correctness, and an unknown category is clarity.
 */
export function familyOf(
  issue: Pick<RawIssue, 'severity' | 'category'> & { kind?: string },
): SuggestionFamily | 'correctness' {
  if (issue.severity === 'error') return 'correctness';
  const known = issue.kind === undefined ? undefined : kindInfo(issue.kind);
  if (known && known.family !== 'correctness') return known.family;
  if (SUGGESTION_FAMILIES.includes(issue.category)) return issue.category as SuggestionFamily;
  if (['spelling', 'grammar', 'punctuation', 'word_choice'].includes(issue.category)) return 'correctness';
  return 'clarity';
}

/** The settings toggle that governs an issue; null for errors. */
export function toggleOf(issue: Pick<RawIssue, 'severity' | 'category' | 'kind'>): FamilyToggle | null {
  const family = familyOf(issue);
  if (family === 'correctness') return null;
  if (issue.kind === 'generic_phrasing') return 'generic';
  return family;
}

/** What Essay does with a suggestion kind; `off` for a kind not listed, so an invented kind can't get past the Essay policy. */
export function essayPolicy(kind: string): 'fix' | 'note' | 'off' {
  return kindInfo(kind)?.essay ?? 'off';
}
