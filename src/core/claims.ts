import { foldTypography } from './typography';

/**
 * Claims guard: a suggestion whose replacement changes a number, a date, a
 * capitalised name or quoted text must not be one click away. Callers make it comment-only.
 */
const NUMBER = /\d[\d,.:/-]*/g;
/** Apostrophes only inside a word, so a single-quoted ‘Alice’ (folded 'Alice') is the word Alice. */
const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const QUOTED = /"([^"]*)"/g;
const MONTHS_AND_WEEKDAYS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);
/** Everyday words in lower case ("you may", "they march"); only the capitalised form is the month. */
const MONTH_ONLY_CAPITALISED = new Set(['may', 'march']);
/** The pronoun, not a name. */
const PRONOUN_I = /^I(?:'(?:m|d|ve|ll))?$/;
const capitalised = (w: string) => /^\p{Lu}/u.test(w);
const isName = (w: string) => capitalised(w) && !PRONOUN_I.test(w);

/** Folded, so “no” and "no" are the same quote and ’ reads as '. */
const fold = (s: string) => foldTypography(s).folded;
const wordsOf = (folded: string) => folded.match(WORD) ?? [];

/** A period after one of these, or after a single capital (J. Okafor, U.S. Army), ends no sentence. */
const TITLE_OR_INITIAL = /(?:^|[^\p{L}\p{N}])(?:Dr|Mr|Mrs|Ms|Mx|Prof|St|Mt|Jr|Sr|Rev|\p{Lu})\.$/u;

/**
 * Whether the word at `at` starts a sentence: it opens the text or a line, or follows `.`, `!` or `?` with only
 * spaces, quotes and brackets between.
 */
function startsSentence(folded: string, at: number): boolean {
  const before = folded.slice(0, at);
  const gap = /[\s"'()[\]{}«»]*$/u.exec(before)![0];
  const rest = before.slice(0, before.length - gap.length);
  return rest === '' || gap.includes('\n') || (/[.!?]$/u.test(rest) && !TITLE_OR_INITIAL.test(rest));
}

/** `countsName`: whether the capitalised word `w`, the `i`th word, at offset `at`, is a name to count. */
function claimTokens(folded: string, countsName: (w: string, i: number, at: number) => boolean): string[] {
  const out: string[] = [];
  // A trailing separator is sentence punctuation ("in 2025, we"), not part of the number.
  for (const m of folded.matchAll(NUMBER)) out.push(`n:${m[0].replace(/[,.:/-]+$/, '')}`);
  [...folded.matchAll(WORD)].forEach((m, i) => {
    const w = m[0];
    const lower = w.toLowerCase().replace(/'s$/, '');
    if (MONTHS_AND_WEEKDAYS.has(lower) && (!MONTH_ONLY_CAPITALISED.has(lower) || capitalised(w))) out.push(`d:${lower}`);
    if (isName(w) && countsName(w, i, m.index)) out.push(`c:${w}`);
  });
  for (const m of folded.matchAll(QUOTED)) out.push(`q:${m[1]}`);
  return out;
}

export interface ClaimsOptions {
  /**
   * `'strict'` (the default): only each side's first word is exempt from the capitalised-word rule, unless the
   * other side has it capitalised anywhere (then it's a name that moved: "… by John" → "John …").
   * `'lenient'`: the first word of every sentence is exempt (see `startsSentence`; a period after a title or a single
   * capital ends no sentence), unless it is used capitalised mid-sentence on either side. Sentence openers such as
   * "Moreover," or "Every" can then go or change at any sentence start.
   */
  sentenceStarts?: 'strict' | 'lenient';
}

/**
 * True when the multiset of number tokens, month and weekday names, capitalised words or quoted segments differs
 * between the two. Which sentence-initial capitals count is `options.sentenceStarts`.
 * Known gaps: strict misses a name that is the first word and is dropped ("Alice went home" → "She went home");
 * lenient misses one at any sentence start that never appears mid-sentence ("We met. Alice was late." → "We met.
 * Maria was late.").
 */
export function changesClaims(original: string, replacement: string, options: ClaimsOptions = {}): boolean {
  const [fa, fb] = [fold(original), fold(replacement)];
  let a: string[];
  let b: string[];
  if (options.sentenceStarts === 'lenient') {
    const midNames = new Set(
      [fa, fb].flatMap((folded) => [...folded.matchAll(WORD)].filter((m) => isName(m[0]) && !startsSentence(folded, m.index)).map((m) => m[0])),
    );
    const counts = (folded: string) => (w: string, _i: number, at: number) => midNames.has(w) || !startsSentence(folded, at);
    a = claimTokens(fa, counts(fa)).sort();
    b = claimTokens(fb, counts(fb)).sort();
  } else {
    const names = (folded: string) => new Set(wordsOf(folded).filter(isName));
    // The first word is exempt (it's capitalised for the sentence), unless the other side has it capitalised too.
    const counts = (otherNames: ReadonlySet<string>) => (w: string, i: number) => i > 0 || otherNames.has(w);
    a = claimTokens(fa, counts(names(fb))).sort();
    b = claimTokens(fb, counts(names(fa))).sort();
  }
  return a.length !== b.length || a.some((t, i) => t !== b[i]);
}
