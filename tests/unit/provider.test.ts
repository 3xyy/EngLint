import { describe, expect, it } from 'vitest';
import {
  type CompatibleConfig,
  DEFAULT_PROVIDER,
  PRESETS,
  type ProviderConfig,
  activeSlot,
  endpointOf,
  keyNeeded,
  isUsable,
  normalizeProvider,
  permissionPattern,
  providerInfo,
  providerName,
  spendTracked,
  supportsWebSearch,
  validateBaseURL,
} from '../../src/core/provider';

const compat = (over: Partial<CompatibleConfig> = {}): ProviderConfig => ({
  active: 'compatible',
  compatible: { preset: 'gemini', baseURL: PRESETS.gemini.baseURL, fastModel: 'f', smartModel: 's', structuredOutputs: true, prices: {}, ...over },
});

describe('validateBaseURL', () => {
  it('accepts https, and gives its origin', () => {
    expect(validateBaseURL('https://api.openai.com/v1')).toEqual({ ok: true, origin: 'https://api.openai.com' });
  });
  it('accepts http only for this computer', () => {
    expect(validateBaseURL('http://localhost:11434/v1')).toEqual({ ok: true, origin: 'http://localhost:11434' });
    expect(validateBaseURL('http://127.0.0.1:1234/v1')).toEqual({ ok: true, origin: 'http://127.0.0.1:1234' });
  });
  it('rejects http elsewhere and other schemes', () => {
    expect(validateBaseURL('http://example.com/v1')).toEqual({ ok: false, reason: 'Use an https address (http is allowed only for this computer).' });
    expect(validateBaseURL('ftp://x').ok).toBe(false);
    expect(validateBaseURL('not a url').ok).toBe(false);
    expect(validateBaseURL('http://localhost.evil.com/v1').ok).toBe(false);
    expect(validateBaseURL('http://127.0.0.1.nip.io/v1').ok).toBe(false);
  });
  it('refuses http on the IPv6 loopback address: Chrome could never be asked to allow it', () => {
    expect(validateBaseURL('http://[::1]:1/v1')).toEqual({ ok: false, reason: 'Use an https address (http is allowed only for this computer).' });
    expect(validateBaseURL('http://[::1]/v1').ok).toBe(false);
  });
  it('refuses an address with a query or a fragment, which calls would be appended after', () => {
    const reason = 'Remove the ? or # part of the address.';
    for (const url of ['https://x.example/v1?a=1', 'https://x.example/v1#top', 'https://x.example/v1?', 'https://x.example/v1#', 'http://localhost:11434/v1?key=1']) {
      expect(validateBaseURL(url), url).toEqual({ ok: false, reason });
    }
  });
  it('refuses a user name or password in the address', () => {
    const reason = 'Remove the user name and password from the address.';
    for (const url of ['https://user@host.com/v1', 'https://user:p@host.com', 'http://user@localhost/v1', 'https://:p@host.com/v1']) {
      expect(validateBaseURL(url), url).toEqual({ ok: false, reason });
    }
  });
});

describe('providerName', () => {
  it('is Claude, the preset label, or the custom host', () => {
    expect(providerName(DEFAULT_PROVIDER)).toBe('Claude');
    expect(providerName(compat())).toBe('Google Gemini');
    expect(providerName(compat({ preset: 'openai' }))).toBe('OpenAI');
    expect(providerName(compat({ preset: 'custom', baseURL: 'https://llm.example.org/v1' }))).toBe('llm.example.org');
  });
  it('leaves out the bracketed part of a local server\'s label (the select keeps it)', () => {
    expect(providerName(compat({ preset: 'ollama', baseURL: PRESETS.ollama.baseURL }))).toBe('Ollama');
    expect(providerName(compat({ preset: 'lmstudio', baseURL: PRESETS.lmstudio.baseURL }))).toBe('LM Studio');
    expect(PRESETS.ollama.label).toBe('Ollama (on this computer)');
  });
});

describe('providerInfo', () => {
  it('is the name status copy uses, and whether the provider takes no key', () => {
    expect(providerInfo(DEFAULT_PROVIDER)).toEqual({ name: 'Claude', keyless: false });
    expect(providerInfo(compat({ preset: 'openai' }))).toEqual({ name: 'OpenAI', keyless: false });
    expect(providerInfo(compat({ preset: 'ollama', baseURL: PRESETS.ollama.baseURL }))).toEqual({ name: 'Ollama', keyless: true });
    expect(providerInfo(compat({ preset: 'lmstudio', baseURL: PRESETS.lmstudio.baseURL }))).toEqual({ name: 'LM Studio', keyless: true });
  });
});

