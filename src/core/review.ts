// Limits and shared constants for the Review tab's agents.

/** The most document text one review sends. */
export const MAX_REVIEW_CHARS = 30_000;
/** Tone reads this much of the start of the text. */
export const TONE_MAX_CHARS = 12_000;
/** The longest grading rubric. */
export const MAX_RUBRIC_CHARS = 6_000;
/** The longest custom reader description. */
export const MAX_READER_CHARS = 200;
/** A claim to find sources for: its shortest and longest length. */
export const MIN_CLAIM_CHARS = 8;
export const MAX_CLAIM_CHARS = 600;
/** The most text sent on each side of a claim, as its context. */
export const MAX_CLAIM_CONTEXT_CHARS = 300;
/** How often the Overview re-reads the field's text while the Review tab is shown. */
export const OVERVIEW_POLL_MS = 3000;
/** How long the text must stay unchanged before its tone is read. */
export const TONE_IDLE_MS = 10_000;
/** Fewest words a text needs before its tone is read. */
export const TONE_MIN_WORDS = 40;

/**
 * The part of `text` a review sends: all of it up to MAX_REVIEW_CHARS, else the text up to the last paragraph
 * break (any line break, as in splitParagraphs) before the limit, or a hard cut at the limit if there is none. `cut` says whether anything was left out.
 */
export function cutForReview(text: string): { text: string; cut: boolean } {
  if (text.length <= MAX_REVIEW_CHARS) return { text, cut: false };
  const head = text.slice(0, MAX_REVIEW_CHARS);
  let at = -1;
  for (const m of head.matchAll(/(?:\r\n|\n|\r)+/g)) if (m.index > 0) at = m.index;
  if (at > 0) return { text: head.slice(0, at), cut: true };
  const last = head.charCodeAt(head.length - 1);
  return { text: last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head, cut: true };
}

/** Who reads the text in Reader reactions: a fixed reader, or one the writer describes. */
export const READER_CHOICES = ['admissions', 'teacher', 'recruiter', 'general', 'custom'] as const;
export type ReaderChoice = (typeof READER_CHOICES)[number];
