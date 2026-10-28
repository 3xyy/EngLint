import type { FamilyToggle, RawIssue, SuggestionFamily } from './types';

export interface KindInfo {
  kind: string;
  family: SuggestionFamily | 'correctness';
  /** Plain words, used in "Stop suggesting {label}". */
  label: string;
  /** The type of change, as an imperative of at most 4 words: the card reads "{Family} · {action}". */
  action: string;
  ruleEligible: boolean;
  /** What Essay mode does with it: fix (may carry a short replacement), note (comment-only), off. */
  essay: 'fix' | 'note' | 'off';
}

const err = (kind: string, label: string, action: string, ruleEligible = false): KindInfo => ({
  kind,
  family: 'correctness',
  label,
  action,
  ruleEligible,
  essay: 'fix',
});
const sug = (
  kind: string,
  family: SuggestionFamily,
  label: string,
  action: string,
  essay: KindInfo['essay'],
): KindInfo => ({ kind, family, label, action, ruleEligible: true, essay });

/**
 * The `kind` labels. The model is told to use only these, but may still invent one: a suggestion with an invented
 * kind is off in Essay and follows its category's toggle elsewhere; an error is shown whatever its kind.
 */
export const KINDS: readonly KindInfo[] = [
  err('spelling', 'spelling mistakes', 'Fix the spelling'),
  err('its_vs_it_is', "its and it's mix-ups", "Fix its or it's"),
  err('their_there_theyre', "their, there and they're mix-ups", "Fix their/there/they're"),
  err('subject_verb_agreement', 'subject-verb agreement', 'Fix subject-verb agreement'),
  err('verb_tense', 'verb tense', 'Fix the verb tense'),
  err('article', 'articles', 'Fix the article'),
  err('preposition', 'prepositions', 'Fix the preposition'),
  err('pronoun_agreement', 'pronoun agreement', 'Fix pronoun agreement'),
  err('missing_word', 'missing words', 'Add the missing word'),
  err('missing_comma', 'missing commas', 'Add a comma'),
  err('comma_splice', 'comma splices', 'Fix the comma splice'),
  err('run_on', 'run-on sentences', 'Split the run-on'),
  err('apostrophe', 'apostrophes', 'Fix the apostrophe'),
  err('capitalization', 'capitalization', 'Fix the capitalization'),
  err('word_choice', 'word choice', 'Use the right word'),
  err('oxford_comma', 'the Oxford comma', 'Fix the Oxford comma', true),
  err('contraction', 'contractions', 'Fix the contraction', true),
  err('sentence_start_conjunction', 'sentences starting with a conjunction', 'Rework the opening conjunction', true),
  sug('wordy_phrase', 'clarity', 'wordy phrases', 'Cut wordiness', 'fix'),
  sug('redundancy', 'clarity', 'redundant words', 'Remove the redundancy', 'fix'),
  sug('long_sentence', 'clarity', 'very long sentences', 'Split the long sentence', 'note'),
  sug('passive_voice', 'clarity', 'passive voice', 'Use the active voice', 'fix'),
  sug('unclear_reference', 'clarity', 'unclear references', 'Clarify the reference', 'note'),
  sug('complex_word', 'clarity', 'complicated words', 'Use a simpler word', 'fix'),
  sug('repeated_word', 'engagement', 'repeated words', 'Vary the repeated word', 'fix'),
  sug('overused_word', 'engagement', 'overused words', 'Use a fresher word', 'fix'),
  sug('vague_word', 'engagement', 'vague words', 'Use a sharper word', 'note'),
  sug('sentence_variety', 'engagement', 'repetitive sentence openings', 'Vary the sentence openings', 'note'),
  sug('hedging', 'delivery', 'hedging', 'Sound more confident', 'off'),
  sug('formality', 'delivery', "tone that doesn't fit", 'Match the tone', 'off'),
  sug('inclusive_language', 'delivery', 'non-inclusive terms', 'Use inclusive language', 'fix'),
  sug('generic_phrasing', 'delivery', 'generic phrasing', 'Say it plainly', 'fix'),
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

/** How the UI names a family; generic phrasing (a Delivery kind with its own toggle) is shown as its own. */
const FAMILY_NAMES: Record<FamilyToggle | 'correctness', string> = {
  correctness: 'Correctness',
  clarity: 'Clarity',
  engagement: 'Engagement',
  delivery: 'Delivery',
  generic: 'Generic phrasing',
};

export function familyName(family: FamilyToggle | 'correctness'): string {
  return FAMILY_NAMES[family];
}

/** The family an issue is shown under (name, dot and underline colour): its toggle's, and correctness for errors. */
export function shownFamily(issue: Pick<RawIssue, 'severity' | 'category' | 'kind'>): FamilyToggle | 'correctness' {
  return toggleOf(issue) ?? 'correctness';
}

/** What type of change an issue is: "{Family} · {action}", with "Improve this" as the action of a kind not listed. */
export function typeLabel(issue: Pick<RawIssue, 'severity' | 'category' | 'kind'>): string {
  return `${familyName(shownFamily(issue))} · ${kindInfo(issue.kind)?.action ?? 'Improve this'}`;
}

/** What Essay does with a suggestion kind; `off` for a kind not listed, so an invented kind can't get past the Essay policy. */
export function essayPolicy(kind: string): 'fix' | 'note' | 'off' {
  return kindInfo(kind)?.essay ?? 'off';
}
