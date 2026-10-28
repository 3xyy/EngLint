import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultFamilies, ESSAY_FAMILY_DEFAULTS, STANDARD_FAMILY_DEFAULTS } from '../../src/core/modes';
import { dictionaryForm } from '../../src/core/typography';
import {
  clarityByModeItem,
  addDictionaryWord,
  dictionaryItem,
  readSuggestionFamilies,
  rulesItem,
  suggestionFamiliesByModeItem,
} from '../../src/shared/settings';

beforeEach(() => fakeBrowser.reset());

describe('readSuggestionFamilies', () => {
  it('migrates from clarityByMode on first read and writes it once', async () => {
    await clarityByModeItem.setValue({ essay: false, standard: true, casual: false });
    expect(await suggestionFamiliesByModeItem.getValue()).toBeNull();
    const first = await readSuggestionFamilies();
    expect(first.essay).toEqual({ ...ESSAY_FAMILY_DEFAULTS, clarity: false });
    expect(first.standard.clarity).toBe(true);
    expect(await suggestionFamiliesByModeItem.getValue()).toEqual(first);
  });
  it('later reads return the stored value even after clarityByMode changes', async () => {
    const first = await readSuggestionFamilies();
    await clarityByModeItem.setValue({ essay: false, standard: false, casual: false });
    expect(await readSuggestionFamilies()).toEqual(first);
  });
  it('fresh storage: every mode takes its defaults (clarityByMode is never saved, so its fallback is no choice)', async () => {
    expect(await fakeBrowser.storage.local.get('clarityByMode')).toEqual({});
    expect(await readSuggestionFamilies()).toEqual({
      essay: defaultFamilies('essay'),
      standard: defaultFamilies('standard'),
      casual: defaultFamilies('casual'),
    });
  });
  it('fresh storage: a clarity default of off stays off (the legacy fallback, on, is not read as a choice)', async () => {
    const saved = { ...STANDARD_FAMILY_DEFAULTS };
    STANDARD_FAMILY_DEFAULTS.clarity = false; // unlike the legacy fallback, so reading the fallback would show
    try {
      expect((await readSuggestionFamilies()).standard.clarity).toBe(false);
    } finally {
      Object.assign(STANDARD_FAMILY_DEFAULTS, saved);
    }
  });
  it('a saved clarityByMode with everything off keeps clarity off in essay and standard', async () => {
    await fakeBrowser.storage.local.set({ clarityByMode: { essay: false, standard: false, casual: false } });
    const families = await readSuggestionFamilies();
    expect(families.essay).toEqual({ ...defaultFamilies('essay'), clarity: false });
    expect(families.standard).toEqual({ ...defaultFamilies('standard'), clarity: false });
    expect(families.casual).toEqual(defaultFamilies('casual'));
  });
  it('returns a stored value as is', async () => {
    const stored = {
      essay: { clarity: true, engagement: false, delivery: false, generic: false },
      standard: { clarity: false, engagement: true, delivery: true, generic: true },
      casual: { clarity: false, engagement: false, delivery: false, generic: false },
    };
    await suggestionFamiliesByModeItem.setValue(stored);
    expect(await readSuggestionFamilies()).toEqual(stored);
  });
});

describe('the stored families from before Engagement was on in Standard', () => {
  const OFF = { clarity: false, engagement: false, delivery: false, generic: false };
  const saved = (essay: boolean, standard: boolean) => ({
    essay: { clarity: true, engagement: essay, delivery: true, generic: false },
    standard: { clarity: true, engagement: standard, delivery: false, generic: false },
    casual: OFF,
  });

  it('an Engagement nobody touched (on in Essay, off in Standard) turns on in Standard, once', async () => {
    await fakeBrowser.storage.local.set({ suggestionFamiliesByMode: saved(true, false) });
    await suggestionFamiliesByModeItem.migrate();
    expect(await readSuggestionFamilies()).toEqual(saved(true, true));
    expect(await fakeBrowser.storage.local.get('suggestionFamiliesByMode')).toEqual({ suggestionFamiliesByMode: saved(true, true) });
    // Migrated: a later run leaves whatever is stored alone.
    await fakeBrowser.storage.local.set({ suggestionFamiliesByMode: saved(true, false) });
    await suggestionFamiliesByModeItem.migrate();
    expect(await readSuggestionFamilies()).toEqual(saved(true, false));
  });
  it('an Engagement the writer turned off stays off', async () => {
    await fakeBrowser.storage.local.set({ suggestionFamiliesByMode: saved(false, false) });
    await suggestionFamiliesByModeItem.migrate();
    expect(await readSuggestionFamilies()).toEqual(saved(false, false));
  });
  it('fresh storage: Engagement is on in Standard', async () => {
    expect((await readSuggestionFamilies()).standard.engagement).toBe(true);
  });
});

describe('rules and dictionary items', () => {
  it('default to empty', async () => {
    expect(await rulesItem.getValue()).toEqual([]);
    expect(await dictionaryItem.getValue()).toEqual([]);
  });
  it('addDictionaryWord lowercases and dedupes', async () => {
    await addDictionaryWord('Yuvraj');
    await addDictionaryWord('EngLint');
    await addDictionaryWord('yuvraj');
    expect(await dictionaryItem.getValue()).toEqual(['yuvraj', 'englint']);
  });
  it('addDictionaryWord stores the dictionary form: folded, trimmed of spaces and edge punctuation', async () => {
    await addDictionaryWord(' O’Brien, ');
    await addDictionaryWord("O'Brien");
    await addDictionaryWord(' , ');
    expect(await dictionaryItem.getValue()).toEqual([dictionaryForm('O’Brien')]);
    expect(await dictionaryItem.getValue()).toEqual(["o'brien"]);
  });
});
