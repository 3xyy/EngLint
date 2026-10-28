import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cardAction, offerAfterDismiss } from '../../src/content/card-actions';
import type { LocatedIssue } from '../../src/core/types';
import { declinedItem, dictionaryItem, dismissCountsItem, rulesItem } from '../../src/shared/settings';

type Fields = Pick<LocatedIssue, 'original' | 'severity' | 'category' | 'kind'>;
const suggestion = (kind: string, original = 'was written'): Fields => ({ original, severity: 'suggestion', category: 'clarity', kind });
const spelling = (original: string): Fields => ({ original, severity: 'error', category: 'spelling', kind: 'spelling' });

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('cardAction: what the card offers beside Dismiss', () => {
  it('"Stop suggesting {label}" for a rule-eligible kind, suggestion or style error, in Essay and Standard', () => {
    expect(cardAction(suggestion('passive_voice'), 'standard')?.label).toBe('Stop suggesting passive voice');
    expect(cardAction(suggestion('generic_phrasing'), 'essay')?.label).toBe('Stop suggesting generic phrasing');
    expect(cardAction({ original: 'red, white and blue', severity: 'error', category: 'punctuation', kind: 'oxford_comma' }, 'essay')?.label).toBe(
      'Stop suggesting the Oxford comma',
    );
  });

  it('nothing for a kind that is not rule-eligible, a kind the model invented, or in Casual (it has no rules)', () => {
    expect(cardAction({ original: 'has', severity: 'error', category: 'grammar', kind: 'subject_verb_agreement' }, 'standard')).toBeNull();
    expect(cardAction(suggestion('vague_claim'), 'standard')).toBeNull();
    expect(cardAction({ original: 'dont', severity: 'error', category: 'punctuation', kind: 'contraction' }, 'casual')).toBeNull();
  });

  it('"Add “{word}” to dictionary" for a spelling error on one word, edge punctuation and spaces aside, in any mode', () => {
    expect(cardAction(spelling('Kubernetes'), 'standard')?.label).toBe('Add “Kubernetes” to dictionary');
    expect(cardAction(spelling(' Kubernetes, '), 'essay')?.label).toBe('Add “Kubernetes” to dictionary');
    expect(cardAction(spelling('O’Brien'), 'casual')?.label).toBe('Add “O’Brien” to dictionary');
    expect(cardAction(spelling('e-mail'), 'standard')?.label).toBe('Add “e-mail” to dictionary');
  });

  it('nothing for a spelling error on two words or on punctuation alone, or a spelling-category suggestion', () => {
    expect(cardAction(spelling('alot of'), 'standard')).toBeNull();
    expect(cardAction(spelling(' , '), 'standard')).toBeNull();
    expect(cardAction({ ...spelling('Kubernetes'), severity: 'suggestion' }, 'standard')).toBeNull();
    expect(cardAction({ ...spelling('Kubernetes'), category: 'grammar' }, 'standard')).toBeNull();
  });
});

