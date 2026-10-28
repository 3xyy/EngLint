import { changesClaims } from './claims';
import { essayPolicy, kindInfo, RETIRED_KINDS, toggleOf } from './kinds';
import { isCasualSuppressedEdit, isSuppressedEdit } from './suppress';
import type { FamilyToggle, FamilyToggles, LocatedIssue, Mode, Paragraph, RawIssue, SuggestionFamily } from './types';
import { carryTypography, dictionaryForm, foldTypography } from './typography';

/** At most this many suggestions per paragraph (errors are never capped). */
export const MAX_SUGGESTIONS = 5;
/** At most this many suggestions per paragraph from any one family. */
export const MAX_PER_FAMILY = 3;
/** Essay: a suggestion whose replacement adds more words than this becomes comment-only. */
const ESSAY_MAX_ADDED_WORDS = 3;

export interface SuggestionPolicy {
  mode: Mode;
  families: FamilyToggles;
  /** The kinds turned off for this mode. */
  rules: ReadonlySet<string>;
  /** Dictionary words, stored lowercased. */
  dictionary: ReadonlySet<string>;
}

const norm = (s: string) => s.replace(/[\s\u00a0]+/g, ' ').trim();

/**
 * A change that changes nothing: the same text, or for a suggestion the same words in another case or spacing
 * ("many different tasks" -> "Many different tasks"). An error keeps a case-only fix: that is a capitalization fix.
 */
const isNoOp = (issue: Pick<RawIssue, 'severity'>, original: string, replacement: string | null) =>
  replacement === original ||
  (issue.severity === 'suggestion' && replacement !== null && norm(replacement).toLowerCase() === norm(original).toLowerCase());

export function issueId(paragraphHash: string, relStart: number, kind: string): string {
  return `${paragraphHash}:${relStart}:${kind}`;
}

function occurrences(text: string, sub: string): number[] {
  const occ: number[] = [];
  for (let i = text.indexOf(sub); i !== -1; i = text.indexOf(sub, i + 1)) occ.push(i);
  return occ;
}

/** The only occurrence, or the one `before` singles out; null when none or still ambiguous. */
function pickOccurrence(text: string, occ: number[], before: string): number | null {
  if (occ.length === 0) return null;
  if (occ.length === 1) return occ[0]!;
  const wanted = norm(before);
  const kept = occ.filter((i) => {
    const preceding = norm(text.slice(0, i));
    return wanted === '' ? preceding === '' : preceding.endsWith(wanted);
  });
  return kept.length === 1 ? kept[0]! : null;
}

/** Up to five words ahead of `index` in `text`: the `before` a local source gives an issue it found there. */
export const precedingWords = (text: string, index: number): string =>
  text.slice(0, index).split(/\s+/).filter(Boolean).slice(-5).join(' ');

/**
 * Find `original` in the paragraph. An `at` offset is taken when the paragraph has `original` there;
 * otherwise search, where `before` only disambiguates repeated occurrences. When the exact search
 * fails, search again with curly quotes, dashes, NBSP and ellipses folded on both sides, under the
 * same rules, and map the match back to the paragraph's own offsets. No fuzzy matching.
 */
export function locateIssue(
  paragraphText: string,
  issue: Pick<RawIssue, 'original' | 'before'> & { at?: number },
): { start: number; end: number } | null {
  const { original, at: given } = issue;
  if (original === '') return null;
  if (given !== undefined && given >= 0 && paragraphText.slice(given, given + original.length) === original) {
    return { start: given, end: given + original.length };
  }
  const exact = pickOccurrence(paragraphText, occurrences(paragraphText, original), issue.before);
  if (exact !== null) return { start: exact, end: exact + original.length };

  const { folded, toOriginal } = foldTypography(paragraphText);
  const needle = foldTypography(original).folded;
  // A match must start and end on whole characters of the paragraph, not inside a folded `…`.
  const onBoundary = (i: number) => i === 0 || toOriginal[i] !== toOriginal[i - 1];
  const occ = occurrences(folded, needle).filter((i) => onBoundary(i) && onBoundary(i + needle.length));
  const at = pickOccurrence(folded, occ, foldTypography(issue.before).folded);
  if (at === null) return null;
  return { start: toOriginal[at]!, end: toOriginal[at + needle.length]! };
}

