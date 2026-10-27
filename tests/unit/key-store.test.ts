import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  KEY_DB,
  clearStoredKey,
  createKeyStore,
  bindLegacyCustomKey,
  getBoundOrigin,
  getStoredKey,
  keyForProvider,
  keyStatusOf,
  isExtensionPage,
  migrateLegacyKey,
  setStoredKey,
} from '../../src/background/key-store';
import { DEFAULT_PROVIDER, PRESETS, type ProviderConfig } from '../../src/core/provider';
import { keyChangedItem } from '../../src/shared/key-changed';

const ORIGIN = 'chrome-extension://pfkhcgfebppldojflbbnoffdphlcnhjk';
const OPTIONS = `${ORIGIN}/options.html`;
const KEY = 'sk-ant-' + 'api03-SECRET-abcdWXYZ';
/** No provider settings saved: the default, Claude. */
const NONE_SAVED = async (): Promise<ProviderConfig> => DEFAULT_PROVIDER;
const custom = (baseURL: string): ProviderConfig => ({
  active: 'compatible',
  compatible: { preset: 'custom', baseURL, fastModel: 'f', smartModel: 's', structuredOutputs: false, prices: {} },
});

/** Every storage.local value, and every change event of any area, as one string to search for the key. */
function watchStorage() {
  const events: unknown[] = [];
  fakeBrowser.storage.onChanged.addListener((changes, area) => events.push({ area, changes }));
  return {
    events,
    async everything(): Promise<string> {
      return JSON.stringify({ local: await fakeBrowser.storage.local.get(null), events });
    },
  };
}

beforeEach(async () => {
  fakeBrowser.reset();
  await new Promise<void>((res, rej) => {
    const r = indexedDB.deleteDatabase(KEY_DB);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
});

describe('key store (the background worker’s own IndexedDB)', () => {
  it('stores, reads and clears the key', async () => {
    expect(await getStoredKey('anthropic')).toBeNull();
    await setStoredKey('anthropic', KEY);
    expect(await getStoredKey('anthropic')).toBe(KEY);
    await clearStoredKey('anthropic');
    expect(await getStoredKey('anthropic')).toBeNull();
  });

  it('saving and clearing never put the key in storage.local or in any storage change event', async () => {
    const storage = watchStorage();
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('anthropic', KEY, OPTIONS);
    expect(await keys.get('anthropic')).toBe(KEY);
    await keys.clear('anthropic', OPTIONS);
    expect(await storage.everything()).not.toContain('SECRET');
  });

  it('each change bumps the session stamp pages watch (a time, never the key)', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.ready;
    expect(await keyChangedItem.getValue()).toBe(0);
    await keys.set('anthropic', KEY, OPTIONS);
    const afterSet = await keyChangedItem.getValue();
    expect(afterSet).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 2));
    await keys.clear('anthropic', OPTIONS);
    expect(await keyChangedItem.getValue()).toBeGreaterThan(afterSet);
  });

  it('only extension pages may set or clear the key; content scripts and pages are refused', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('anthropic', KEY, OPTIONS);
    for (const url of ['https://example.com/', 'http://127.0.0.1:5173/x', undefined, 'chrome-extension://other-extension/options.html']) {
      await expect(keys.set('anthropic', 'sk-evil-key-123456', url), String(url)).rejects.toThrow();
      await expect(keys.clear('anthropic', url), String(url)).rejects.toThrow();
    }
    expect(await keys.get('anthropic')).toBe(KEY);
  });

  it('refuses an empty or non-string key and trims the one it stores', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await expect(keys.set('anthropic', '   ', OPTIONS)).rejects.toThrow();
    await expect(keys.set('anthropic', 42 as unknown as string, OPTIONS)).rejects.toThrow();
    expect(await keys.get('anthropic')).toBeNull();
    await keys.set('anthropic', `  ${KEY}\n`, OPTIONS);
    expect(await keys.get('anthropic')).toBe(KEY);
  });

  it('status gives only the hint, never the key', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    expect(await keys.status('anthropic')).toEqual({ saved: false, last4: null });
    await keys.set('anthropic', KEY, OPTIONS);
    expect(await keys.status('anthropic')).toEqual({ saved: true, last4: 'WXYZ' });
  });

  it('isExtensionPage: this extension’s own pages only', () => {
    expect(isExtensionPage(OPTIONS, ORIGIN)).toBe(true);
    expect(isExtensionPage(`${ORIGIN}/sidepanel.html?tabId=3`, ORIGIN)).toBe(true);
    expect(isExtensionPage(`${ORIGIN}/`, `${ORIGIN}/`)).toBe(true); // runtime.getURL('/') ends with a slash
    expect(isExtensionPage('https://example.com/', ORIGIN)).toBe(false);
    expect(isExtensionPage(`${ORIGIN}.evil.com/options.html`, ORIGIN)).toBe(false);
    expect(isExtensionPage('https://pfkhcgfebppldojflbbnoffdphlcnhjk/options.html', ORIGIN)).toBe(false); // same host, a web scheme
    expect(isExtensionPage(OPTIONS, 'not a url')).toBe(false);
    expect(isExtensionPage(undefined, ORIGIN)).toBe(false);
    expect(isExtensionPage('not a url', ORIGIN)).toBe(false);
  });
});

