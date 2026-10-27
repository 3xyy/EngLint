import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cacheKey, cacheVia, getCached } from '../../src/background/cache';
import { createChatService } from '../../src/background/chat-service';
import { createCheckService } from '../../src/background/check-service';
import { createKeyStore, keyForProvider, setStoredKey } from '../../src/background/key-store';
import { clientFor } from '../../src/background/llm';
import { createProviderOps } from '../../src/background/provider-ops';
import { createReviewService } from '../../src/background/review-service';
import { createToolsService } from '../../src/background/tools-service';
import type { ChatServerMessage } from '../../src/core/chat-format';
import { activeSlot, DEFAULT_PROVIDER, PRESETS, type KeySlot, type PresetId, type ProviderConfig } from '../../src/core/provider';
import { providerItem } from '../../src/shared/settings';

// A Save on the Options page can land while a call is on its way (between reading the settings, the key, the
// permission and the cache). Wherever it lands, the key that leaves must be the one saved for the address it goes to.

const ORIGIN = 'chrome-extension://pfkhcgfebppldojflbbnoffdphlcnhjk/';
const PANEL = { url: `${ORIGIN}sidepanel.html` };
const clock = new Date(2026, 9, 18, 12, 0, 0);

const compat = (preset: PresetId, baseURL = PRESETS[preset].baseURL): ProviderConfig => ({
  active: 'compatible',
  compatible: { preset, baseURL, fastModel: 'fast-m', smartModel: 'smart-m', structuredOutputs: false, prices: {} },
});
const CLAUDE = DEFAULT_PROVIDER;
const GROQ = compat('groq');
const OTHER = compat('custom', 'https://other.example/v1');

/** Each slot's key, and the origin it was saved for (a Custom key is stored bound to it). */
const KEYS: Record<string, { key: string; origin: string }> = {
  anthropic: { key: 'sk-ant-' + 'CLAUDE-KEY', origin: 'https://api.anthropic.com' },
  'compatible:groq': { key: 'gsk-GROQ-KEY', origin: 'https://api.groq.com' },
  'compatible:custom': { key: 'sk-OTHER-KEY', origin: 'https://other.example' },
};

const LIVE = JSON.stringify({ results: [{ paragraph_id: 'p0', issues: [] }] });