describe('cardAction(...).apply: the write, the chip text and an undo of exactly that write', () => {
  it('a rule: added once for this mode; undo removes that entry and keeps every other', async () => {
    await rulesItem.setValue([{ mode: 'essay', kind: 'passive_voice' }]);
    const done = await cardAction(suggestion('passive_voice'), 'standard')!.apply();
    expect(done.text).toBe('Stopped suggesting passive voice.');
    expect(await rulesItem.getValue()).toEqual([
      { mode: 'essay', kind: 'passive_voice' },
      { mode: 'standard', kind: 'passive_voice' },
    ]);
    await rulesItem.setValue([...(await rulesItem.getValue()), { mode: 'standard', kind: 'hedging' }]);
    await done.undo();
    expect(await rulesItem.getValue()).toEqual([
      { mode: 'essay', kind: 'passive_voice' },
      { mode: 'standard', kind: 'hedging' },
    ]);
  });

  it('a rule already there is not added twice, and undo leaves it (it was not this action’s)', async () => {
    await rulesItem.setValue([{ mode: 'standard', kind: 'passive_voice' }]);
    const done = await cardAction(suggestion('passive_voice'), 'standard')!.apply();
    expect(await rulesItem.getValue()).toEqual([{ mode: 'standard', kind: 'passive_voice' }]);
    await done.undo();
    expect(await rulesItem.getValue()).toEqual([{ mode: 'standard', kind: 'passive_voice' }]);
  });

  it('a word: stored in its dictionary form; the chip names it as written; undo removes exactly it', async () => {
    await dictionaryItem.setValue(['englint']);
    const done = await cardAction(spelling(' Kubernetes, '), 'standard')!.apply();
    expect(done.text).toBe('Added “Kubernetes” to your dictionary.');
    expect(await dictionaryItem.getValue()).toEqual(['englint', 'kubernetes']);
    await dictionaryItem.setValue([...(await dictionaryItem.getValue()), 'yuvraj']);
    await done.undo();
    expect(await dictionaryItem.getValue()).toEqual(['englint', 'yuvraj']);
  });

  it('a word already there is not added twice, and undo leaves it', async () => {
    await dictionaryItem.setValue(['kubernetes']);
    const done = await cardAction(spelling('Kubernetes'), 'standard')!.apply();
    expect(await dictionaryItem.getValue()).toEqual(['kubernetes']);
    await done.undo();
    expect(await dictionaryItem.getValue()).toEqual(['kubernetes']);
  });
});

