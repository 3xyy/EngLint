import { describe, expect, it } from 'vitest';
import { KINDS, RETIRED_KINDS, essayPolicy, familyName, familyOf, kindInfo, shownFamily, toggleOf, typeLabel } from '../../src/core/kinds';

const fam = (kind: string) => kindInfo(kind)?.family;

describe('KINDS', () => {
  it('puts the suggestion kinds in the families of the taxonomy, all rule-eligible with a label', () => {
    const table: Record<string, string[]> = {
      clarity: ['wordy_phrase', 'redundancy', 'long_sentence', 'passive_voice', 'unclear_reference', 'complex_word'],
      engagement: ['repeated_word', 'overused_word', 'vague_word', 'sentence_variety'],
      delivery: ['hedging', 'formality', 'inclusive_language', 'generic_phrasing'],
    };
    // lc-5 tuning dropped politeness: 0 correct and 2 false positives across the suggestion eval runs.
    expect(kindInfo('politeness')).toBeUndefined();
    for (const [family, kinds] of Object.entries(table)) {
      for (const k of kinds) {
        const info = kindInfo(k);
        expect(info, k).toBeDefined();
        expect(info!.family, k).toBe(family);
        expect(info!.ruleEligible, k).toBe(true);
        expect(info!.label.length, k).toBeGreaterThan(0);
      }
    }
  });

  it('has the Essay policy of 6.1', () => {
    for (const k of ['wordy_phrase', 'redundancy', 'passive_voice', 'complex_word', 'repeated_word', 'overused_word', 'inclusive_language', 'generic_phrasing'])
      expect(essayPolicy(k), k).toBe('fix');
    for (const k of ['long_sentence', 'unclear_reference', 'sentence_variety', 'vague_word']) expect(essayPolicy(k), k).toBe('note');
    for (const k of ['hedging', 'formality']) expect(essayPolicy(k), k).toBe('off');
  });

  it('essayPolicy of a kind not listed is off', () => {
    expect(essayPolicy('made_up_kind')).toBe('off');
  });

  it('keeps the error kinds correctness with their old ruleEligible', () => {
    const eligible = ['oxford_comma', 'contraction', 'sentence_start_conjunction'];
    const errors = KINDS.filter((k) => k.family === 'correctness');
    expect(errors.map((k) => k.kind)).toHaveLength(18);
    for (const k of errors) {
      expect(k.ruleEligible, k.kind).toBe(eligible.includes(k.kind));
      expect(k.label.length, k.kind).toBeGreaterThan(0);
      expect(k.essay, k.kind).toBe('fix');
    }
    expect(fam('spelling')).toBe('correctness');
  });

  it('has unique kinds', () => {
    expect(new Set(KINDS.map((k) => k.kind)).size).toBe(KINDS.length);
  });
});

describe('familyOf / toggleOf', () => {
  it('maps a suggestion category to its family', () => {
    expect(familyOf({ severity: 'suggestion', category: 'engagement' })).toBe('engagement');
    expect(familyOf({ severity: 'suggestion', category: 'delivery' })).toBe('delivery');
    expect(familyOf({ severity: 'suggestion', category: 'clarity' })).toBe('clarity');
  });
  it('treats errors and non-suggestion categories as correctness', () => {
    expect(familyOf({ severity: 'error', category: 'grammar' })).toBe('correctness');
    expect(familyOf({ severity: 'error', category: 'clarity' })).toBe('correctness');
    expect(familyOf({ severity: 'suggestion', category: 'grammar' })).toBe('correctness');
  });
  it('treats an unknown suggestion category as clarity', () => {
    expect(familyOf({ severity: 'suggestion', category: 'tone' as never })).toBe('clarity');
  });
  it('toggleOf: generic_phrasing is generic, errors are null, others follow the family', () => {
    expect(toggleOf({ severity: 'suggestion', category: 'delivery', kind: 'generic_phrasing' })).toBe('generic');
    expect(toggleOf({ severity: 'suggestion', category: 'delivery', kind: 'hedging' })).toBe('delivery');
    expect(toggleOf({ severity: 'suggestion', category: 'engagement', kind: 'vague_word' })).toBe('engagement');
    expect(toggleOf({ severity: 'error', category: 'grammar', kind: 'verb_tense' })).toBeNull();
    expect(toggleOf({ severity: 'error', category: 'delivery', kind: 'generic_phrasing' })).toBeNull();
  });
  it('a known suggestion kind takes its family from KINDS, whatever category the model filed it under', () => {
    expect(familyOf({ severity: 'suggestion', category: 'clarity', kind: 'vague_word' })).toBe('engagement');
    expect(familyOf({ severity: 'suggestion', category: 'word_choice', kind: 'repeated_word' })).toBe('engagement');
    expect(familyOf({ severity: 'suggestion', category: 'engagement', kind: 'complex_word' })).toBe('clarity');
    expect(toggleOf({ severity: 'suggestion', category: 'clarity', kind: 'vague_word' })).toBe('engagement');
    expect(toggleOf({ severity: 'suggestion', category: 'engagement', kind: 'generic_phrasing' })).toBe('generic');
    expect(toggleOf({ severity: 'suggestion', category: 'grammar', kind: 'generic_phrasing' })).toBe('generic');
    // An error stays correctness, whatever its kind.
    expect(familyOf({ severity: 'error', category: 'grammar', kind: 'vague_word' })).toBe('correctness');
  });
  it('an invented kind still follows its category', () => {
    expect(familyOf({ severity: 'suggestion', category: 'delivery', kind: 'made_up' })).toBe('delivery');
    expect(toggleOf({ severity: 'suggestion', category: 'engagement', kind: 'made_up' })).toBe('engagement');
    expect(familyOf({ severity: 'suggestion', category: 'grammar', kind: 'made_up' })).toBe('correctness');
  });
});

