// @vitest-environment node
import { Dialect as HarperDialect, LocalLinter, type StructuredLintConfig } from 'harper.js';
import { slimBinary } from 'harper.js/slimBinary';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  HARPER_CAPITALIZATION_RULES,
  HARPER_PUNCTUATION_RULES,
  harperConfig,
  harperDialect,
  harperRuleFamily,
  type LintConfig,
} from '../../src/core/harper-config';
import { HARPER_INSTANT, HARPER_TRUSTED } from '../../src/core/sources';
import type { Dialect, Mode } from '../../src/core/types';

const MODES: Mode[] = ['essay', 'standard', 'casual'];
const BASE: LintConfig = {
  OxfordComma: true,
  NoOxfordComma: false,
  LongSentences: true,
  SentenceCapitalization: true,
  CapitalizePersonalPronouns: true,
  CommaFixes: true,
  Spaces: true,
  AnA: true,
  RepeatedWords: true,
  ItsContraction: true,
  SpellCheck: true,
  PossessiveNoun: false,
  Unset: null,
};

describe('harperConfig', () => {
  it('turns OxfordComma and LongSentences off in every mode', () => {
    for (const mode of MODES) {
      const config = harperConfig(mode, BASE);
      expect(config.OxfordComma, mode).toBe(false);
      expect(config.LongSentences, mode).toBe(false);
    }
  });

  it('keeps SentenceCapitalization and the punctuation and capitalization rules outside Casual', () => {
    for (const mode of ['essay', 'standard'] as const) {
      const config = harperConfig(mode, BASE);
      expect(config.SentenceCapitalization, mode).toBe(true);
      expect(config.CapitalizePersonalPronouns, mode).toBe(true);
      expect(config.CommaFixes, mode).toBe(true);
      expect(config.Spaces, mode).toBe(true);
    }
  });

  it('turns off SentenceCapitalization and every punctuation and capitalization rule in Casual', () => {
    const config = harperConfig('casual', BASE);
    expect(config.SentenceCapitalization).toBe(false);
    expect(config.CapitalizePersonalPronouns).toBe(false);
    expect(config.CommaFixes).toBe(false);
    expect(config.Spaces).toBe(false);
  });

  it('leaves every other rule as the base has it, including unset ones', () => {
    for (const mode of MODES) {
      const config = harperConfig(mode, BASE);
      expect(config.AnA).toBe(true);
      expect(config.RepeatedWords).toBe(true);
      expect(config.ItsContraction).toBe(true);
      expect(config.SpellCheck).toBe(true);
      expect(config.NoOxfordComma).toBe(false);
      expect(config.PossessiveNoun).toBe(false);
      expect(config.Unset).toBeNull();
    }
  });

  it('adds no rule the base lacks and never changes the base', () => {
    const before = structuredClone(BASE);
    for (const mode of MODES) expect(Object.keys(harperConfig(mode, BASE)).sort()).toEqual(Object.keys(BASE).sort());
    expect(BASE).toEqual(before);
    expect(harperConfig('casual', { AnA: true })).toEqual({ AnA: true });
  });
});

describe('harperRuleFamily', () => {
  it('names the punctuation and capitalization rules, and nothing else', () => {
    expect(harperRuleFamily('CommaFixes')).toBe('punctuation');
    expect(harperRuleFamily('OxfordComma')).toBe('punctuation');
    expect(harperRuleFamily('SentenceCapitalization')).toBe('capitalization');
    expect(harperRuleFamily('CapitalizePersonalPronouns')).toBe('capitalization');
    expect(harperRuleFamily('AnA')).toBeNull();
    expect(harperRuleFamily('ItsContraction')).toBeNull();
    // Phrase corrections whose names only look like case or capitalization rules.
    expect(harperRuleFamily('CaseInPoint')).toBeNull();
    expect(harperRuleFamily('ShowCase')).toBeNull();
    expect(harperRuleFamily('NationalCapitals')).toBeNull();
  });
});

describe('harperDialect', () => {
  it('maps all five dialects to Harper’s', () => {
    const expected: Record<Dialect, HarperDialect> = {
      'en-US': HarperDialect.American,
      'en-GB': HarperDialect.British,
      'en-CA': HarperDialect.Canadian,
      'en-AU': HarperDialect.Australian,
      'en-IN': HarperDialect.Indian,
    };
    for (const [ours, theirs] of Object.entries(expected)) expect(harperDialect(ours as Dialect), ours).toBe(theirs);
  });
});

/** Rule names under each top-level group of Harper's structured config. */
function groups(config: StructuredLintConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const setting of config.settings) {
    if (!('Group' in setting)) continue;
    const names = setting.Group.child.settings.flatMap((s) =>
      'Bool' in s ? [s.Bool.name] : 'OneOfMany' in s ? s.OneOfMany.names : [],
    );
    out.set(setting.Group.label, names);
  }
  return out;
}

describe('against the harper.js binary', () => {
  let defaults: LintConfig;
  let structured: StructuredLintConfig;
  let linter: LocalLinter;
  beforeAll(async () => {
    linter = new LocalLinter({ binary: slimBinary });
    await linter.setup();
    defaults = await linter.getDefaultLintConfig();
    structured = await linter.getStructuredLintConfig();
  });

  it('enables OxfordComma, LongSentences and SentenceCapitalization by default', () => {
    expect(defaults.OxfordComma).toBe(true);
    expect(defaults.LongSentences).toBe(true);
    expect(defaults.SentenceCapitalization).toBe(true);
  });

  it('knows every instant and trusted rule by that exact name', () => {
    for (const rule of [...HARPER_INSTANT, ...HARPER_TRUSTED]) expect(defaults, rule).toHaveProperty(rule, true);
  });

  it('files the punctuation and capitalization rules under its own groups of those names', () => {
    const byGroup = groups(structured);
    expect([...HARPER_PUNCTUATION_RULES].sort()).toEqual([...byGroup.get('Punctuation and Spacing')!].sort());
    expect([...HARPER_CAPITALIZATION_RULES].sort()).toEqual([...byGroup.get('Capitalization and Case')!].sort());
  });

  it('accepts the Casual config and then stops flagging case and punctuation', async () => {
    const text = 'It rained. the cat sat , and i went home.';
    const rules = async () =>
      Object.entries(await linter.organizedLints(text, { language: 'plaintext', dedup: true }))
        .filter(([, lints]) => lints.length > 0)
        .map(([rule]) => rule);
    await linter.setLintConfig(harperConfig('standard', defaults));
    expect(await rules()).toEqual(expect.arrayContaining(['CapitalizePersonalPronouns', 'CommaFixes', 'SentenceCapitalization']));
    await linter.setLintConfig(harperConfig('casual', defaults));
    expect(await rules()).toEqual([]);
  });
});