describe('offerAfterDismiss: what a dismissal leads to', () => {
  const passive = suggestion('passive_voice');
  const dismiss = (issue: Fields, mode: 'essay' | 'standard' | 'casual' = 'essay', before = 'The letter ') => offerAfterDismiss(issue, mode, before);

  it('asks nothing for the first two dismissals of a kind in a mode, and "Stop suggesting {label} in essays?" on the third', async () => {
    expect(await dismiss(passive)).toBeNull();
    expect(await dismiss(passive)).toBeNull();
    const offer = await dismiss(passive);
    expect(offer?.question).toBe('Stop suggesting passive voice in essays?');
    expect(offer?.yes).toBe('Stop');
    expect(await dismissCountsItem.getValue()).toEqual({ 'essay:passive_voice': 3 });
  });

  it('words Standard as "in other writing"', async () => {
    await dismissCountsItem.setValue({ 'standard:passive_voice': 2 });
    expect((await dismiss(passive, 'standard'))?.question).toBe('Stop suggesting passive voice in other writing?');
  });

  it('counts each mode and kind apart', async () => {
    await dismiss(passive, 'essay');
    await dismiss(passive, 'standard');
    await dismiss(suggestion('hedging'), 'essay');
    expect(await dismissCountsItem.getValue()).toEqual({ 'essay:passive_voice': 1, 'standard:passive_voice': 1, 'essay:hedging': 1 });
  });

  it('Stop writes the rule, resets the count, and hands back the undo of exactly that rule', async () => {
    await dismissCountsItem.setValue({ 'essay:passive_voice': 2 });
    const offer = (await dismiss(passive))!;
    const done = await offer.accept();
    expect(done.text).toBe('Stopped suggesting passive voice.');
    expect(await rulesItem.getValue()).toEqual([{ mode: 'essay', kind: 'passive_voice' }]);
    expect(await dismissCountsItem.getValue()).toEqual({});
    await done.undo();
    expect(await rulesItem.getValue()).toEqual([]);
  });

  it('Stop still hands back the undo when the count reset fails: the rule is written', async () => {
    await dismissCountsItem.setValue({ 'essay:passive_voice': 2 });
    const offer = (await dismiss(passive))!;
    vi.spyOn(dismissCountsItem, 'setValue').mockRejectedValueOnce(new Error('quota'));
    const done = await offer.accept();
    expect(done.text).toBe('Stopped suggesting passive voice.');
    expect(await rulesItem.getValue()).toEqual([{ mode: 'essay', kind: 'passive_voice' }]);
    await done.undo();
    expect(await rulesItem.getValue()).toEqual([]);
  });

  it('dismissals that overlap all count: three at once make 3 and one offer', async () => {
    const offers = await Promise.all([dismiss(passive), dismiss(passive), dismiss(passive)]);
    expect(await dismissCountsItem.getValue()).toEqual({ 'essay:passive_voice': 3 });
    expect(offers.filter((o) => o !== null)).toHaveLength(1);
  });

  it('a failed count write does not stop later dismissals from counting', async () => {
    vi.spyOn(dismissCountsItem, 'setValue').mockRejectedValueOnce(new Error('quota'));
    await expect(dismiss(passive)).rejects.toThrow('quota');
    await dismiss(passive);
    expect(await dismissCountsItem.getValue()).toEqual({ 'essay:passive_voice': 1 });
  });

  it('Not now is remembered: the same mode and kind never asks again, though another mode still counts', async () => {
    await dismissCountsItem.setValue({ 'essay:passive_voice': 2 });
    await (await dismiss(passive))!.decline();
    expect(await declinedItem.getValue()).toEqual(['essay:passive_voice']);
    expect(await dismiss(passive)).toBeNull();
    expect(await dismiss(passive)).toBeNull();
    await dismissCountsItem.setValue({ 'standard:passive_voice': 2 });
    expect(await dismiss(passive, 'standard')).not.toBeNull();
  });

  it('never counts Casual, a kind that is not rule-eligible, or a kind that already has a rule', async () => {
    await rulesItem.setValue([{ mode: 'essay', kind: 'hedging' }]);
    for (let i = 0; i < 4; i++) {
      expect(await dismiss(passive, 'casual')).toBeNull();
      expect(await dismiss({ original: 'has', severity: 'error', category: 'grammar', kind: 'subject_verb_agreement' })).toBeNull();
      expect(await dismiss(suggestion('hedging'))).toBeNull();
    }
    expect(await dismissCountsItem.getValue()).toEqual({});
  });

  it('a dismissed spelling error on a capitalized word in mid-sentence offers "Add “{word}” to your dictionary?"', async () => {
    const offer = (await dismiss(spelling('Ngozi'), 'standard', 'My friend '))!;
    expect(offer.question).toBe('Add “Ngozi” to your dictionary?');
    expect(offer.yes).toBe('Add');
    const done = await offer.accept();
    expect(done.text).toBe('Added “Ngozi” to your dictionary.');
    expect(await dictionaryItem.getValue()).toEqual(['ngozi']);
    await done.undo();
    expect(await dictionaryItem.getValue()).toEqual([]);
  });

  it('the dictionary offer is not remembered when declined: it comes again', async () => {
    await (await dismiss(spelling('Ngozi'), 'essay', 'My friend '))!.decline();
    expect(await declinedItem.getValue()).toEqual([]);
    expect(await dismiss(spelling('Ngozi'), 'essay', 'My friend ')).not.toBeNull();
  });

  it('offers nothing for a capital that starts a sentence or paragraph, or for a lowercase word', async () => {
    for (const before of ['', '   ', 'It rained.\n', 'It rained. ', 'Really? ', 'Stop! ', '“', 'He left." ', '(', 'Intro\n\n']) {
      expect(await dismiss(spelling('Ngozi'), 'essay', before), JSON.stringify(before)).toBeNull();
    }
    expect(await dismiss(spelling('kubernetes'), 'essay', 'We deploy on ')).toBeNull();
    expect(await dismiss(spelling('Ngozi'), 'essay', 'He said “Hi,” to ')).not.toBeNull();
    expect(await dismiss(spelling('Ngozi'), 'essay', 'He said (see ')).not.toBeNull();
    expect(await dismiss(spelling('Ngozi'), 'essay', 'He said “')).not.toBeNull();
  });

  it('with no known place for the word (before: null) there is no dictionary offer, but a stop still counts', async () => {
    expect(await offerAfterDismiss(spelling('Ngozi'), 'essay', null)).toBeNull();
    await offerAfterDismiss(passive, 'essay', null);
    expect(await dismissCountsItem.getValue()).toEqual({ 'essay:passive_voice': 1 });
  });

  it('offers nothing for two words, or for a word already in the dictionary', async () => {
    expect(await dismiss(spelling('Ngozi Eze'), 'essay', 'My friend ')).toBeNull();
    await dictionaryItem.setValue(['ngozi']);
    expect(await dismiss(spelling('Ngozi'), 'essay', 'My friend ')).toBeNull();
  });
});
