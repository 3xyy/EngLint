// The API key lives in the background worker's own IndexedDB, in the extension's origin. Content scripts
// run in the page's origin, so they can't open it, and unlike chrome.storage.local, saving the key sends
// no change event (with its old and new value) into every content script. The Custom key is stored with the origin
// it was saved for, and given only for calls there.
import { type IDBPDatabase, openDB } from 'idb';
import { storage } from 'wxt/utils/storage';
import { activeSlot, endpointOf, validateBaseURL, type KeySlot, type ProviderConfig } from '../core/provider';
import { isExtensionPage } from '../core/sites';
import { keyChangedItem } from '../shared/key-changed';
import { keyHint } from './key-hint';

export { isExtensionPage };

export const KEY_DB = 'englint-key';
const STORE = 'key';
// The Claude key keeps the id older builds used, so an existing key is simply the 'anthropic' slot.
const keyId = (slot: KeySlot) => (slot === 'anthropic' ? 'apiKey' : `apiKey:${slot}`);
/** Where the origin a key was saved for is kept, beside the key. Only the Custom slot has one: a fixed preset's address is its own. */
const originId = (slot: KeySlot) => `apiKeyOrigin:${slot}`;
const CUSTOM: KeySlot = 'compatible:custom';

/** Where the key lived before: readable by every content script. Only the migration touches it. */
const legacyApiKeyItem = storage.defineItem<string | null>('local:apiKey', { fallback: null });

