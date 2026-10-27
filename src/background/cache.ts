import { type IDBPDatabase, openDB } from 'idb';
import { endpointOf, type ProviderConfig } from '../core/provider';
import type { Dialect, Mode, RawIssue } from '../core/types';
import { PROMPT_VERSION } from './prompts/live-check';

const MAX_ENTRIES = 5000;

interface ResultRow {
  issues: RawIssue[];
  /** Monotonic write time, used to evict the oldest rows. */
  t: number;
}

// A short-lived connection per call: nothing stays open across service-worker restarts.
async function withDb<T>(fn: (db: IDBPDatabase) => Promise<T>): Promise<T> {
  const db = await openDB('englint', 1, {
    upgrade(d) {
      d.createObjectStore('results').createIndex('by-t', 't');
      d.createObjectStore('dismissals');
    },
  });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * No family toggles: the request always asks for every family the mode allows. Toggles filter on the client.
 * `userHash` is the writer's dictionary (learnedKey): '' when empty, so a change to it misses the cache.
 * `via` is cacheVia(): empty for Claude.
 */
export function cacheKey(hash: string, mode: Mode, dialect: Dialect, userHash: string, via = ''): string {
  return `${PROMPT_VERSION}|${mode}|${dialect}|${userHash}|${via}${hash}`;
}

/**
 * The part of a cache key that names who answered, so one provider's or model's results are never served for
 * another's: '' for Claude (its keys are as they always were), else the provider, its address if custom, and the fast model.
 */
export function cacheVia(c: ProviderConfig): string {
  const k = c.active === 'compatible' ? c.compatible : null;
  if (!k) return '';
  return `compatible:${k.preset === 'custom' ? `custom@${endpointOf(k)}` : k.preset}:${k.fastModel}|`;
}

export function getCached(keys: string[]): Promise<Map<string, RawIssue[]>> {
  return withDb(async (db) => {
    const out = new Map<string, RawIssue[]>();
    const tx = db.transaction('results');
    const rows = await Promise.all(keys.map((k) => tx.store.get(k) as Promise<ResultRow | undefined>));
    keys.forEach((k, i) => {
      if (rows[i]) out.set(k, rows[i].issues);
    });
    return out;
  });
}

let lastT = 0;

/** Stores entries, then evicts everything but the newest 5,000. */
export function putCached(entries: Array<[string, RawIssue[]]>): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  return withDb(async (db) => {
    const tx = db.transaction('results', 'readwrite');
    for (const [key, issues] of entries) {
      lastT = Math.max(lastT + 1, Date.now());
      tx.store.put({ issues, t: lastT } satisfies ResultRow, key);
    }
    const excess = (await tx.store.count()) - MAX_ENTRIES;
    if (excess > 0) {
      let cursor = await tx.store.index('by-t').openCursor();
      for (let i = 0; cursor && i < excess; i++) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
    }
    await tx.done;
  });
}

/** Key format is `${paragraphHash}|${original}|${kind}` (see dismissalKey). */
export function addDismissal(key: string): Promise<void> {
  return withDb(async (db) => {
    await db.put('dismissals', true, key);
  });
}

export function getDismissalsFor(paragraphHashes: string[]): Promise<string[]> {
  if (paragraphHashes.length === 0) return Promise.resolve([]);
  return withDb(async (db) => {
    const lists = await Promise.all(
      [...new Set(paragraphHashes)].map((h) =>
        db.getAllKeys('dismissals', IDBKeyRange.bound(`${h}|`, `${h}|\uffff`)),
      ),
    );
    return lists.flat() as string[];
  });
}
