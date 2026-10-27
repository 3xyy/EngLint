import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, MAX_FOCUS_REASON, focusFor, presetById, presetsFor } from '../../src/core/presets';

describe('presets', () => {
  it('lists the ten built-ins in order', () => {
    expect(BUILTIN_PRESETS.map((p) => p.title)).toEqual([
      'Rewrite',
      'Shorter',
      'Clearer',
      'More formal',
      'More confident',
      'Friendlier',
      'More casual',
      'Simpler',
      'Expand',
      'Sound like me',
    ]);
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual([
      'rewrite',
      'shorter',
      'clearer',
      'formal',
      'confident',
      'friendlier',
      'casual',
      'simpler',
      'expand',
      'voice',
    ]);
  });
  it('the tone presets carry their exact instructions', () => {
    expect(presetById('confident').instruction).toBe(
      "Make this sound more confident and direct: cut hedges and apologies, keep every idea and the writer's voice.",
    );
    expect(presetById('friendlier').instruction).toBe("Make this warmer and friendlier without adding new ideas, keeping the writer's voice.");
    expect(presetById('casual').instruction).toBe('Make this more relaxed and conversational, keeping every idea.');
    expect(presetById('simpler').instruction).toBe(
      'Make this simpler and easier to read: shorter sentences and plainer words, with the same meaning.',
    );
    expect(presetById('expand').instruction).toBe(
      'Expand this a little: develop the ideas already there with a bit more detail, adding no new facts or claims.',
    );
    expect(presetById('confident').title).toBe('More confident');
    expect(presetById('friendlier').title).toBe('Friendlier');
    expect(presetById('casual').title).toBe('More casual');
    expect(presetById('simpler').title).toBe('Simpler');
    expect(presetById('expand').title).toBe('Expand');
  });
  it('only Expand is limited by mode, and not offered for essays', () => {
    expect(BUILTIN_PRESETS.filter((p) => p.modes).map((p) => p.id)).toEqual(['expand']);
    expect(presetById('expand').modes).toEqual(['standard', 'casual']);
  });
  it('presetsFor leaves Expand out for essays: 9 in Essay, 10 elsewhere', () => {
    expect(presetsFor('essay')).toHaveLength(9);
    expect(presetsFor('essay').map((p) => p.id)).not.toContain('expand');
    expect(presetsFor('standard')).toHaveLength(10);
    expect(presetsFor('casual')).toHaveLength(10);
    expect(presetsFor('standard').map((p) => p.id)).toContain('expand');
  });
  it('Sound like me is offered in every mode, last', () => {
    for (const mode of ['essay', 'standard', 'casual'] as const) expect(presetsFor(mode).at(-1)!.id, mode).toBe('voice');
    expect(presetById('voice').modes).toBeUndefined();
  });
  it('Sound like me carries its exact title and instruction', () => {
    expect(presetById('voice').title).toBe('Sound like me');
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
    expect(presetById('formal').title).toBe('More formal');
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