describe('a key per provider', () => {
  it('keys in two slots are independent, and clearing one leaves the other', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('anthropic', KEY, OPTIONS);
    await keys.set('compatible:gemini', 'gem-key-123456789', OPTIONS);
    await keys.set('compatible:openai', 'oai-key-123456789', OPTIONS);
    expect(await keys.get('anthropic')).toBe(KEY);
    expect(await keys.get('compatible:gemini')).toBe('gem-key-123456789');
    await keys.clear('compatible:gemini', OPTIONS);
    expect(await keys.get('compatible:gemini')).toBeNull();
    expect(await keys.get('anthropic')).toBe(KEY);
    expect(await keys.get('compatible:openai')).toBe('oai-key-123456789');
  });

  it('a store holding only the old single key gives it back for anthropic, and for no other slot', async () => {
    await fakeBrowser.storage.local.set({ apiKey: KEY });
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    expect(await keys.get('anthropic')).toBe(KEY);
    expect(await keys.get('compatible:openai')).toBeNull();
    // the key an earlier build saved straight into IndexedDB is the anthropic slot too
    const db = await openDB(KEY_DB, 1);
    expect(await db.get('key', 'apiKey')).toBe(KEY);
    db.close();
  });

  it('keyStatus with no slot answers for the active provider; with one, for that slot', async () => {
    let provider: ProviderConfig = DEFAULT_PROVIDER;
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('anthropic', KEY, OPTIONS);
    await keys.set('compatible:gemini', 'gem-key-123456789', OPTIONS);
    expect(await keyStatusOf(keys, undefined, async () => provider)).toEqual({ saved: true, last4: 'WXYZ' });
    provider = { active: 'compatible', compatible: { preset: 'gemini', baseURL: PRESETS.gemini.baseURL, fastModel: 'f', smartModel: 's', structuredOutputs: true, prices: {} } };
    expect(await keyStatusOf(keys, undefined, async () => provider)).toEqual({ saved: true, last4: '6789' });
    expect(await keyStatusOf(keys, 'compatible:groq', async () => provider)).toEqual({ saved: false, last4: null });
    expect(await keyStatusOf(keys, 'anthropic', async () => provider)).toEqual({ saved: true, last4: 'WXYZ' });
  });

  it('a page outside the extension cannot change any slot', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await expect(keys.set('compatible:gemini', 'sk-evil-key-123456', 'https://docs.google.com/document/d/1')).rejects.toThrow();
    await expect(keys.clear('compatible:gemini', undefined)).rejects.toThrow();
    expect(await keys.get('compatible:gemini')).toBeNull();
  });
});