describe('RETIRED_KINDS', () => {
  it('lists the dropped kinds, none of which is still in KINDS', () => {
    expect(RETIRED_KINDS).toEqual(['politeness']);
    for (const k of RETIRED_KINDS) expect(kindInfo(k), k).toBeUndefined();
  });
});

describe('actions and type labels', () => {
  it('gives every kind an action: an imperative of at most 4 words, in sentence case', () => {
    for (const k of KINDS) {
      const words = k.action.trim().split(/\s+/);
      expect(k.action.trim(), k.kind).not.toBe('');
      expect(words.length, k.kind).toBeLessThanOrEqual(4);
      expect(k.action, k.kind).toMatch(/^[A-Z]/);
      expect(words.slice(1).filter((w) => /^[A-Z]/.test(w) && w !== 'Oxford'), k.kind).toEqual([]);
      expect(k.action, k.kind).not.toMatch(/[.!?]$/);
    }
  });

  it('names the families, generic phrasing included', () => {
    expect((['correctness', 'clarity', 'engagement', 'delivery', 'generic'] as const).map(familyName)).toEqual([
      'Correctness', 'Clarity', 'Engagement', 'Delivery', 'Generic phrasing',
    ]);
  });

  it('shows an error as correctness, generic phrasing as its own family, and other suggestions under their family', () => {
    expect(shownFamily({ severity: 'error', category: 'grammar', kind: 'verb_tense' })).toBe('correctness');
    expect(shownFamily({ severity: 'error', category: 'delivery', kind: 'generic_phrasing' })).toBe('correctness');
    expect(shownFamily({ severity: 'suggestion', category: 'delivery', kind: 'generic_phrasing' })).toBe('generic');
    expect(shownFamily({ severity: 'suggestion', category: 'delivery', kind: 'hedging' })).toBe('delivery');
    expect(shownFamily({ severity: 'suggestion', category: 'clarity', kind: 'vague_word' })).toBe('engagement');
  });

  it('labels an issue "{Family} · {action}"', () => {
    expect(typeLabel({ severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase' })).toBe('Clarity · Cut wordiness');
    expect(typeLabel({ severity: 'error', category: 'spelling', kind: 'spelling' })).toBe('Correctness · Fix the spelling');
    expect(typeLabel({ severity: 'error', category: 'grammar', kind: 'subject_verb_agreement' })).toBe('Correctness · Fix subject-verb agreement');
    expect(typeLabel({ severity: 'suggestion', category: 'clarity', kind: 'passive_voice' })).toBe('Clarity · Use the active voice');
    expect(typeLabel({ severity: 'suggestion', category: 'delivery', kind: 'generic_phrasing' })).toBe('Generic phrasing · Say it plainly');
    // The family comes from the kind, whatever category the model filed it under.
    expect(typeLabel({ severity: 'suggestion', category: 'clarity', kind: 'vague_word' })).toMatch(/^Engagement · /);
  });

  it('labels a kind not listed "{Family} · Improve this": the family is always named', () => {
    expect(typeLabel({ severity: 'suggestion', category: 'clarity', kind: 'made_up' })).toBe('Clarity · Improve this');
    expect(typeLabel({ severity: 'error', category: 'grammar', kind: 'politeness' })).toBe('Correctness · Improve this');
  });
});
