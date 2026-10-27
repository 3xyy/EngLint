import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER, PRESETS, type CompatibleConfig, type ProviderConfig } from '../../src/core/provider';
import { addDismissal, cacheKey, cacheVia, getCached, getDismissalsFor, putCached } from '../../src/background/cache';
import { PROMPT_VERSION } from '../../src/background/prompts/live-check';
import type { RawIssue } from '../../src/core/types';

const issue = (original: string): RawIssue => ({
  original, replacement: 'x', before: '', category: 'grammar', severity: 'error', kind: 'k', reason: 'r',
});

beforeEach(async () => {
  await new Promise<void>((res, rej) => {
    const r = indexedDB.deleteDatabase('englint');
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
});

const compat = (over: Partial<CompatibleConfig> = {}): CompatibleConfig => ({
  preset: 'openai', baseURL: PRESETS.openai.baseURL, fastModel: 'f', smartModel: 's', structuredOutputs: true, prices: {}, ...over,
});

describe('cache', () => {
  it('cacheKey format: version, mode, dialect, the writer part and hash, with no family toggles', () => {
    expect(cacheKey('h1', 'essay', 'en-GB', '')).toBe(`${PROMPT_VERSION}|essay|en-GB||h1`);
    expect(cacheKey('h1', 'casual', 'en-US', 'u9')).toBe(`${PROMPT_VERSION}|casual|en-US|u9|h1`);
    expect(cacheKey.length).toBe(4);
  });
  it('cacheKey is unchanged for Claude: no provider part', () => {
    expect(cacheKey('h1', 'essay', 'en-GB', '', cacheVia(DEFAULT_PROVIDER))).toBe(`${PROMPT_VERSION}|essay|en-GB||h1`);
    expect(cacheVia({ active: 'anthropic', compatible: compat() })).toBe(''); // a saved but inactive provider changes nothing
  });
  it('the same paragraph under two providers, two fast models or two custom endpoints has three keys', () => {
    const keyFor = (c: ProviderConfig) => cacheKey('h1', 'essay', 'en-GB', '', cacheVia(c));
    const keys = [
      keyFor(DEFAULT_PROVIDER),
      keyFor({ active: 'compatible', compatible: compat() }),
      keyFor({ active: 'compatible', compatible: compat({ preset: 'groq' }) }),
      keyFor({ active: 'compatible', compatible: compat({ fastModel: 'other' }) }),
      keyFor({ active: 'compatible', compatible: compat({ preset: 'custom', baseURL: 'https://a.example/v1' }) }),
      keyFor({ active: 'compatible', compatible: compat({ preset: 'custom', baseURL: 'https://b.example/v1' }) }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('a fixed preset\'s key does not follow a tampered stored address', () => {
    const a = cacheVia({ active: 'compatible', compatible: compat() });
    expect(cacheVia({ active: 'compatible', compatible: compat({ baseURL: 'https://evil.example/v1' }) })).toBe(a);
  });
  it('cacheKey differs when the writer part differs', () => {
    expect(cacheKey('h1', 'essay', 'en-GB', 'a')).not.toBe(cacheKey('h1', 'essay', 'en-GB', 'b'));
    expect(cacheKey('h1', 'essay', 'en-GB', 'a')).not.toBe(cacheKey('h1', 'essay', 'en-GB', ''));
  });
  it('round trip', async () => {
    await putCached([['a', [issue('one')]], ['b', []]]);
    const got = await getCached(['a', 'b', 'missing']);
    expect(got.get('a')).toEqual([issue('one')]);
    expect(got.get('b')).toEqual([]);
    expect(got.has('missing')).toBe(false);
  });
  it('keeps newest 5,000', async () => {
    await putCached(Array.from({ length: 5000 }, (_, i): [string, RawIssue[]] => [`old${i}`, []]));
    await putCached(Array.from({ length: 100 }, (_, i): [string, RawIssue[]] => [`new${i}`, []]));
    const got = await getCached(['old0', 'old99', 'old100', 'new0', 'new99']);
    expect([...got.keys()].sort()).toEqual(['new0', 'new99', 'old100']);
  });
  it('dismissals by paragraph hash', async () => {
    await addDismissal('h1|teh|spelling');
    await addDismissal('h1|foo|grammar');
    await addDismissal('h1|é|spelling');
    await addDismissal('h2|bar|grammar');
    expect((await getDismissalsFor(['h1'])).sort()).toEqual(['h1|foo|grammar', 'h1|teh|spelling', 'h1|é|spelling']);
    expect(await getDismissalsFor(['h2', 'h3'])).toEqual(['h2|bar|grammar']);
    expect(await getDismissalsFor([])).toEqual([]);
  });
});