// A short-lived connection per call, as in cache.ts.
async function withDb<T>(fn: (db: IDBPDatabase) => Promise<T>): Promise<T> {
  const db = await openDB(KEY_DB, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export function getStoredKey(slot: KeySlot): Promise<string | null> {
  return withDb(async (db) => {
    const key: unknown = await db.get(STORE, keyId(slot));
    return typeof key === 'string' ? key : null;
  });
}

/** The origin the key in `slot` was saved for, or null (none bound). */
export function getBoundOrigin(slot: KeySlot): Promise<string | null> {
  return withDb(async (db) => {
    const origin: unknown = await db.get(STORE, originId(slot));
    return typeof origin === 'string' ? origin : null;
  });
}

/** Stores the key in `slot`, and the origin it was saved for (none: any bound one is removed), in one transaction. */
export function setStoredKey(slot: KeySlot, key: string, origin?: string): Promise<void> {
  return withDb(async (db) => {
    const tx = db.transaction(STORE, 'readwrite');
    await Promise.all([
      tx.store.put(key, keyId(slot)),
      origin === undefined ? tx.store.delete(originId(slot)) : tx.store.put(origin, originId(slot)),
      tx.done,
    ]);
  });
}

export function clearStoredKey(slot: KeySlot): Promise<void> {
  return withDb(async (db) => {
    const tx = db.transaction(STORE, 'readwrite');
    await Promise.all([tx.store.delete(keyId(slot)), tx.store.delete(originId(slot)), tx.done]);
  });
}

/** Moves a key saved by an older build from storage.local into the key store, then removes it there. */
export async function migrateLegacyKey(): Promise<void> {
  const legacy = await legacyApiKeyItem.getValue();
  if (legacy === null) return;
  if (typeof legacy === 'string' && legacy.trim() !== '') await setStoredKey('anthropic', legacy.trim());
  await legacyApiKeyItem.removeValue();
}

/**
 * Binds a Custom key an earlier build saved with no origin to the saved Custom address's origin, or drops it when no
 * Custom address is saved: a key with no origin is never sent anywhere.
 */
export async function bindLegacyCustomKey(savedProvider: () => Promise<ProviderConfig>): Promise<void> {
  if ((await getStoredKey(CUSTOM)) === null || (await getBoundOrigin(CUSTOM)) !== null) return;
  const saved = (await savedProvider()).compatible;
  const checked = saved?.preset === 'custom' ? validateBaseURL(endpointOf(saved)) : null;
  if (checked?.ok) {
    await withDb(async (db) => {
      await db.put(STORE, checked.origin, originId(CUSTOM));
    });
  } else {
    await clearStoredKey(CUSTOM);
  }
}

export interface KeyStore {
  /** Resolves once the older builds' keys were migrated; every method waits for it. */
  ready: Promise<void>;
  /** The key stored in `slot`, whatever it was saved for (the Options page's hint, the install check). */
  get(slot: KeySlot): Promise<string | null>;
  /**
   * The key in `slot` for calls to `endpoint`: a Custom key only when `endpoint`'s origin is the one it was saved
   * for, otherwise null, as if there were none. Every call that sends a key takes it from here.
   */
  keyFor(slot: KeySlot, endpoint: string): Promise<string | null>;
  status(slot: KeySlot): Promise<{ saved: boolean; last4: string | null }>;
  /**
   * Saves the key (trimmed). Only this extension's pages may: `senderUrl` is the message sender's URL. A Custom key
   * needs `baseURL`, the address it is for: its origin is stored with it.
   */
  set(slot: KeySlot, key: string, senderUrl: string | undefined, baseURL?: string): Promise<void>;
  clear(slot: KeySlot, senderUrl: string | undefined): Promise<void>;
}

/**
 * The background's key store. Created once at startup, so the migrations run before the first read; `savedProvider`
 * gives the saved settings, for binding an older build's Custom key to its address.
 */
export function createKeyStore(extensionOrigin: string, savedProvider: () => Promise<ProviderConfig>): KeyStore {
  const ready = Promise.all([
    migrateLegacyKey().catch(() => {
      // a failed migration leaves the legacy key where it was; reads still work
    }),
    bindLegacyCustomKey(savedProvider).catch(() => {
      // a failed binding leaves the key unbound, so it is never given for a call
    }),
  ]).then(() => {});
  const fromPage = (senderUrl: string | undefined) => {
    if (!isExtensionPage(senderUrl, extensionOrigin)) throw new Error('Only EngLint pages can change the API key.');
  };
  const changed = () => keyChangedItem.setValue(Date.now());
  const get = async (slot: KeySlot) => {
    await ready;
    return getStoredKey(slot);
  };
  return {
    ready,
    get,
    async keyFor(slot, endpoint) {
      const key = await get(slot);
      if (slot !== CUSTOM || key === null) return key;
      const checked = validateBaseURL(endpoint);
      return checked.ok && (await getBoundOrigin(slot)) === checked.origin ? key : null;
    },
    status: async (slot) => keyHint(await get(slot)),
    async set(slot, key, senderUrl, baseURL) {
      fromPage(senderUrl);
      if (typeof key !== 'string' || key.trim() === '') throw new Error('No key given.');
      const checked = slot === CUSTOM ? validateBaseURL(typeof baseURL === 'string' ? baseURL : '') : null;
      if (checked && !checked.ok) throw new Error('A Custom key needs the address it is for.');
      await ready;
      await setStoredKey(slot, key.trim(), checked?.origin);
      await changed();
    },
    async clear(slot, senderUrl) {
      fromPage(senderUrl);
      await ready;
      await clearStoredKey(slot);
      await changed();
    },
  };
}

/** The key a call on `c` may carry: its slot's (activeSlot), and a Custom key only for the address it was saved for. */
export async function keyForProvider(keys: Pick<KeyStore, 'keyFor'>, c: ProviderConfig): Promise<string | null> {
  const slot = activeSlot(c);
  if (slot === null) return null; // settings it doesn't know reach no key
  return keys.keyFor(slot, slot !== 'anthropic' && c.compatible ? endpointOf(c.compatible) : '');
}

/**
 * The `keyStatus` message: the slot asked for (the Options page, about what is stored), or with none (content
 * scripts) whether the active provider's calls have a key.
 */
export async function keyStatusOf(keys: Pick<KeyStore, 'status' | 'keyFor'>, slot: KeySlot | undefined, provider: () => Promise<ProviderConfig>) {
  return slot ? keys.status(slot) : keyHint(await keyForProvider(keys, await provider()));
}
