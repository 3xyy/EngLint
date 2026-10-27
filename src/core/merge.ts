import { locateIssue } from './match';
import { HARPER_INSTANT, HARPER_TRUSTED, harperRule, NEVER_DOUBLED, type ParagraphRaw, type SourcedIssue } from './sources';
import type { RawIssue } from './types';

type Range = { start: number; end: number };

const overlapsAny = (range: Range | null, taken: Range[]): boolean =>
  range !== null && taken.some((t) => range.start < t.end && t.start < range.end);

/** One word written twice or more ("the the", "The The"), and a word never correctly doubled. */
function isNeverDoubled(original: string): boolean {
  const words = original.toLowerCase().split(/\s+/);
  return words.length > 1 && words.every((w) => w === words[0]) && NEVER_DOUBLED.has(words[0]!);
}

/** The word after an article, past an opening quote or bracket, up to a space or hyphen ("STEM" in "a STEM-focused"). */
const NEXT_WORD = /^\s*["“‘(\[]*([\p{L}\p{N}.&'’]+)/u;

/**
 * An article before an all-caps word of two or more letters (STEM, SAT, U.S.). Harper reads some of these letter by
 * letter and others as words ("a STEM" becomes "an STEM", "an SAT" becomes "a SAT"), so its fix there is left to Claude.
 */
function beforeAcronym(text: string, range: Range | null): boolean {
  if (!range) return false;
  const word = NEXT_WORD.exec(text.slice(range.end))?.[1] ?? '';
  // A possessive or plural after the capitals ("SAT's", "SATs") is still the acronym.
  const letters = word.replace(/(\p{Lu}{2,})(?:['’]s|s)$/u, '$1').replace(/[^\p{L}]/gu, '');
  return letters.length >= 2 && !/\p{Ll}/u.test(letters);
}

/** Only zero-width spaces, where editors park the caret, or nothing after the range: the word may still be typed. */
const endsParagraph = (text: string, range: Range | null): boolean =>
  range !== null && /^[\u200b\ufeff]*$/.test(text.slice(range.end));

/**
 * Where a rule is known to go wrong, before and after Claude answers.
 * - SpellCheck: only on a word that starts lowercase, never as a swap to another capitalized word (abuela →
 *   Manuela; instagram → Instagram is fine), and never on the paragraph's last word, which may be half typed.
 * - RepeatedWords: only on a word never correctly doubled.
 * - AnA: never before an acronym.
 */
function passesGuards(issue: SourcedIssue, text: string, range: Range | null): boolean {
  switch (harperRule(issue.ruleId)) {
    case 'SpellCheck': {
      const { original, replacement } = issue;
      if (!/^\p{Ll}/u.test(original) || endsParagraph(text, range)) return false;
      return replacement === null || !/^\p{Lu}/u.test(replacement) || replacement.toLowerCase() === original.toLowerCase();
    }
    case 'RepeatedWords':
      return isNeverDoubled(issue.original);
    case 'AnA':
      return !beforeAcronym(text, range);
    default:
      return true;
  }
}

/** The free floor: an instant rule with exactly one fix, past its guards. */
function isInstant(issue: SourcedIssue, text: string, range: Range | null): boolean {
  const rule = harperRule(issue.ruleId);
  if (!HARPER_INSTANT.has(rule) || issue.suggestionCount !== 1 || issue.replacement === null) return false;
  return passesGuards(issue, text, range);
}

/**
 * One paragraph's issues from every source, as one list for selectIssues: Claude's, then Harper's,
 * then the tells, so equal ties in selection go to Claude first.
 * - Before Claude has answered (no `claude` entry), Harper's instant issues stand in.
 * - Once it has (an empty list counts), Claude is final for correctness: only trusted Harper rules
 *   stay, past their guards, and only where they overlap no Claude error. Every error Claude reported counts, shown or
 *   not (the settings and dismissals apply later); a Claude suggestion blocks nothing here, and
 *   selection ranks the Harper error above it.
 * - A tell stays unless it overlaps any Claude issue or a Harper issue kept here.
 * Ranges come from locateIssue, as in selection; an issue that can't be located blocks nothing.
 */
export function mergeParagraph(paragraphText: string, raw: ParagraphRaw): RawIssue[] {
  const claude = raw.claude ?? [];
  if (!raw.harper?.length && !raw.tells?.length) return claude;

  const locate = (issue: RawIssue | SourcedIssue) => locateIssue(paragraphText, issue);
  const located = (issues: (RawIssue | SourcedIssue)[]) =>
    issues.map(locate).filter((r): r is Range => r !== null);

  const claudeLocated = claude.map((issue) => ({ error: issue.severity === 'error', range: locate(issue) }));
  const claudeRanges = claudeLocated.flatMap(({ range }) => (range ? [range] : []));
  const claudeErrorRanges = claudeLocated.flatMap(({ error, range }) => (error && range ? [range] : []));
  const harper = (raw.harper ?? []).filter((issue) => {
    const range = locate(issue);
    if (raw.claude === undefined) return isInstant(issue, paragraphText, range);
    return HARPER_TRUSTED.has(harperRule(issue.ruleId)) && !overlapsAny(range, claudeErrorRanges) && passesGuards(issue, paragraphText, range);
  });
  const taken = [...claudeRanges, ...located(harper)];
  const tells = (raw.tells ?? []).filter((issue) => !overlapsAny(locate(issue), taken));
  return [...claude, ...harper, ...tells];
}
