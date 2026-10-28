import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cacheKey, cacheVia, getCached } from '../../src/background/cache';
import { createChatService } from '../../src/background/chat-service';
import { createCheckService } from '../../src/background/check-service';
import type { LlmClient } from '../../src/background/llm';
import { endpointBlocked, readProvider } from '../../src/background/provider-gate';
import { createReviewService } from '../../src/background/review-service';
import { createToolsService } from '../../src/background/tools-service';
import { getMonthSpend } from '../../src/background/usage';
import type { ChatServerMessage } from '../../src/core/chat-format';
import { DEFAULT_PROVIDER, PRESETS, type CompatibleConfig, type ProviderConfig } from '../../src/core/provider';

const USAGE = { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const clock = new Date(2026, 9, 18, 12, 0, 0);
const ORIGIN = 'chrome-extension://pfkhcgfebppldojflbbnoffdphlcnhjk/';
const PANEL = { url: `${ORIGIN}sidepanel.html` };

const compat = (over: Partial<CompatibleConfig> = {}): ProviderConfig => ({
  active: 'compatible',
  compatible: { preset: 'openai', baseURL: PRESETS.openai.baseURL, fastModel: 'gpt-x', smartModel: 'gpt-y', structuredOutputs: true, prices: {}, ...over },
});
const OPENAI = compat();
const OLLAMA = compat({ preset: 'ollama', baseURL: PRESETS.ollama.baseURL });

/** A client that answers every call, counting each as a request that would have gone to the network. */
function fakeClient(prices?: LlmClient['prices']) {
  const calls = { live: 0, tool: 0, chat: 0 };
  const client = {
    provider: 'compatible',
    fastModel: 'gpt-x',
    smartModel: 'gpt-y',
    prices,
    liveCheck: async (req: { paragraphs: { id: string; text: string }[] }) => {
      calls.live++;
      return {
        output: { results: req.paragraphs.map((p) => ({ paragraph_id: p.id, issues: [] })) },
        usage: USAGE,
        truncated: false,
        droppedInvalid: 0,
        model: 'gpt-x',
      };
    },
    startToolCall: () => {
      calls.tool++;
      return { model: 'gpt-y', done: Promise.resolve({ data: { tones: ['warm'] }, usage: USAGE, truncated: false, model: 'gpt-y' }), spentSoFar: () => null };
    },
    streamChat: () => {
      calls.chat++;
      return { done: Promise.resolve({ text: 'Hi.', usage: USAGE, complete: true, model: 'gpt-y' }), abort() {}, usageSoFar: () => null };
    },
    citations: null,
  } as unknown as LlmClient;
  return { client, calls };
}

/** The deps every service takes: a key (or none), the provider, and whether Chrome allows the origin. */
function deps(provider: ProviderConfig, key: string | null, allowed: boolean, client: LlmClient) {
  const canReach = vi.fn(async (_pattern: string) => allowed);
  const made = vi.fn(async (_provider: ProviderConfig, _key: string | null) => client);
  return {
    getApiKey: async (_provider: ProviderConfig) => key,
    getProvider: async () => provider,
    canReach,
    makeClient: made,
    now: () => clock,
    made,
    canReach_: canReach,
  };
}
const CHECK = { host: 'example.com', mode: 'standard' as const, paragraphs: [{ hash: 'h1', text: 'Hello there.' }] };

beforeEach(() => {
  fakeBrowser.reset();
  indexedDB.deleteDatabase('englint');
});

describe('the key gate', () => {
  it('lets a local server through with no key, and sends the call', async () => {
    const { client, calls } = fakeClient();
    const d = deps(OLLAMA, null, true, client);
    expect((await createCheckService(d).check(CHECK)).status).toBe('ok');
    expect(calls.live).toBe(1);
    expect(d.made).toHaveBeenCalledWith(OLLAMA, null);
  });

  it.each([
    ['Claude', DEFAULT_PROVIDER],
    ['a keyed preset', OPENAI],
    ['a custom endpoint', compat({ preset: 'custom', baseURL: 'https://api.example.com/v1' })],
  ])('still asks for a key for %s', async (_, provider) => {
    const { client, calls } = fakeClient();
    const d = deps(provider, null, true, client);
    expect((await createCheckService(d).check(CHECK)).status).toBe('key_missing');
    expect(calls.live).toBe(0);
  });

  it('holds in every service for a keyed provider, and lets a local server through in every one', async () => {
    for (const [provider, key, want] of [[OPENAI, null, false], [OLLAMA, null, true]] as const) {
      const { client, calls } = fakeClient();
      const d = deps(provider, key, true, client);
      const tools = await createToolsService({ ...d, extensionOrigin: ORIGIN }).synonyms({ host: 'example.com', mode: 'standard', target: 'happy', sentence: 'I am happy today.', targetStart: 5 });
      const review = await createReviewService({ ...d, tabUrl: async () => 'https://example.com/', extensionOrigin: ORIGIN }).tone({ tabId: 7, text: 'I walked home.', mode: 'standard' }, PANEL);
      const sent: ChatServerMessage[] = [];
      await runChat(d, sent);
      expect([tools.status !== 'key_missing', review.status !== 'key_missing', sent.some((m) => m.type === 'status' && m.status === 'key_missing') === false]).toEqual([want, want, want]);
      expect(calls.tool > 0).toBe(want);
    }
  });
});

/** One chat turn through a fake port, until its last message. */
async function runChat(d: ReturnType<typeof deps>, sent: ChatServerMessage[]) {
  const svc = createChatService({ ...d, tabUrl: async () => 'https://mail.example.com/', extensionOrigin: ORIGIN });
  let on: (m: unknown) => void = () => {};
  svc.connect({
    name: 'englint-chat',
    sender: PANEL,
    postMessage: (m: ChatServerMessage) => void sent.push(m),
    onMessage: { addListener: (cb: (m: unknown) => void) => (on = cb) },
    onDisconnect: { addListener: () => {} },
  } as never);
  on({ type: 'send', tabId: 7, fieldId: 'f', mode: 'standard', text: 'Dear Sam.', focus: null, message: 'Friendly?' });
  await vi.waitFor(() => expect(sent.some((m) => m.type === 'done' || m.type === 'status')).toBe(true));
}

describe('the endpoint permission', () => {
  it('a live check is endpoint_blocked, and nothing is requested, when Chrome has not granted the origin', async () => {
    const { client, calls } = fakeClient();
    const d = deps(OPENAI, 'sk-test', false, client);
    expect((await createCheckService(d).check(CHECK)).status).toBe('endpoint_blocked');
    expect(d.canReach_).toHaveBeenCalledWith('https://api.openai.com/*');
    expect(d.made).not.toHaveBeenCalled();
    expect(calls.live).toBe(0);
  });

  it('is endpoint_blocked in every service, with no request', async () => {
    const { client, calls } = fakeClient();
    const d = deps(OPENAI, 'sk-test', false, client);
    const tools = await createToolsService({ ...d, extensionOrigin: ORIGIN }).synonyms({ host: 'example.com', mode: 'standard', target: 'happy', sentence: 'I am happy today.', targetStart: 5 });
    const review = await createReviewService({ ...d, tabUrl: async () => 'https://example.com/', extensionOrigin: ORIGIN }).tone({ tabId: 7, text: 'I walked home.', mode: 'standard' }, PANEL);
    const sent: ChatServerMessage[] = [];
    await runChat(d, sent);
    expect([tools.status, review.status, sent.at(-1)]).toEqual(['endpoint_blocked', 'endpoint_blocked', { type: 'status', status: 'endpoint_blocked' }]);
    expect(d.made).not.toHaveBeenCalled();
    expect(calls).toEqual({ live: 0, tool: 0, chat: 0 });
  });

  it('holds for the word-limit tool too, with no request', async () => {
    const { client, calls } = fakeClient();
    const d = deps(OPENAI, 'sk-test', false, client);
    const text = 'In order to win the final, we really practiced every single day after school.';
    const r = await createToolsService({ ...d, extensionOrigin: ORIGIN }).wordLimit({ host: 'example.com', mode: 'essay', text, before: '', after: '', target: 10 });
    expect(r.status).toBe('endpoint_blocked');
    expect(d.made).not.toHaveBeenCalled();
    expect(calls.tool).toBe(0);
  });

  it('serves cached results without asking for the permission', async () => {
    const { client } = fakeClient();
    const allowed = deps(OPENAI, 'sk-test', true, client);
    await createCheckService(allowed).check(CHECK);
    const blocked = deps(OPENAI, 'sk-test', false, client);
    expect(await createCheckService(blocked).check(CHECK)).toMatchObject({ status: 'ok', results: { h1: [] } });
    expect(blocked.canReach_).not.toHaveBeenCalled();
  });

  it('asks Chrome with the origin as a match pattern, by default', async () => {
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(false as never);
    expect(await endpointBlocked({}, OPENAI)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    contains.mockResolvedValue(true as never);
    expect(await endpointBlocked({}, OPENAI)).toBe(false);
  });

  it('needs none for Claude, and checks nothing', async () => {
    const canReach = vi.fn(async () => false);
    expect(await endpointBlocked({ canReach }, DEFAULT_PROVIDER)).toBe(false);
    expect(canReach).not.toHaveBeenCalled();
  });

  it('blocks settings it doesn\'t know, whatever Chrome allows', async () => {
    const canReach = vi.fn(async () => true);
    const evil = compat({ preset: 'custom', baseURL: 'https://evil.example/v1' }).compatible;
    for (const active of ['bogus', undefined]) expect(await endpointBlocked({ canReach }, { active, compatible: evil } as unknown as ProviderConfig)).toBe(true);
    expect(await endpointBlocked({ canReach }, { active: 'compatible', compatible: null })).toBe(true);
    expect(canReach).not.toHaveBeenCalled();
  });

  it('readProvider gives the stored settings checked: a tampered value reads as the default', async () => {
    await fakeBrowser.storage.local.set({ provider: { active: 'bogus', compatible: OPENAI.compatible } });
    expect(await readProvider({})).toEqual(DEFAULT_PROVIDER);
    expect(await readProvider({ getProvider: async () => ({ active: 'compatible', compatible: { ...OPENAI.compatible!, preset: 'toString' } }) as unknown as ProviderConfig })).toEqual(DEFAULT_PROVIDER);
    expect(await readProvider({ getProvider: async () => OPENAI })).toEqual(OPENAI);
  });

  it('checks a fixed preset\'s own origin, never a tampered stored address', async () => {
    const { client } = fakeClient();
    const d = deps(compat({ baseURL: 'https://evil.example/v1' }), 'sk-test', true, client);
    await createCheckService(d).check(CHECK);
    expect(d.canReach_.mock.calls).toEqual([['https://api.openai.com/*']]);
  });

  it('checks a custom endpoint\'s saved origin, and blocks one that is not a valid address', async () => {
    const custom = compat({ preset: 'custom', baseURL: 'https://llm.example.com:8443/v1' });
    const canReach = vi.fn(async () => true);
    expect(await endpointBlocked({ canReach }, custom)).toBe(false);
    expect(canReach.mock.calls).toEqual([['https://llm.example.com:8443/*']]);
    expect(await endpointBlocked({ canReach }, compat({ preset: 'custom', baseURL: 'http://api.example.com/v1' }))).toBe(true);
    expect(canReach).toHaveBeenCalledTimes(1);
  });
});

describe('the live-check cache by provider', () => {
  it('keeps one provider\'s results from another, and Claude\'s keys as they were', async () => {
    const { client } = fakeClient();
    await createCheckService(deps(OPENAI, 'sk-test', true, client)).check(CHECK);
    const key = (p: ProviderConfig) => cacheKey('h1', 'standard', 'en-US', '', cacheVia(p));
    expect((await getCached([key(OPENAI)])).size).toBe(1);
    expect((await getCached([key(compat({ fastModel: 'other' })), key(compat({ preset: 'groq' })), key(DEFAULT_PROVIDER)])).size).toBe(0);
    expect(key(DEFAULT_PROVIDER)).toBe(cacheKey('h1', 'standard', 'en-US', ''));
  });

  it('a second provider checks the same paragraph again', async () => {
    const { client, calls } = fakeClient();
    await createCheckService(deps(OPENAI, 'sk-test', true, client)).check(CHECK);
    await createCheckService(deps(compat({ fastModel: 'other' }), 'sk-test', true, client)).check(CHECK);
    expect(calls.live).toBe(2);
  });
});

describe('spend on the writer\'s prices', () => {
  it('a priced model is billed from its entry; an unpriced one costs nothing', async () => {
    const priced = fakeClient({ 'gpt-x': { input: 0.5, output: 2 } });
    await createCheckService(deps(OPENAI, 'sk-test', true, priced.client)).check(CHECK);
    expect(await getMonthSpend(clock)).toBeCloseTo(0.5);

    fakeBrowser.reset();
    const unpriced = fakeClient({});
    await createCheckService(deps(OPENAI, 'sk-test', true, unpriced.client)).check(CHECK);
    expect(await getMonthSpend(clock)).toBe(0);
  });
});

describe('the Citation finder off Claude', () => {
  const claim = { tabId: 7, claim: 'Sleep doubles recall in adults.', before: '', after: '' };
  it('is bad_response, before a key, a permission or a request', async () => {
    const { client, calls } = fakeClient();
    const d = deps(OPENAI, null, false, client);
    const svc = createReviewService({ ...d, tabUrl: async () => 'https://example.com/', extensionOrigin: ORIGIN });
    expect(await svc.citations(claim, PANEL)).toEqual({ status: 'bad_response' });
    expect(d.canReach_).not.toHaveBeenCalled();
    expect(d.made).not.toHaveBeenCalled();
    expect(calls).toEqual({ live: 0, tool: 0, chat: 0 });
  });
});