describe('supportsWebSearch', () => {
  it('is true only for Anthropic', () => {
    expect(supportsWebSearch(DEFAULT_PROVIDER)).toBe(true);
    expect(supportsWebSearch(compat())).toBe(false);
  });
});

describe('activeSlot', () => {
  it('names the key slot of the active provider', () => {
    expect(activeSlot(DEFAULT_PROVIDER)).toBe('anthropic');
    expect(activeSlot(compat())).toBe('compatible:gemini');
    expect(activeSlot({ active: 'anthropic', compatible: compat().compatible })).toBe('anthropic');
  });
  it('names no slot for settings it doesn\'t know: an unexpected value reaches no key', () => {
    const tampered = (active: unknown) => ({ active, compatible: compat({ preset: 'custom', baseURL: 'https://evil.example/v1' }).compatible }) as unknown as ProviderConfig;
    expect(activeSlot(tampered('bogus'))).toBeNull();
    expect(activeSlot(tampered(undefined))).toBeNull();
    expect(activeSlot({ active: 'compatible', compatible: null })).toBeNull();
    expect(keyNeeded(tampered('bogus'))).toBe(true);
    expect(keyNeeded({ active: 'bogus', compatible: compat({ preset: 'ollama', baseURL: PRESETS.ollama.baseURL }).compatible } as unknown as ProviderConfig)).toBe(true);
    expect(isUsable(tampered('bogus'))).toBe(false);
  });
});

describe('normalizeProvider', () => {
  const GOOD = compat({ preset: 'custom', baseURL: 'https://llm.example.org/v1', prices: { f: { input: 0.5, output: 2 }, s: { input: 0, output: 0 } } });

  it('keeps settings that are whole, field for field', () => {
    expect(normalizeProvider(DEFAULT_PROVIDER)).toEqual(DEFAULT_PROVIDER);
    expect(normalizeProvider(GOOD)).toEqual(GOOD);
    expect(normalizeProvider({ active: 'anthropic', compatible: GOOD.compatible })).toEqual({ active: 'anthropic', compatible: GOOD.compatible });
  });

  it('drops fields it doesn\'t know', () => {
    expect(normalizeProvider({ ...GOOD, extra: 1, compatible: { ...GOOD.compatible, apiKey: 'x' } })).toEqual(GOOD);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'compatible'],
    ['an array', []],
    ['an unknown active', { active: 'bogus', compatible: GOOD.compatible }],
    ['a missing active', { compatible: GOOD.compatible }],
    ['an active of another type', { active: 1, compatible: GOOD.compatible }],
  ])('is the default (Claude, no compatible settings) for %s', (_, raw) => {
    expect(normalizeProvider(raw)).toEqual(DEFAULT_PROVIDER);
  });

  const bad = (over: Record<string, unknown>) => ({ active: 'compatible', compatible: { ...GOOD.compatible, ...over } });
  it.each([
    ['a preset that is an object built-in', bad({ preset: '__proto__' })],
    ['a preset named toString', bad({ preset: 'toString' })],
    ['an unknown preset', bad({ preset: 'other' })],
    ['a base URL that isn\'t text', bad({ baseURL: 42 })],
    ['a fast model that isn\'t text', bad({ fastModel: null })],
    ['a missing smart model', bad({ smartModel: undefined })],
    ['a JSON schema flag that isn\'t a boolean', bad({ structuredOutputs: 'yes' })],
    ['prices that aren\'t an object', bad({ prices: 'cheap' })],
    ['prices in a list', bad({ prices: [] })],
    ['a negative price', bad({ prices: { f: { input: -1, output: 1 } } })],
    ['a price that isn\'t finite', bad({ prices: { f: { input: 1, output: Infinity } } })],
    ['a price that isn\'t a number', bad({ prices: { f: { input: '1', output: 1 } } })],
    ['a price entry that isn\'t an object', bad({ prices: { f: 3 } })],
    ['compatible settings that aren\'t an object', { active: 'compatible', compatible: 'groq' }],
  ])('drops compatible settings with %s, and falls back to Claude', (_, raw) => {
    expect(normalizeProvider(raw)).toEqual(DEFAULT_PROVIDER);
  });

  it('keeps Claude active with bad compatible settings dropped', () => {
    expect(normalizeProvider({ active: 'anthropic', compatible: { ...GOOD.compatible, preset: '__proto__' } })).toEqual(DEFAULT_PROVIDER);
  });
});