/** Every request that left: its origin and the key it carried (Anthropic's header or a bearer token). */
let sent: { origin: string; key: string | null }[] = [];
const wire = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  sent.push({ origin: new URL(req.url).origin, key: req.headers.get('x-api-key') ?? bearer });
  if (new URL(req.url).hostname === 'api.anthropic.com') {
    return Response.json({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: LIVE }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  }
  return Response.json({
    id: 'c1', object: 'chat.completion', created: 1, model: 'fast-m',
    choices: [{ index: 0, message: { role: 'assistant', content: LIVE }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});

/**
 * The deps as the background wires them, with a Save of `next` landing right after the key is read: the call
 * started on `from`, so everything it sends must be `from`'s.
 */
function wired(next: ProviderConfig) {
  const keys = createKeyStore(ORIGIN, () => providerItem.getValue());
  const canReach = vi.fn(async (_pattern: string) => true);
  const asked: KeySlot[] = [];
  const getApiKey = async (p: ProviderConfig) => {
    asked.push(activeSlot(p)!);
    const key = await keyForProvider(keys, p);
    await providerItem.setValue(next); // the writer's Save
    return key;
  };
  const getKey = async (slot: KeySlot, endpoint: string) => {
    asked.push(slot);
    const key = await keys.keyFor(slot, endpoint);
    await providerItem.setValue(next);
    return key;
  };
  return { getApiKey, getKey, makeClient: (c: ProviderConfig, key: string | null) => clientFor(c, key), canReach, now: () => clock, asked };
}

/** Each request's key is the one saved for the origin it went to, and every request went to `from`'s origin. */
function expectOnly(from: ProviderConfig) {
  const want = KEYS[activeSlot(from)!]!;
  expect(sent.length).toBeGreaterThan(0);
  expect(sent).toEqual(sent.map(() => ({ origin: want.origin, key: want.key })));
}

const DIRECTIONS = [
  ['Claude to a custom endpoint', CLAUDE, OTHER],
  ['one preset to another', GROQ, OTHER],
  ['a custom endpoint to Claude', OTHER, CLAUDE],
] as const;

beforeEach(async () => {
  fakeBrowser.reset();
  indexedDB.deleteDatabase('englint');
  sent = [];
  wire.mockClear();
  vi.stubGlobal('fetch', wire);
  for (const [slot, { key, origin }] of Object.entries(KEYS)) await setStoredKey(slot as KeySlot, key, slot === 'compatible:custom' ? origin : undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('a provider switch while a call is on its way', () => {
  it.each(DIRECTIONS)('a live check keeps to the provider it started on: %s', async (_, from, next) => {
    await providerItem.setValue(from);
    const d = wired(next);
    const r = await createCheckService(d).check({ host: 'example.com', mode: 'standard', paragraphs: [{ hash: 'h1', text: 'Hello there.' }] });
    expect(r.status).toBe('ok');
    expectOnly(from);
    expect(d.asked).toEqual([activeSlot(from)]);
    // The gate checked the endpoint the request went to (Claude's host needs no check).
    expect(d.canReach.mock.calls).toEqual(from.active === 'compatible' ? [[`${KEYS[activeSlot(from)!]!.origin}/*`]] : []);
    // Its results are cached as the starting provider's, never the next one's.
    const key = (p: ProviderConfig) => cacheKey('h1', 'standard', 'en-US', '', cacheVia(p));
    expect((await getCached([key(from)])).size).toBe(1);
    expect((await getCached([key(next)])).size).toBe(0);
  });

  it.each(DIRECTIONS)('a tool keeps to the provider it started on: %s', async (_, from, next) => {
    await providerItem.setValue(from);
    await createToolsService({ ...wired(next), extensionOrigin: ORIGIN }).synonyms({ host: 'example.com', mode: 'standard', target: 'happy', sentence: 'I am happy today.', targetStart: 5 });
    expectOnly(from);
  });

  it.each(DIRECTIONS)('a review keeps to the provider it started on: %s', async (_, from, next) => {
    await providerItem.setValue(from);
    await createReviewService({ ...wired(next), tabUrl: async () => 'https://example.com/', extensionOrigin: ORIGIN }).tone({ tabId: 7, text: 'I walked home.', mode: 'standard' }, PANEL);
    expectOnly(from);
  });

  it.each(DIRECTIONS)('a chat answer keeps to the provider it started on: %s', async (_, from, next) => {
    await providerItem.setValue(from);
    const svc = createChatService({ ...wired(next), tabUrl: async () => 'https://mail.example.com/', extensionOrigin: ORIGIN });
    const out: ChatServerMessage[] = [];
    let on: (m: unknown) => void = () => {};
    svc.connect({
      name: 'englint-chat',
      sender: PANEL,
      postMessage: (m: ChatServerMessage) => void out.push(m),
      onMessage: { addListener: (cb: (m: unknown) => void) => (on = cb) },
      onDisconnect: { addListener: () => {} },
    } as never);
    on({ type: 'send', tabId: 7, fieldId: 'f', mode: 'standard', text: 'Dear Sam.', focus: null, message: 'Friendly?' });
    await vi.waitFor(() => expect(out.some((m) => m.type === 'done' || m.type === 'status')).toBe(true));
    expectOnly(from);
  });

  it.each(DIRECTIONS)('the key test keeps to the provider it started on: %s', async (_, from, next) => {
    await providerItem.setValue(from);
    const d = wired(next);
    const ops = createProviderOps({ ...d, extensionOrigin: ORIGIN, getDialect: async () => 'en-US' });
    await ops.testKey(`${ORIGIN}options.html`);
    expectOnly(from);
  });
});

describe('a Custom key is used only at the address it was saved for', () => {
  // The key was saved for a.example; the stored settings point Custom elsewhere (edited in storage, or saved
  // without its key). Every call behaves as if there were no key, and nothing leaves.
  const ELSEWHERE = compat('custom', 'https://elsewhere.example/v1');
  function plain() {
    const keys = createKeyStore(ORIGIN, () => providerItem.getValue());
    const canReach = vi.fn(async (_pattern: string) => true);
    return {
      getApiKey: (p: ProviderConfig) => keyForProvider(keys, p),
      getKey: (slot: KeySlot, endpoint: string) => keys.keyFor(slot, endpoint),
      makeClient: (c: ProviderConfig, key: string | null) => clientFor(c, key),
      canReach,
      now: () => clock,
    };
  }
  beforeEach(async () => {
    await setStoredKey('compatible:custom', 'KEY-FOR-A', 'https://a.example');
    await providerItem.setValue(ELSEWHERE);
  });

  it('a live check, a tool, a review, a chat answer and the key test are key_missing, with no request', async () => {
    const d = plain();
    const check = await createCheckService(d).check({ host: 'example.com', mode: 'standard', paragraphs: [{ hash: 'h1', text: 'Hello there.' }] });
    const tool = await createToolsService({ ...d, extensionOrigin: ORIGIN }).synonyms({ host: 'example.com', mode: 'standard', target: 'happy', sentence: 'I am happy today.', targetStart: 5 });
    const review = await createReviewService({ ...d, tabUrl: async () => 'https://example.com/', extensionOrigin: ORIGIN }).tone({ tabId: 7, text: 'I walked home.', mode: 'standard' }, PANEL);
    const out: ChatServerMessage[] = [];
    let on: (m: unknown) => void = () => {};
    createChatService({ ...d, tabUrl: async () => 'https://mail.example.com/', extensionOrigin: ORIGIN }).connect({
      name: 'englint-chat',
      sender: PANEL,
      postMessage: (m: ChatServerMessage) => void out.push(m),
      onMessage: { addListener: (cb: (m: unknown) => void) => (on = cb) },
      onDisconnect: { addListener: () => {} },
    } as never);
    on({ type: 'send', tabId: 7, fieldId: 'f', mode: 'standard', text: 'Dear Sam.', focus: null, message: 'Friendly?' });
    await vi.waitFor(() => expect(out.length).toBeGreaterThan(0));
    const test = await createProviderOps({ ...d, extensionOrigin: ORIGIN, getDialect: async () => 'en-US' }).testKey(`${ORIGIN}options.html`);
    expect([check.status, tool.status, review.status, out.at(-1), test.status]).toEqual([
      'key_missing', 'key_missing', 'key_missing', { type: 'status', status: 'key_missing' }, 'key_missing',
    ]);
    expect(sent).toEqual([]);
  });

  it('a model list for another address is key_missing without a key typed, and carries only the typed one', async () => {
    const ops = createProviderOps({ ...plain(), extensionOrigin: ORIGIN });
    const slot = 'compatible:custom' as const;
    expect(await ops.listModels({ slot, baseURL: 'https://elsewhere.example/v1' }, `${ORIGIN}options.html`)).toEqual({ ok: false, status: 'key_missing' });
    expect(sent).toEqual([]);
    await ops.listModels({ slot, baseURL: 'https://elsewhere.example/v1', key: 'KEY-TYPED' }, `${ORIGIN}options.html`);
    expect(sent).toEqual([{ origin: 'https://elsewhere.example', key: 'KEY-TYPED' }]);
    sent = [];
    await ops.listModels({ slot, baseURL: 'https://a.example/v1' }, `${ORIGIN}options.html`); // its own address: the stored key
    expect(sent).toEqual([{ origin: 'https://a.example', key: 'KEY-FOR-A' }]);
  });
});

describe('provider settings tampered in storage', () => {
  // Saved as no Options page would save them. They read as the default: Claude, with its own key, at its own address.
  const EVIL = compat('custom', 'https://evil.example/v1').compatible!;
  function plain() {
    const keys = createKeyStore(ORIGIN, () => providerItem.getValue());
    return {
      getApiKey: (p: ProviderConfig) => keyForProvider(keys, p),
      getKey: (slot: KeySlot, endpoint: string) => keys.keyFor(slot, endpoint),
      makeClient: (c: ProviderConfig, key: string | null) => clientFor(c, key),
      canReach: vi.fn(async (_pattern: string) => true),
      now: () => clock,
    };
  }
  beforeEach(async () => {
    await setStoredKey('compatible:custom', 'sk-EVIL-BOUND', 'https://evil.example');
  });

  it.each([
    ['an unknown active', { active: 'bogus', compatible: EVIL }],
    ['a missing active', { compatible: EVIL }],
    ['a preset that is an object built-in', { active: 'compatible', compatible: { ...EVIL, preset: '__proto__' } }],
    ['a preset named toString', { active: 'compatible', compatible: { ...EVIL, preset: 'toString' } }],
  ])('%s sends nothing to the stored address, and every flow runs on Claude', async (_, raw) => {
    await fakeBrowser.storage.local.set({ provider: raw });
    const d = plain();
    const check = await createCheckService(d).check({ host: 'example.com', mode: 'standard', paragraphs: [{ hash: 'h1', text: 'Hello there.' }] });
    await createToolsService({ ...d, extensionOrigin: ORIGIN }).synonyms({ host: 'example.com', mode: 'standard', target: 'happy', sentence: 'I am happy today.', targetStart: 5 });
    await createReviewService({ ...d, tabUrl: async () => 'https://example.com/', extensionOrigin: ORIGIN }).tone({ tabId: 7, text: 'I walked home.', mode: 'standard' }, PANEL);
    const out: ChatServerMessage[] = [];
    let on: (m: unknown) => void = () => {};
    createChatService({ ...d, tabUrl: async () => 'https://mail.example.com/', extensionOrigin: ORIGIN }).connect({
      name: 'englint-chat',
      sender: PANEL,
      postMessage: (m: ChatServerMessage) => void out.push(m),
      onMessage: { addListener: (cb: (m: unknown) => void) => (on = cb) },
      onDisconnect: { addListener: () => {} },
    } as never);
    on({ type: 'send', tabId: 7, fieldId: 'f', mode: 'standard', text: 'Dear Sam.', focus: null, message: 'Friendly?' });
    await vi.waitFor(() => expect(out.some((m) => m.type === 'done' || m.type === 'status')).toBe(true));
    await createProviderOps({ ...d, extensionOrigin: ORIGIN, getDialect: async () => 'en-US' }).testKey(`${ORIGIN}options.html`);
    expect(check.status).toBe('ok');
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(sent).toEqual(sent.map(() => ({ origin: 'https://api.anthropic.com', key: 'sk-ant-' + 'CLAUDE-KEY' })));
    expect(d.canReach).not.toHaveBeenCalled();
  });
});

