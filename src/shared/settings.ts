import { storage } from 'wxt/utils/storage';
import type { CitationStyle } from '../core/citations';
import { ESSAY_SITES_DEFAULT, migrateFamilies } from '../core/modes';
import type { Dialect, FamilyToggles, Mode } from '../core/types';
import { DEFAULT_PROVIDER, type ProviderConfig } from '../core/provider';
import { dictionaryForm } from '../core/typography';

// The API key is not here: it lives in the background's own IndexedDB (src/background/key-store.ts).
export const capUsdItem = storage.defineItem<number>('local:capUsd', { fallback: 25 });
export const dialectItem = storage.defineItem<Dialect>('local:dialect', { fallback: 'en-US' });
export const siteModesItem = storage.defineItem<Record<string, Mode>>('local:siteModes', { fallback: {} });
export const disabledSitesItem = storage.defineItem<string[]>('local:disabledSites', { fallback: [] });
export const essaySitesItem = storage.defineItem<string[]>('local:essaySites', { fallback: ESSAY_SITES_DEFAULT });
export const clarityByModeItem = storage.defineItem<Record<Mode, boolean>>('local:clarityByMode', {
  fallback: { essay: true, standard: true, casual: false },
});
/** "Show the EngLint badge": the badge in the focused field's corner (counts, status, opens the panel). */
export const showBadgeItem = storage.defineItem<boolean>('local:showBadge', { fallback: true });
/** "Instant local checks": the built-in checker (Harper) underlines as the writer types, with or without the API. */
export const localChecksItem = storage.defineItem<boolean>('local:localChecks', { fallback: true });
/** The Citation finder's citation style. */
export const citationStyleItem = storage.defineItem<CitationStyle>('local:citationStyle', { fallback: 'mla' });
/** Which provider answers, and the compatible one's address and models. The keys are not here. */
export const providerItem = storage.defineItem<ProviderConfig>('local:provider', { fallback: DEFAULT_PROVIDER });
/** USD spent per month, keyed by monthKey(). */
export const spendItem = storage.defineItem<Record<string, number>>('local:spend', { fallback: {} });

/** Per-mode suggestion-family toggles. null until first read, which migrates from clarityByMode. */
export const suggestionFamiliesByModeItem = storage.defineItem<Record<Mode, FamilyToggles> | null>(
  'local:suggestionFamiliesByMode',
  { fallback: null },
);

/** The toggles in effect, without saving anything: the stored value, or what the first read would migrate to. */
export async function peekSuggestionFamilies(): Promise<Record<Mode, FamilyToggles>> {
  const stored = await suggestionFamiliesByModeItem.getValue();
  if (stored) return stored;
  // Only a clarityByMode the writer saved carries over: read without the item's fallback, which is no choice.
  const legacy = await storage.getItem<Record<Mode, boolean>>(clarityByModeItem.key);
  return migrateFamilies(legacy);
}

export async function readSuggestionFamilies(): Promise<Record<Mode, FamilyToggles>> {
  const stored = await suggestionFamiliesByModeItem.getValue();
  if (stored) return stored;
  const migrated = await peekSuggestionFamilies();
  await suggestionFamiliesByModeItem.setValue(migrated);
  return migrated;
}

/** "Stop suggesting {kind}" rules: hide a kind in one mode only. */
export const rulesItem = storage.defineItem<{ mode: Mode; kind: string }[]>('local:rules', { fallback: [] });

/** Words the writer added, stored in their dictionaryForm (use addDictionaryWord). */
export const dictionaryItem = storage.defineItem<string[]>('local:dictionary', { fallback: [] });

export async function addDictionaryWord(word: string): Promise<void> {
  const w = dictionaryForm(word);
  const list = await dictionaryItem.getValue();
  if (w && !list.includes(w)) await dictionaryItem.setValue([...list, w]);
}

/** Dismissals of each rule-eligible kind, keyed `${mode}:${kind}`; a third one in a mode offers to stop the kind. */
export const dismissCountsItem = storage.defineItem<Record<string, number>>('local:dismissCounts', { fallback: {} });

/** The `${mode}:${kind}` pairs the writer answered "Not now" to: they are never asked about again. */
export const declinedItem = storage.defineItem<string[]>('local:declinedOffers', { fallback: [] });

/** The writer's style profile (a short description of how they write), or null. Local only; the pasted pieces are never stored. */
export const styleProfileItem = storage.defineItem<{ text: string; updatedAt: number } | null>('local:styleProfile', { fallback: null });
