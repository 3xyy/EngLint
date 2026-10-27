import { z } from 'zod';
import { findQuote } from './quotes';
import type { Mode } from './types';

// Schemas and parsers for the Review tab's model answers. Model text is untrusted: parsers keep only what fits.

/** zod's own conversion keeps the shape exact; `$schema` is dropped because the API schema doesn't take it. */
function toApiSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema);
  return rest;
}

export const ToneOutputSchema = z.object({ tones: z.array(z.string()) });
export const TONE_JSON_SCHEMA = toApiSchema(ToneOutputSchema);

export const MAX_TONES = 3;
export const MAX_TONE_WORDS = 3;
export const MAX_TONE_CHARS = 24;

/** 1 to 3 lowercase tone words: blank items and items over 3 words or 24 characters are dropped. Null when none are left. */
export function cleanTone(data: unknown): string[] | null {
  const parsed = ToneOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const kept = parsed.data.tones
    .map((t) => t.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((t) => t !== '' && t.length <= MAX_TONE_CHARS && t.split(' ').length <= MAX_TONE_WORDS);
  return kept.length > 0 ? kept.slice(0, MAX_TONES) : null;
}

/** Cuts `s` to `max` characters, ending in "…" when it was longer; never splits a surrogate pair. */
export function cut(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  let end = max - 1;
  const last = t.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${t.slice(0, end)}…`;
}

export interface QuoteWhy {
  quote: string;
  why: string;
}
export interface ReaderReaction {
  firstImpression: string;
  remember: string[];
  questions: string[];
  lost: QuoteWhy[];
  strength: QuoteWhy;
}

export const ReadersOutputSchema = z.object({
  first_impression: z.string(),
  remember: z.array(z.string()),
  questions: z.array(z.string()),
  lost: z.array(z.object({ quote: z.string(), why: z.string() })),
  strength: z.object({ quote: z.string(), why: z.string() }),
});
export const READERS_JSON_SCHEMA = toApiSchema(ReadersOutputSchema);

const MAX_FIRST_IMPRESSION = 400;
const MAX_ITEM = 200;
const MAX_REMEMBER = 3;
const MAX_QUESTIONS = 4;
const MAX_LOST = 4;

/**
 * The reaction with every string cut to its limit and the lists trimmed; null when the shape is wrong or the first
 * impression or the strength's reason is blank. With `guard` in Essay, a reason (`lost[].why`, `strength.why`)
 * has each long passage it quotes that is missing from the text replaced by "…" (emptied when under 3 words are left); its quote stays.
 */
export function cleanReaders(data: unknown, guard?: EssayGuard): ReaderReaction | null {
  const parsed = ReadersOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const firstImpression = cut(d.first_impression, MAX_FIRST_IMPRESSION);
  if (firstImpression === '' || cut(d.strength.why, MAX_ITEM) === '') return null;
  const why = (s: string) => cut(guardAdvice(s, guard), MAX_ITEM);
  const items = (list: string[], max: number) => list.map((x) => cut(x, MAX_ITEM)).filter((x) => x !== '').slice(0, max);
  return {
    firstImpression,
    remember: items(d.remember, MAX_REMEMBER),
    questions: items(d.questions, MAX_QUESTIONS),
    lost: d.lost
      .map((l) => ({ quote: cut(l.quote, MAX_ITEM), why: why(l.why) }))
      .filter((l) => l.quote !== '')
      .slice(0, MAX_LOST),
    strength: { quote: cut(d.strength.quote, MAX_ITEM), why: why(d.strength.why) },
  };
}

export const RATINGS = ['strong', 'solid', 'needs_work'] as const;
export type Rating = (typeof RATINGS)[number];
export interface Grading {
  criteria: { name: string; rating: Rating; evidence: { quote: string; note: string }[]; raise: string }[];
  grade: string | null;
}

const GradingShape = <R extends z.ZodType>(rating: R) =>
  z.object({
    criteria: z.array(
      z.object({
        name: z.string(),
        rating,
        evidence: z.array(z.object({ quote: z.string(), note: z.string() })),
        raise: z.string(),
      }),
    ),
    grade: z.string().nullable(),
  });
/** What the API is asked for (a rating from the list) ... */
export const GradingOutputSchema = GradingShape(z.enum(RATINGS));
export const GRADER_JSON_SCHEMA = toApiSchema(GradingOutputSchema);
/** ... and what the parser reads: any rating string, so one bad rating drops only its criterion. */
const GradingLenient = GradingShape(z.string());

const MAX_CRITERIA = 8;
const MAX_EVIDENCE = 3;
const MAX_NAME = 80;
const MAX_RAISE = 300;
const MAX_GRADE = 40;
/** A quoted passage longer than this many words must be in the document. */
const MAX_FREE_QUOTE_WORDS = 12;

/** A number is required: points, out of N, or a /100 scale. */
const NUMBERED_SCALE = /\b\d+\s*(?:points|pts|marks)\b|\bout of\s*\d+|\/\s*100\b/i;
/** "Grade:" or "grade of A-"; never "Grade 11". */
const GRADE_WORD = /\b[Gg]rade\s*:|\b[Gg]rade of [A-F][+-]?(?![A-Za-z])/;
/** A band, level or score as a row header ("Band 4: ...", "Level 3 - ..."). */
const BAND_ROW = /\b(?:[Bb]and|[Ll]evel|[Ss]core)s?\s*\d+\s*[:\-\u2013\u2014=)]/;
const BAND_NUMBER = /\b(?:[Bb]and|[Ll]evel|[Ss]core)s?\s*(\d+)/g;
/** A score range in brackets after a letter grade: "(90-100)", "(90\u2013100%)", "(80 to 89)". */
const SCORE_RANGE = String.raw`\(\s*\d{1,3}\s*%?\s*(?:[-\u2013\u2014]|to)\s*\d{1,3}\s*%?\s*\)`;
/**
 * A letter grade row, never after a word: at the start of a line or a sentence, a letter A-F (with + or -), an
 * optional score range, then a colon, an equals sign or a spaced dash ("A:", "B+ -", "A (90-100):", "A = excellent");
 * or, after a comma or semicolon, a letter and an equals sign (the "B = good" in "A = excellent, B = good").
 */
const LETTER_ROW = new RegExp(
  String.raw`(?:^|[.!?\u2026]\s+)\s*([A-F])[+-]?\s*(?:${SCORE_RANGE}\s*)?(?::|=|[-\u2013\u2014](?=\s))` +
    String.raw`|[,;]\s*([A-F])[+-]?\s*(?:${SCORE_RANGE}\s*)?=`,
  'gm',
);

/**
 * Whether a rubric defines grades: a numbered scale (30 points, out of 10, /100), "Grade:" or "grade of A-", a
 * band, level or score row header, two different band numbers, or two or more different letter-grade rows
 * (A: ... B: ..., A (90-100): ... B (80-89): ..., A = excellent, B = good). Part A / Option B, "(A)", "A)" and
 * plain prompts define none: no grade is invented.
 */
export function rubricDefinesGrades(rubric: string): boolean {
  if (NUMBERED_SCALE.test(rubric) || GRADE_WORD.test(rubric) || BAND_ROW.test(rubric)) return true;
  if (new Set([...rubric.matchAll(BAND_NUMBER)].map((m) => m[1])).size >= 2) return true;
  return new Set([...rubric.matchAll(LETTER_ROW)].map((m) => m[1] ?? m[2])).size >= 2;
}

/** A quoted passage in a string: where it starts and ends (quote marks included) and what is inside them. */
interface QuoteSpan {
  start: number;
  end: number;
  inner: string;
}

/** The passages `s` quotes, in straight or curled double quotes or curled single quotes; an unclosed quote runs to the end. */
function quoteSpans(s: string): QuoteSpan[] {
  const closers: Record<string, string> = { '"': '"', '\u201c': '\u201d', '\u2018': '\u2019' };
  const letter = /\p{L}/u;
  const out: QuoteSpan[] = [];
  let i = 0;
  while (i < s.length) {
    const close = closers[s[i]!];
    if (!close) {
      i++;
      continue;
    }
    let j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] !== close) continue;
      // A curled apostrophe inside a word (it\u2019s) does not close a single-quoted passage.
      if (close === '\u2019' && letter.test(s[j - 1] ?? '') && letter.test(s[j + 1] ?? '')) continue;
      break;
    }
    out.push({ start: i, end: Math.min(j + 1, s.length), inner: s.slice(i + 1, j) });
    i = j + 1;
  }
  return out;
}

/** Whether a quoted passage is longer than MAX_FREE_QUOTE_WORDS words and not in `text`. */
function isMissingPassage(inner: string, text: string): boolean {
  const passage = inner.trim();
  return passage.split(/\s+/).length > MAX_FREE_QUOTE_WORDS && !findQuote(text, passage);
}

/** Whether `s` quotes a passage of more than MAX_FREE_QUOTE_WORDS words that is not in `text`. */
export function quotesMissingPassage(s: string, text: string): boolean {
  return quoteSpans(s).some((q) => isMissingPassage(q.inner, text));
}

/** `s` with each quoted passage of more than MAX_FREE_QUOTE_WORDS words that is not in `text` replaced by "\u2026", quote marks included. */
export function stripMissingPassages(s: string, text: string): string {
  let out = '';
  let at = 0;
  for (const q of quoteSpans(s)) {
    if (!isMissingPassage(q.inner, text)) continue;
    out += s.slice(at, q.start) + '\u2026';
    at = q.end;
  }
  return out + s.slice(at);
}

/** The words in `s`: runs of text with a letter or digit in them (a lone "\u2026" is none). */
function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const MIN_WORDS_AFTER_STRIP = 3;

/** The text a model's advice is checked against, and its mode: the Essay guard acts only in Essay. */
export interface EssayGuard {
  text: string;
  mode: Mode;
}

/**
 * Advice under `guard`: in Essay, each long quoted passage missing from the text (it could smuggle in rewritten
 * prose) is replaced by "\u2026" and the rest kept; "" when fewer than 3 words are left. Without a guard, or outside
 * Essay, `s` as it is. Checked on the whole string, before any cut.
 */
export function guardAdvice(s: string, guard: EssayGuard | undefined): string {
  if (guard?.mode !== 'essay') return s;
  const stripped = stripMissingPassages(s, guard.text);
  return stripped === s || wordCount(stripped) >= MIN_WORDS_AFTER_STRIP ? stripped : '';
}

/**
 * The grading with its strings cut, invalid-rating criteria dropped (null when none is left), and the grade
 * kept only when `rubric` defines grades. In Essay, a `raise` or evidence note that quotes a long passage
 * missing from `text` is emptied: advice must not smuggle in rewritten prose.
 */
export function cleanGrading(data: unknown, rubric: string, text: string, mode: Mode): Grading | null {
  const parsed = GradingLenient.safeParse(data);
  if (!parsed.success) return null;
  const essay = mode === 'essay';
  const guard = (s: string) => (essay && quotesMissingPassage(s, text) ? '' : s);
  const criteria: Grading['criteria'] = [];
  for (const c of parsed.data.criteria) {
    if (!(RATINGS as readonly string[]).includes(c.rating)) continue;
    const name = cut(c.name, MAX_NAME);
    if (name === '') continue;
    criteria.push({
      name,
      rating: c.rating as Rating,
      evidence: c.evidence
        .map((e) => ({ quote: cut(e.quote, MAX_ITEM), note: cut(guard(e.note), MAX_ITEM) }))
        .filter((e) => e.quote !== '')
        .slice(0, MAX_EVIDENCE),
      raise: cut(guard(c.raise), MAX_RAISE),
    });
  }
  if (criteria.length === 0) return null;
  const grade = parsed.data.grade?.trim() ?? '';
  return {
    criteria: criteria.slice(0, MAX_CRITERIA),
    grade: grade !== '' && rubricDefinesGrades(rubric) ? cut(grade, MAX_GRADE) : null,
  };
}