const WORD = /[\p{L}\p{N}'’]+/gu;

/** Words in `replacement` that aren't in `original`, as a case-insensitive multiset. */
export function addedWords(original: string, replacement: string): number {
  const words = (s: string) => s.toLowerCase().replace(/’/g, "'").match(WORD) ?? [];
  const have = new Map<string, number>();
  for (const w of words(original)) have.set(w, (have.get(w) ?? 0) + 1);
  let added = 0;
  for (const w of words(replacement)) {
    const n = have.get(w) ?? 0;
    if (n > 0) have.set(w, n - 1);
    else added++;
  }
  return added;
}

/** Essay: a replacement adding more new words than this allows can't be one click away (comment-only, or Copy). */
export function addsTooManyForEssay(original: string, replacement: string): boolean {
  return addedWords(original, replacement) > ESSAY_MAX_ADDED_WORDS;
}

/**
 * The toggle a suggestion falls under: a known kind's own family (generic phrasing has its own toggle),
 * else the model's category. One left in an error category is governed like clarity, so turning every
 * family off still hides every suggestion.
 */
export const suggestionToggle = (issue: Pick<RawIssue, 'severity' | 'category' | 'kind'>): FamilyToggle => toggleOf(issue) ?? 'clarity';
/** Generic phrasing shares the delivery cap. */
export const capFamily = (issue: RawIssue): SuggestionFamily => {
  const toggle = suggestionToggle(issue);
  return toggle === 'generic' ? 'delivery' : toggle;
};
const FAMILY_PRIORITY: Record<SuggestionFamily, number> = { clarity: 0, engagement: 1, delivery: 2 };

/**
 * The issue as it may be shown (perhaps made comment-only), or null when it's hidden. In order:
 * retired kind, a suggestion with a correctness kind, suppress, casual, error without a fix, no-op, toggles,
 * Essay `off` (which includes every kind not listed), rules, dictionary, then the comment-only transforms
 * (Essay `note`, added words, claims).
 */
function admit(issue: RawIssue, policy: SuggestionPolicy): RawIssue | null {
  const { original, replacement, kind } = issue;
  const suggestion = issue.severity === 'suggestion';
  if (RETIRED_KINDS.includes(kind)) return null;
  // A correctness kind belongs on an error; as a suggestion it is malformed. A kind the model invents goes on:
  // its category decides its toggle, and Essay turns it off.
  if (suggestion && kindInfo(kind)?.family === 'correctness') return null;
  if (isSuppressedEdit(original, replacement)) return null;
  if (policy.mode === 'casual' && (suggestion || isCasualSuppressedEdit(original, replacement))) return null;
  // A comment-only note is kept for suggestions, which offer "Rewrite sentence"; an error needs a fix to apply.
  if (replacement === null && !suggestion) return null;
  if (isNoOp(issue, original, replacement)) return null;
  if (suggestion && !policy.families[suggestionToggle(issue)]) return null;
  // Essay policy is for suggestions only: errors keep their minimal fixes.
  const essay = suggestion && policy.mode === 'essay' ? essayPolicy(kind) : null;
  if (essay === 'off') return null;
  if (policy.rules.has(kind)) return null;
  if (issue.category === 'spelling' && policy.dictionary.has(dictionaryForm(original))) return null;
  if (!suggestion || replacement === null) return issue;
  const commentOnly =
    essay === 'note' ||
    (essay === 'fix' && addsTooManyForEssay(original, replacement)) ||
    changesClaims(original, replacement);
  return commentOnly ? { ...issue, replacement: null } : issue;
}

/** `raw` is one paragraph's issues; one from a local source may carry `at` (see SourcedIssue), tried first when locating. */
export function selectIssues(paragraph: Paragraph, raw: (RawIssue & { at?: number })[], policy: SuggestionPolicy): LocatedIssue[] {
  type Located = { issue: RawIssue; model: RawIssue; start: number; end: number };
  const located: Located[] = [];
  for (const candidate of raw) {
    const issue = admit(candidate, policy);
    if (!issue) continue;
    const pos = locateIssue(paragraph.text, issue);
    if (!pos) continue;
    // `original` is the document's own text (it differs after the typography fallback), and the fix
    // takes on the document's curled quotes.
    const original = paragraph.text.slice(pos.start, pos.end);
    const replacement = issue.replacement === null ? null : carryTypography(original, issue.replacement);
    if (isNoOp(issue, original, replacement)) continue; // the fix only restyles or recases what the document already has
    located.push({ issue: { ...issue, original, replacement }, model: candidate, ...pos });
  }

  // Errors outrank suggestions, then earlier start; drop anything overlapping an accepted range.
  const ranked = [...located].sort(
    (a, b) =>
      Number(b.issue.severity === 'error') - Number(a.issue.severity === 'error') || a.start - b.start,
  );
  const accepted: Located[] = [];
  for (const cand of ranked) {
    if (!accepted.some((a) => cand.start < a.end && a.start < cand.end)) accepted.push(cand);
  }

  // Caps: errors are always kept. Suggestions go by family priority, then the earlier start.
  const suggestions = accepted
    .filter((a) => a.issue.severity === 'suggestion')
    .map((a) => ({ a, family: capFamily(a.issue) }))
    .sort((x, y) => FAMILY_PRIORITY[x.family] - FAMILY_PRIORITY[y.family] || x.a.start - y.a.start);
  const kept = new Set<Located>();
  const perFamily: Record<SuggestionFamily, number> = { clarity: 0, engagement: 0, delivery: 0 };
  for (const { a, family } of suggestions) {
    if (kept.size >= MAX_SUGGESTIONS) break;
    if (perFamily[family] >= MAX_PER_FAMILY) continue;
    perFamily[family]++;
    kept.add(a);
  }

  return accepted
    .filter((a) => a.issue.severity === 'error' || kept.has(a))
    .sort((a, b) => a.start - b.start)
    .map(({ issue, model, start, end }) => ({
      ...issue,
      model: { original: model.original, replacement: model.replacement },
      id: issueId(paragraph.hash, start, issue.kind),
      paragraphHash: paragraph.hash,
      start: paragraph.start + start,
      end: paragraph.start + end,
    }));
}
