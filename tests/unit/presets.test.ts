import { describe, expect, it } from 'vitest';
import { BAR_ACTIONS, BUILTIN_PRESETS, MAX_FOCUS_REASON, WORD_LIMIT_ITEM, barActionsFor, focusFor, presetById, presetsFor, requestTitle, type BarAction } from '../../src/core/presets';

describe('presets', () => {
  it('lists the eight built-ins in bar order, Improve first and My voice last', () => {
    expect(BUILTIN_PRESETS.map((p) => p.title)).toEqual(['Improve', 'Shorter', 'Formal', 'Confident', 'Friendly', 'Casual', 'Expand', 'My voice']);
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual(['rewrite', 'shorter', 'formal', 'confident', 'friendlier', 'casual', 'expand', 'voice']);
  });
  it('Improve merges clearer and simpler into one instruction', () => {
    expect(presetById('rewrite').instruction).toBe('Improve this: clearer, simpler and smoother, with the same meaning and voice.');
  });
  it('the tone presets carry their exact instructions', () => {
    expect(presetById('confident').instruction).toBe(
      "Make this sound more confident and direct: cut hedges and apologies, keep every idea and the writer's voice.",
    );
    expect(presetById('friendlier').instruction).toBe("Make this warmer and friendlier without adding new ideas, keeping the writer's voice.");
    expect(presetById('casual').instruction).toBe('Make this more relaxed and conversational, keeping every idea.');
    expect(presetById('expand').instruction).toBe(
      'Expand this a little: develop the ideas already there with a bit more detail, adding no new facts or claims.',
    );
  });
  it('only Expand is limited by mode, and not offered for essays', () => {
    expect(BUILTIN_PRESETS.filter((p) => p.modes).map((p) => p.id)).toEqual(['expand']);
    expect(presetById('expand').modes).toEqual(['standard', 'casual']);
  });
  it('presetsFor leaves Expand out for essays: 7 in Essay, 8 elsewhere', () => {
    expect(presetsFor('essay')).toHaveLength(7);
    expect(presetsFor('essay').map((p) => p.id)).not.toContain('expand');
    expect(presetsFor('standard')).toHaveLength(8);
    expect(presetsFor('casual')).toHaveLength(8);
    expect(presetsFor('standard').map((p) => p.id)).toContain('expand');
  });
  it('My voice is offered in every mode, last', () => {
    for (const mode of ['essay', 'standard', 'casual'] as const) expect(presetsFor(mode).at(-1)!.id, mode).toBe('voice');
    expect(presetById('voice').modes).toBeUndefined();
  });
  it('My voice carries its exact title and instruction', () => {
    expect(presetById('voice').title).toBe('My voice');
    expect(presetById('voice').instruction).toBe(
      'Make this sound like the writer, not like a template: remove generic phrasing such as stock words, staged contrasts, inflated claims and filler, and keep the meaning and every fact, name, number and quote.',
    );
  });
  it('has unique ids', () => {
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
  });
  it('tells the model to keep the meaning', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.instruction.trim()).not.toBe('');
      expect(p.instruction.toLowerCase()).toMatch(/meaning|every idea|new ideas|new facts/);
    }
  });
  it('looks a preset up by id', () => {
    expect(presetById('formal').title).toBe('Formal');
    expect(presetById('rewrite').id).toBe('rewrite');
  });
  it('focusFor takes a listed kind\'s plain label, and an unlisted kind\'s words', () => {
    expect(focusFor({ kind: 'vague_word', reason: 'why' })).toEqual({ kind: 'vague_word', label: 'vague words', reason: 'why' });
    expect(focusFor({ kind: 'odd_new_kind', reason: 'x' })).toEqual({ kind: 'odd_new_kind', label: 'odd new kind', reason: 'x' });
  });
  it('focusFor cuts a long reason', () => {
    expect(focusFor({ kind: 'vague_word', reason: 'x'.repeat(MAX_FOCUS_REASON + 50) }).reason).toHaveLength(MAX_FOCUS_REASON);
  });
});

