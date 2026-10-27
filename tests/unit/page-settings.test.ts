import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { loadPageSettings } from '../../src/content/field-host';
import { defaultFamilies, migrateFamilies } from '../../src/core/modes';
import {
  dictionaryItem,
  disabledSitesItem,
  localChecksItem,
  rulesItem,
  showBadgeItem,
  suggestionFamiliesByModeItem,
} from '../../src/shared/settings';

const ctx = () => ({ onInvalidated: vi.fn() }) as unknown as ContentScriptContext;

beforeEach(() => fakeBrowser.reset());

describe('loadPageSettings: the site switch', () => {
  it('a frame is off when the top-level host is off, and follows it being switched', async () => {
    await disabledSitesItem.setValue(['example.com']);
    const settings = await loadPageSettings(ctx(), 'widget.vendor.com', 'example.com');
    const seen: boolean[] = [];
    expect(settings.watchEnabled((on) => seen.push(on))).toBe(false);

    await disabledSitesItem.setValue([]);
    await vi.waitFor(() => expect(seen).toEqual([true]));
    await disabledSitesItem.setValue(['example.com']);
    await vi.waitFor(() => expect(seen).toEqual([true, false]));
    await disabledSitesItem.setValue(['widget.vendor.com']); // its own host off: still off
    await vi.waitFor(() => expect(seen).toEqual([true, false, false]));
  });

  it('without a top-level host only its own host counts', async () => {
    await disabledSitesItem.setValue(['example.com']);
    expect((await loadPageSettings(ctx(), 'widget.vendor.com')).watchEnabled(() => {})).toBe(true);
    expect((await loadPageSettings(ctx(), 'widget.vendor.com', null)).watchEnabled(() => {})).toBe(true);
    expect((await loadPageSettings(ctx(), 'example.com')).watchEnabled(() => {})).toBe(false);
  });
});

describe('loadPageSettings: the suggestion policy', () => {
  const ALL_ON = { clarity: true, engagement: true, delivery: true, generic: true };

  it('fresh storage: each mode takes its default families, with no rules and an empty dictionary', async () => {
    const settings = await loadPageSettings(ctx(), 'example.com');
    for (const mode of ['essay', 'standard', 'casual'] as const) {
      expect(settings.policy(mode)).toEqual({ mode, families: defaultFamilies(mode), rules: new Set(), dictionary: new Set() });
    }
  });

  it('reads the stored families, only that mode’s rules, and the dictionary', async () => {
    await suggestionFamiliesByModeItem.setValue({ ...migrateFamilies(null), standard: ALL_ON });
    await rulesItem.setValue([
      { mode: 'standard', kind: 'passive_voice' },
      { mode: 'essay', kind: 'hedging' },
      { mode: 'standard', kind: 'oxford_comma' },
    ]);
    await dictionaryItem.setValue(['kubernetes']);
    const settings = await loadPageSettings(ctx(), 'example.com');
    expect(settings.policy('standard')).toEqual({
      mode: 'standard',
      families: ALL_ON,
      rules: new Set(['passive_voice', 'oxford_comma']),
      dictionary: new Set(['kubernetes']),
    });
    expect(settings.policy('essay').rules).toEqual(new Set(['hedging']));
    expect(settings.policy('essay').families).toEqual(defaultFamilies('essay'));
  });

  it('a change to the families, the rules or the dictionary updates the policy and tells every watcher', async () => {
    const settings = await loadPageSettings(ctx(), 'example.com');
    const a = vi.fn();
    const b = vi.fn();
    settings.watchPolicy(a);
    settings.watchPolicy(b);

    await suggestionFamiliesByModeItem.setValue({ ...migrateFamilies(null), standard: ALL_ON });
    await vi.waitFor(() => expect(settings.policy('standard').families).toEqual(ALL_ON));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));

    await rulesItem.setValue([{ mode: 'standard', kind: 'wordy_phrase' }]);
    await vi.waitFor(() => expect(settings.policy('standard').rules).toEqual(new Set(['wordy_phrase'])));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(2));

    await dictionaryItem.setValue(['kubernetes']);
    await vi.waitFor(() => expect(settings.policy('standard').dictionary).toEqual(new Set(['kubernetes'])));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(3));
    expect(b).toHaveBeenCalledTimes(3);
  });

  it('families removed from storage: the policy goes back to the defaults', async () => {
    await suggestionFamiliesByModeItem.setValue({ ...migrateFamilies(null), standard: ALL_ON });
    const settings = await loadPageSettings(ctx(), 'example.com');
    const seen = vi.fn();
    settings.watchPolicy(seen);
    await suggestionFamiliesByModeItem.removeValue();
    await vi.waitFor(() => expect(settings.policy('standard').families).toEqual(defaultFamilies('standard')));
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
  });

  it('stops watching when the context is invalidated', async () => {
    let invalidate = () => {};
    const c = { onInvalidated: (cb: () => void) => (invalidate = cb) } as unknown as ContentScriptContext;
    const settings = await loadPageSettings(c, 'example.com');
    const seen = vi.fn();
    settings.watchPolicy(seen);
    invalidate();
    await rulesItem.setValue([{ mode: 'standard', kind: 'wordy_phrase' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).not.toHaveBeenCalled();
    expect(settings.policy('standard').rules).toEqual(new Set());
  });
});

describe('loadPageSettings: the badge switch', () => {
  it('is on in fresh storage, and showBadge() and watchBadge follow each change', async () => {
    expect(showBadgeItem.key).toBe('local:showBadge');
    const settings = await loadPageSettings(ctx(), 'example.com');
    expect(settings.showBadge()).toBe(true);
    const seen = vi.fn();
    settings.watchBadge(seen);
    await showBadgeItem.setValue(false);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    expect(settings.showBadge()).toBe(false);
    await showBadgeItem.setValue(true);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
    expect(settings.showBadge()).toBe(true);
  });

  it('reads a saved off at load', async () => {
    await showBadgeItem.setValue(false);
    expect((await loadPageSettings(ctx(), 'example.com')).showBadge()).toBe(false);
  });
});

describe('loadPageSettings: "Instant local checks"', () => {
  it('is on in fresh storage; localChecks() follows each change and tells every policy watcher', async () => {
    expect(localChecksItem.key).toBe('local:localChecks');
    const settings = await loadPageSettings(ctx(), 'example.com');
    expect(settings.localChecks()).toBe(true);
    const seen = vi.fn();
    settings.watchPolicy(seen);
    await localChecksItem.setValue(false);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    expect(settings.localChecks()).toBe(false);
    await localChecksItem.setValue(true);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
    expect(settings.localChecks()).toBe(true);
  });

  it('reads a saved off at load', async () => {
    await localChecksItem.setValue(false);
    expect((await loadPageSettings(ctx(), 'example.com')).localChecks()).toBe(false);
  });
});
