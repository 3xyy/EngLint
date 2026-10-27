import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { type MockReply, paragraphsOf, startMockAnthropic } from './mock-anthropic';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

const EXTENSION_DIR = resolve('.output-e2e/chrome-mv3'); // npm run build:e2e
const PAGES_DIR = resolve('tests/e2e/pages');
const MOCK_PORT = 4010;

type Responder = (body: any) => Promise<MockReply>;

export interface Mock {
  /** Every request body the mock received, in order. */
  readonly requests: any[];
  /** Number of replies sent (requests whose responder has settled). */
  readonly responses: number;
  respond(fn: Responder): void;
}

/** Default: every paragraph comes back clean. */
const clean: Responder = async (body) => ({
  results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: [] })),
});

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

function servePages(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = normalize(join(PAGES_DIR, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
    if (!path.startsWith(PAGES_DIR) || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

export const test = base.extend<
  { bfcache: boolean; context: BrowserContext; serviceWorker: Worker; extensionId: string; mock: Mock },
  { pagesURL: string }
>({
  // Playwright launches Chromium with the back/forward cache off; `test.use({ bfcache: true })` keeps it on.
  bfcache: [false, { option: true }],

  pagesURL: [
    async ({}, use) => {
      const server = await servePages();
      await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    },
    { scope: 'worker' },
  ],

  // A fresh profile per test: the worker's result cache, dismissals and key latch must not leak between tests.
  context: async ({ bfcache }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      ...(bfcache ? { ignoreDefaultArgs: ['--disable-back-forward-cache'] } : {}),
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await setKey(sw, 'sk-test');
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  mock: async ({}, use) => {
    let responder: Responder = clean;
    const server = await startMockAnthropic(MOCK_PORT, (body) => responder(body));
    await use({
      get requests() {
        return server.requests;
      },
      get responses() {
        return server.responses;
      },
      respond(fn) {
        responder = fn;
      },
    });
    await server.close();
  },
});

export const expect = test.expect;

/**
 * The background's key store (src/background/key-store.ts: database `englint-key` v1, store `key`, id
 * `apiKey`), opened from inside the worker, where it lives. `null` removes the key.
 */
/**
 * Saves Clarity on in Essay and Standard, so a spec that drives clarity suggestions doesn't depend on the shipped
 * defaults; the other families are saved at today's defaults. Call it before the page loads.
 */
export async function clarityOn(sw: Worker): Promise<void> {
  await sw.evaluate(() =>
    chrome.storage.local.set({
      suggestionFamiliesByMode: {
        essay: { clarity: true, engagement: true, delivery: true, generic: false },
        standard: { clarity: true, engagement: false, delivery: false, generic: false },
        casual: { clarity: false, engagement: false, delivery: false, generic: false },
      },
    }),
  );
}

export async function setKey(sw: Worker, key: string | null): Promise<void> {
  await sw.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const open = indexedDB.open('englint-key', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('key')) open.result.createObjectStore('key');
      };
      open.onsuccess = () => ok(open.result);
      open.onerror = () => fail(open.error);
    });
    try {
      await new Promise<void>((ok, fail) => {
        const tx = db.transaction('key', 'readwrite');
        if (key === null) tx.objectStore('key').delete('apiKey');
        else tx.objectStore('key').put(key, 'apiKey');
        tx.oncomplete = () => ok();
        tx.onerror = () => fail(tx.error);
      });
    } finally {
      db.close();
    }
  }, key);
}

/** The key in the background's key store, or null. */
export async function getKey(sw: Worker): Promise<string | null> {
  return sw.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const open = indexedDB.open('englint-key', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('key')) open.result.createObjectStore('key');
      };
      open.onsuccess = () => ok(open.result);
      open.onerror = () => fail(open.error);
    });
    try {
      return await new Promise<string | null>((ok, fail) => {
        const get = db.transaction('key').objectStore('key').get('apiKey');
        get.onsuccess = () => ok(get.result ?? null);
        get.onerror = () => fail(get.error);
      });
    } finally {
      db.close();
    }
  });
}

/** Records every chrome.storage change (any area) in the worker from now on; `read()` returns them. */
export async function recordStorageChanges(sw: Worker): Promise<{ read(): Promise<unknown[]> }> {
  await sw.evaluate(() => {
    const g = globalThis as any;
    g.__englintChanges = [];
    chrome.storage.onChanged.addListener((changes: unknown, area: string) => g.__englintChanges.push({ area, changes }));
  });
  return { read: () => sw.evaluate(() => (globalThis as any).__englintChanges as unknown[]) };
}

/**
 * Records in the worker from now on every URL a tab update reports, and the type, tab and frame of every message
 * a content script sends; `urls()` and `messages()` return them.
 */
export async function recordTabActivity(sw: Worker): Promise<{
  urls(): Promise<string[]>;
  messages(): Promise<{ type: string; tabId: number; frameId: number }[]>;
}> {
  await sw.evaluate(() => {
    const g = globalThis as any;
    g.__englintUrls = [];
    g.__englintMessages = [];
    chrome.tabs.onUpdated.addListener((_tabId: number, change: { url?: string }) => {
      if (change.url) g.__englintUrls.push(change.url);
    });
    chrome.runtime.onMessage.addListener((m: { type?: unknown }, sender: any) => {
      if (sender.tab) g.__englintMessages.push({ type: m?.type, tabId: sender.tab.id, frameId: sender.frameId });
    });
  });
  return {
    urls: () => sw.evaluate(() => (globalThis as any).__englintUrls as string[]),
    messages: () => sw.evaluate(() => (globalThis as any).__englintMessages),
  };
}