describe('the Custom key and the address it was saved for', () => {
  const A = 'https://a.example/v1';

  it('is saved with its address\'s origin, and given only for calls to that origin', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('compatible:custom', 'KEY-FOR-A', OPTIONS, A);
    expect(await getBoundOrigin('compatible:custom')).toBe('https://a.example');
    expect(await keys.keyFor('compatible:custom', 'https://a.example/v2')).toBe('KEY-FOR-A'); // same origin, any path
    expect(await keys.keyFor('compatible:custom', 'https://b.example/v1')).toBeNull();
    expect(await keys.keyFor('compatible:custom', 'https://a.example:8443/v1')).toBeNull(); // another port is another origin
    expect(await keys.keyFor('compatible:custom', 'http://a.example/v1')).toBeNull();
    expect(await keys.keyFor('compatible:custom', '')).toBeNull();
  });

  it('a call on a stored Custom config gets the key only when its address is the one the key was saved for', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('compatible:custom', 'KEY-FOR-A', OPTIONS, A);
    expect(await keyForProvider(keys, custom(A))).toBe('KEY-FOR-A');
    expect(await keyForProvider(keys, custom('https://evil.example/v1'))).toBeNull(); // a tampered or newer address
    expect(await keyForProvider(keys, { active: 'anthropic', compatible: custom(A).compatible })).toBeNull(); // Claude's slot, empty
  });

  it('a Custom key without a valid address is refused, and nothing is stored', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await expect(keys.set('compatible:custom', 'KEY', OPTIONS)).rejects.toThrow();
    await expect(keys.set('compatible:custom', 'KEY', OPTIONS, 'http://a.example/v1')).rejects.toThrow();
    expect(await keys.get('compatible:custom')).toBeNull();
  });

  it('a new Custom key replaces the old one and its address; clearing removes both', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('compatible:custom', 'KEY-FOR-A', OPTIONS, A);
    await keys.set('compatible:custom', 'KEY-FOR-B', OPTIONS, 'https://b.example/v1');
    expect(await keys.keyFor('compatible:custom', A)).toBeNull();
    expect(await keys.keyFor('compatible:custom', 'https://b.example/v1')).toBe('KEY-FOR-B');
    await keys.clear('compatible:custom', OPTIONS);
    expect(await keys.get('compatible:custom')).toBeNull();
    expect(await getBoundOrigin('compatible:custom')).toBeNull();
  });

  it('fixed presets\' keys need no address: theirs is fixed', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('compatible:openai', 'sk-open', OPTIONS);
    expect(await keyForProvider(keys, { active: 'compatible', compatible: { ...custom(A).compatible!, preset: 'openai', baseURL: 'https://evil.example/v1' } })).toBe('sk-open');
  });

  it('keyStatus with no slot says no key when the Custom key belongs to another address', async () => {
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    await keys.set('compatible:custom', 'KEY-FOR-A-1234', OPTIONS, A);
    expect(await keyStatusOf(keys, undefined, async () => custom(A))).toEqual({ saved: true, last4: '1234' });
    expect(await keyStatusOf(keys, undefined, async () => custom('https://b.example/v1'))).toEqual({ saved: false, last4: null });
    expect(await keyStatusOf(keys, 'compatible:custom', async () => custom('https://b.example/v1'))).toEqual({ saved: true, last4: '1234' }); // the slot itself, for Options
  });

  describe('a Custom key an earlier build saved with no address', () => {
    it('is bound to the saved Custom address', async () => {
      await setStoredKey('compatible:custom', 'OLD-KEY');
      await bindLegacyCustomKey(async () => ({ active: 'anthropic', compatible: custom(A).compatible }));
      expect(await getBoundOrigin('compatible:custom')).toBe('https://a.example');
      expect(await getStoredKey('compatible:custom')).toBe('OLD-KEY');
    });

    it('is dropped when no Custom address is saved', async () => {
      await setStoredKey('compatible:custom', 'OLD-KEY');
      await setStoredKey('anthropic', KEY);
      await bindLegacyCustomKey(async () => ({ active: 'compatible', compatible: { ...custom(A).compatible!, preset: 'groq', baseURL: PRESETS.groq.baseURL } }));
      expect(await getStoredKey('compatible:custom')).toBeNull();
      expect(await getStoredKey('anthropic')).toBe(KEY);
    });

    it('a bound key is left as it is', async () => {
      await setStoredKey('compatible:custom', 'KEY-FOR-B', 'https://b.example');
      await bindLegacyCustomKey(async () => custom(A));
      expect(await getBoundOrigin('compatible:custom')).toBe('https://b.example');
    });

    it('a store created at startup binds it before any read answers', async () => {
      await setStoredKey('compatible:custom', 'OLD-KEY');
      const keys = createKeyStore(ORIGIN, async () => custom(A));
      expect(await keys.keyFor('compatible:custom', A)).toBe('OLD-KEY');
    });
  });
});

describe('migration from storage.local', () => {
  it('moves local:apiKey into the key store and removes it from storage.local', async () => {
    await fakeBrowser.storage.local.set({ apiKey: KEY, capUsd: 10 });
    await migrateLegacyKey();
    expect(await getStoredKey('anthropic')).toBe(KEY);
    const local = await fakeBrowser.storage.local.get(null);
    expect(local).toEqual({ capUsd: 10 });
    expect(JSON.stringify(local)).not.toContain('SECRET');
  });

  it('a store created at startup migrates before any read answers', async () => {
    await fakeBrowser.storage.local.set({ apiKey: KEY });
    const keys = createKeyStore(ORIGIN, NONE_SAVED);
    expect(await keys.get('anthropic')).toBe(KEY); // no key_missing window right after a worker restart
    expect(await keys.status('anthropic')).toEqual({ saved: true, last4: 'WXYZ' });
    expect(JSON.stringify(await fakeBrowser.storage.local.get(null))).not.toContain('SECRET');
  });

  it('with nothing to migrate, the stored key is left alone', async () => {
    await setStoredKey('anthropic', KEY);
    await migrateLegacyKey();
    expect(await getStoredKey('anthropic')).toBe(KEY);
  });

  it('an empty legacy value is removed without touching the stored key', async () => {
    await setStoredKey('anthropic', KEY);
    await fakeBrowser.storage.local.set({ apiKey: '' });
    await migrateLegacyKey();
    expect(await getStoredKey('anthropic')).toBe(KEY);
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });
});