describe('the selection bar actions', () => {
  const labels = (actions: readonly BarAction[]) => actions.map((a) => a.label);
  const menu = (actions: readonly BarAction[], id: BarAction['id']) => {
    const action = actions.find((a) => a.id === id);
    if (action?.kind !== 'menu') throw new Error(`${id} is not a menu`);
    return action.items;
  };

  it('a phrase gets Improve, Shorten ▾, Tone ▾, My voice and More ▾', () => {
    const bar = barActionsFor('standard', false);
    expect(labels(bar)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'More']);
    expect(bar.map((a) => a.kind)).toEqual(['button', 'menu', 'menu', 'button', 'menu']);
    expect(bar[0]).toMatchObject({ kind: 'button', run: { kind: 'preset', presetId: 'rewrite' } });
    expect(bar[3]).toMatchObject({ kind: 'button', run: { kind: 'preset', presetId: 'voice' } });
  });

  it('Tone holds Formal, Confident, Friendly and Casual', () => {
    const tone = menu(barActionsFor('standard', false), 'tone');
    expect(tone.map((i) => i.label)).toEqual(['Formal', 'Confident', 'Friendly', 'Casual']);
    expect(tone.map((i) => i.run)).toEqual(['formal', 'confident', 'friendlier', 'casual'].map((presetId) => ({ kind: 'preset', presetId })));
  });

  it('Shorten holds Shorter, then "Fit a word limit…", which opens the word-limit tool, in every mode', () => {
    for (const mode of ['essay', 'standard', 'casual'] as const) {
      const shorten = menu(barActionsFor(mode, false), 'shorten');
      expect(shorten.map((i) => i.label)).toEqual(['Shorter', 'Fit a word limit…']);
      expect(shorten[0]!.run).toEqual({ kind: 'preset', presetId: 'shorter' });
      expect(shorten[1]).toBe(WORD_LIMIT_ITEM);
    }
    expect(WORD_LIMIT_ITEM.run).toEqual({ kind: 'wordLimit' });
  });

  it('a single word has no word limit to fit: Shorten holds Shorter alone', () => {
    expect(menu(barActionsFor('essay', true), 'shorten').map((i) => i.label)).toEqual(['Shorter']);
  });

  it('More holds Expand (not for essays), Synonyms and "Ask anything…"', () => {
    expect(menu(barActionsFor('standard', false), 'more').map((i) => i.label)).toEqual(['Expand', 'Synonyms', 'Ask anything…']);
    expect(menu(barActionsFor('casual', false), 'more').map((i) => i.label)).toEqual(['Expand', 'Synonyms', 'Ask anything…']);
    const essay = menu(barActionsFor('essay', false), 'more');
    expect(essay.map((i) => i.label)).toEqual(['Synonyms', 'Ask anything…']);
    expect(essay.map((i) => i.run)).toEqual([{ kind: 'synonyms' }, 'custom-prompt']);
  });

  it('a single word gets Synonyms as its own button, before More, and More drops it', () => {
    const bar = barActionsFor('standard', true);
    expect(labels(bar)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'Synonyms', 'More']);
    expect(bar[4]).toMatchObject({ kind: 'button', run: { kind: 'synonyms' } });
    expect(menu(bar, 'more').map((i) => i.label)).toEqual(['Expand', 'Ask anything…']);
  });

  it('every built-in preset is on the bar exactly once', () => {
    const runs = BAR_ACTIONS.flatMap((a) => (a.kind === 'button' ? [a.run] : a.items.map((i) => i.run)));
    const presets = runs.flatMap((r) => (r && typeof r === 'object' && r.kind === 'preset' ? [r.presetId] : []));
    expect([...presets].sort()).toEqual(BUILTIN_PRESETS.map((p) => p.id).sort());
  });

  it('the results header names the action', () => {
    expect(requestTitle({ kind: 'preset', presetId: 'rewrite' })).toBe('Improve');
    expect(requestTitle({ kind: 'preset', presetId: 'rewrite', focus: { kind: 'wordy_phrase', label: 'wordy phrases', reason: 'r' } })).toBe('Improve');
    expect(requestTitle({ kind: 'preset', presetId: 'formal' })).toBe('Tone · Formal');
    expect(requestTitle({ kind: 'preset', presetId: 'friendlier' })).toBe('Tone · Friendly');
    expect(requestTitle({ kind: 'preset', presetId: 'shorter' })).toBe('Shorten');
    expect(requestTitle({ kind: 'preset', presetId: 'voice' })).toBe('My voice');
    expect(requestTitle({ kind: 'preset', presetId: 'expand' })).toBe('Expand');
    expect(requestTitle({ kind: 'synonyms' })).toBe('Synonyms');
    expect(requestTitle({ kind: 'wordLimit' })).toBe('Fit a word limit');
    expect(requestTitle({ kind: 'custom', instruction: '  make it vivid ' })).toBe('“make it vivid”');
  });
});