describe('isUsable', () => {
  it('needs an address and both models for a compatible provider', () => {
    expect(isUsable(DEFAULT_PROVIDER)).toBe(true);
    expect(isUsable(compat())).toBe(true);
    expect(isUsable(compat({ fastModel: '' }))).toBe(false);
    expect(isUsable(compat({ smartModel: ' ' }))).toBe(false);
    // A fixed preset's address is its own (endpointOf), whatever is stored; a custom endpoint needs the one typed.
    expect(isUsable(compat({ baseURL: '' }))).toBe(true);
    expect(isUsable(compat({ preset: 'custom', baseURL: '' }))).toBe(false);
    expect(isUsable(compat({ preset: 'custom', baseURL: '  ' }))).toBe(false);
    expect(isUsable(compat({ preset: 'custom', baseURL: 'https://llm.example.org/v1' }))).toBe(true);
    expect(isUsable({ active: 'compatible', compatible: null })).toBe(false);
  });
});

describe('endpointOf', () => {
  it('is a fixed preset\'s own address, whatever is stored', () => {
    expect(endpointOf(compat().compatible!)).toBe(PRESETS.gemini.baseURL);
    expect(endpointOf(compat({ baseURL: 'https://evil.example/v1' }).compatible!)).toBe(PRESETS.gemini.baseURL);
  });
  it('is the stored address, trimmed, for a custom endpoint', () => {
    expect(endpointOf(compat({ preset: 'custom', baseURL: ' https://api.example.com/v1 ' }).compatible!)).toBe('https://api.example.com/v1');
  });
});

describe('keyNeeded', () => {
  it('holds for Claude, a keyed preset and a custom endpoint, not for a local server', () => {
    expect(keyNeeded(DEFAULT_PROVIDER)).toBe(true);
    expect(keyNeeded(compat())).toBe(true);
    expect(keyNeeded(compat({ preset: 'custom' }))).toBe(true);
    expect(keyNeeded(compat({ preset: 'ollama' }))).toBe(false);
    expect(keyNeeded(compat({ preset: 'lmstudio' }))).toBe(false);
  });
});

describe('permissionPattern', () => {
  it('is the endpoint\'s origin with any path, port included', () => {
    expect(permissionPattern(compat({ preset: 'openai' }).compatible!)).toBe('https://api.openai.com/*');
    expect(permissionPattern(compat({ preset: 'ollama' }).compatible!)).toBe('http://localhost:11434/*');
    expect(permissionPattern(compat({ preset: 'custom', baseURL: 'http://127.0.0.1:4011/v1' }).compatible!)).toBe('http://127.0.0.1:4011/*');
  });
  it('follows a fixed preset\'s own address, never a stored one', () => {
    expect(permissionPattern(compat({ baseURL: 'https://evil.example/v1' }).compatible!)).toBe('https://generativelanguage.googleapis.com/*');
  });
  it('is null for an address that may not be called', () => {
    expect(permissionPattern(compat({ preset: 'custom', baseURL: 'http://example.com/v1' }).compatible!)).toBeNull();
    expect(permissionPattern(compat({ preset: 'custom', baseURL: '' }).compatible!)).toBeNull();
  });
});

describe('spendTracked', () => {
  const priced = { f: { input: 0.1, output: 0.4 }, s: { input: 1, output: 4 } };
  it('holds for Claude, and for a compatible provider whose two models both have prices', () => {
    expect(spendTracked(DEFAULT_PROVIDER)).toBe(true);
    expect(spendTracked(compat({ prices: priced }))).toBe(true);
    expect(spendTracked(compat({ prices: { f: { input: 0, output: 0 }, s: { input: 0, output: 0 } } }))).toBe(true);
  });
  it('fails when the fast or the smart model has none', () => {
    expect(spendTracked(compat())).toBe(false);
    expect(spendTracked(compat({ prices: { s: priced.s } }))).toBe(false);
    expect(spendTracked(compat({ prices: { f: priced.f } }))).toBe(false);
  });
});
