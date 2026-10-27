import type { Dialect as HarperDialect } from 'harper.js';
import type { Dialect, Mode } from './types';

/** Harper's flat rule switches: true on, false off, null for the rule's own default. */
export type LintConfig = Record<string, boolean | null>;

/** Harper's "Punctuation and Spacing" group (harper.js 2.13.0). */
export const HARPER_PUNCTUATION_RULES: ReadonlySet<string> = new Set([
  'AOkHyphen', 'BluRayHyphen', 'CantWay', 'CaseSensitive', 'ClickThroughRate', 'CommaFixes', 'Dashes', 'DotInitialisms',
  'DoubleCheckHyphen', 'EagleEyed', 'EllipsisLength', 'EverPresent', 'FaceFirst', 'FirstPersonModifierHyphen',
  'FromTheGetGo', 'GuineaBissau', 'IncludingButNotLimitedToPunctuation', 'InDemandInDepth', 'IntroCueCommaBeforeThanks',
  'MercedesBenzHyphen', 'NoFrenchSpaces', 'OffTheCuff', 'OneHanded', 'OxfordComma', 'NoOxfordComma',
  'PasswordProtectedHyphen', 'PortAuPrince', 'PortoNovo', 'PostItNoteHyphen', 'QuoteSpacing', 'RainbowColoredHyphen',
  'RapidFire', 'Spaces', 'ToDoHyphen', 'TransposedSpace', 'UnclosedQuotes', 'UseEllipsisCharacter', 'WellBeing',
  'WorstCaseScenario', 'WrongApostrophe',
]);

/** Harper's "Capitalization and Case" group (harper.js 2.13.0). */
export const HARPER_CAPITALIZATION_RULES: ReadonlySet<string> = new Set([
  'CapitalizePersonalPronouns', 'ColdModalTypo', 'GoggleBrand', 'JohnsHopkins', 'NumberSuffixCapitalization',
  'SentenceCapitalization', 'TheProperNounPossessive', 'UseTitleCase', 'WordPressDotcom', 'YeaToYeah', 'YehToYeah',
]);

/** The family Harper files a rule under, when it is punctuation or capitalization; null for every other rule. */
export function harperRuleFamily(rule: string): 'punctuation' | 'capitalization' | null {
  if (HARPER_PUNCTUATION_RULES.has(rule)) return 'punctuation';
  if (HARPER_CAPITALIZATION_RULES.has(rule)) return 'capitalization';
  return null;
}

/** Off in every mode: the Oxford comma is the writer's choice, and long sentences are a style note. */
const ALWAYS_OFF = ['OxfordComma', 'LongSentences'];

/**
 * Harper's rules for a mode, from its default config: OxfordComma and LongSentences off everywhere, and in Casual
 * also SentenceCapitalization and every punctuation and capitalization rule. Only rules the base has are touched.
 */
export function harperConfig(mode: Mode, base: LintConfig): LintConfig {
  const off = (rule: string) => ALWAYS_OFF.includes(rule) || (mode === 'casual' && harperRuleFamily(rule) !== null);
  return Object.fromEntries(Object.entries(base).map(([rule, on]) => [rule, off(rule) ? false : on]));
}

// Harper's Dialect values (American = 0, British = 1, Australian = 2, Canadian = 3, Indian = 4).
const DIALECTS: Record<Dialect, HarperDialect> = {
  'en-US': 0,
  'en-GB': 1,
  'en-AU': 2,
  'en-CA': 3,
  'en-IN': 4,
};

export function harperDialect(d: Dialect): HarperDialect {
  return DIALECTS[d];
}
