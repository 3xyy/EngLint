import type { SuggestionKind } from 'harper.js';
import { precedingWords } from './match';
import type { SourcedIssue } from './sources';
import type { Category } from './types';

/** The part of Harper's Suggestion the map reads. */
export interface SuggestionLike {
  kind(): SuggestionKind | number;
  get_replacement_text(): string;
  free?(): void;
}

/** The part of Harper's Lint the map reads. Spans are UTF-16 offsets into the linted text. */
export interface LintLike {
  span(): { start: number; end: number; free?(): void };
  lint_kind(): string;
  message(): string;
  suggestions(): SuggestionLike[];
  suggestion_count(): number;
  free(): void;
}

// Harper's SuggestionKind values (Replace is 0).
const REMOVE = 1;
const INSERT_AFTER = 2;

/** Correctness kinds by Harper's lint kind. Every other kind (style, readability, redundancy…) is dropped. */
const CATEGORY_OF_KIND: Record<string, Category> = {
  Spelling: 'spelling',
  Typo: 'spelling',
  Agreement: 'grammar',
  Grammar: 'grammar',
  WordOrder: 'grammar',
  BoundaryError: 'grammar',
  Capitalization: 'grammar',
  Punctuation: 'punctuation',
  Formatting: 'punctuation',
  WordChoice: 'word_choice',
  Malapropism: 'word_choice',
  Eggcorn: 'word_choice',
  Usage: 'word_choice',
  Nonstandard: 'word_choice',
  Regionalism: 'word_choice',
};

/**
 * Rules with a kind of their own, kept whatever lint kind Harper files them under (it files AnA under
 * Miscellaneous and RepeatedWords under Repetition). Kinds and categories follow the live check's own examples:
 * a doubled word is an article error there too, so no "Stop suggesting repeated words" rule hides it.
 */
const RULES: Record<string, { kind: string; category: Category }> = {
  AnA: { kind: 'article', category: 'grammar' },
  ItsContraction: { kind: 'its_vs_it_is', category: 'grammar' },
  RepeatedWords: { kind: 'article', category: 'grammar' },
  SpellCheck: { kind: 'spelling', category: 'spelling' },
};

function fallbackKind(rule: string, lintKind: string, category: Category): string {
  if (category === 'spelling') return 'spelling';
  if (category === 'word_choice') return 'word_choice';
  if (lintKind === 'Capitalization' || /capitali[sz]/i.test(rule)) return 'capitalization';
  if (/apostrophe/i.test(rule)) return 'apostrophe';
  return 'word_choice';
}

function replacementFor(original: string, suggestion: SuggestionLike): string {
  const kind = suggestion.kind();
  if (kind === REMOVE) return '';
  if (kind === INSERT_AFTER) return original + suggestion.get_replacement_text();
  return suggestion.get_replacement_text();
}

function mapLint(paragraph: string, rule: string, lint: LintLike): SourcedIssue | null {
  const known = RULES[rule];
  const lintKind = lint.lint_kind();
  const category = known?.category ?? CATEGORY_OF_KIND[lintKind];
  if (!category) return null;
  const span = lint.span();
  const { start, end } = span;
  freeQuietly(span);
  const original = paragraph.slice(start, end);
  if (original === '') return null;
  const suggestions = lint.suggestions();
  try {
    const first = suggestions[0];
    if (!first) return null;
    return {
      original,
      replacement: replacementFor(original, first),
      before: precedingWords(paragraph, start),
      category,
      severity: 'error',
      kind: known?.kind ?? fallbackKind(rule, lintKind, category),
      reason: lint.message(),
      source: 'harper',
      ruleId: `harper:${rule}`,
      at: start,
      suggestionCount: lint.suggestion_count(),
    };
  } finally {
    for (const s of suggestions) freeQuietly(s);
  }
}

function freeQuietly(o: { free?(): void }): void {
  try {
    o.free?.();
  } catch {
    // already freed: nothing left to release
  }
}

/**
 * Harper's lints for one paragraph (from organizedLints, keyed by rule name) as Harper issues, in the order
 * given. Only correctness kinds with a fix are kept. Every lint is freed, also when mapping one throws.
 */
export function mapLints(paragraph: string, organized: Record<string, LintLike[]>): SourcedIssue[] {
  const all = Object.entries(organized).flatMap(([rule, lints]) => lints.map((lint) => [rule, lint] as const));
  const issues: SourcedIssue[] = [];
  try {
    for (const [rule, lint] of all) {
      const issue = mapLint(paragraph, rule, lint);
      if (issue) issues.push(issue);
    }
  } finally {
    for (const [, lint] of all) freeQuietly(lint);
  }
  return issues;
}
