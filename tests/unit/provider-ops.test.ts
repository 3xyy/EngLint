import { APICallError } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { LiveCheckParseError } from '../../src/background/claude';
import type { LlmClient } from '../../src/background/llm';
import { createProviderOps } from '../../src/background/provider-ops';
import { getMonthSpend } from '../../src/background/usage';
import { DEFAULT_PROVIDER, PRESETS, type CompatibleConfig, type KeySlot, type ProviderConfig } from '../../src/core/provider';

const ORIGIN = 'chrome-extension://pfkhcgfebppldojflbbnoffdphlcnhjk/';
const OPTIONS = `${ORIGIN}options.html`;
const USAGE = { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const clock = new Date(2026, 9, 18, 12, 0, 0);

const compat = (over: Partial<CompatibleConfig> = {}): ProviderConfig => ({
  active: 'compatible',
  compatible: { preset: 'openai', baseURL: PRESETS.openai.baseURL, fastModel: 'gpt-x', smartModel: 'gpt-y', structuredOutputs: true, prices: {}, ...over },
});

/** An endpoint answering GET /models: every request is recorded, and `reply` answers it. */
function endpoint(reply: () => Response | Promise<Response> = () => Response.json({ object: 'list', data: [{ id: 'b-model' }, { id: 'a-model' }] })) {
  const sent: { url: string; headers: Headers }[] = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers) });
    return reply();
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

/** The ops with keys by slot, the provider, whether Chrome allows the pattern, and a client for the key test. */
function ops(over: { keys?: Partial<Record<KeySlot, string>>; provider?: ProviderConfig; allowed?: boolean; client?: Partial<LlmClient>; fetch?: typeof fetch } = {}) {
  const keys = over.keys ?? {};
  const canReach = vi.fn(async (_pattern: string) => over.allowed ?? true);
  const made = vi.fn(async (_provider: ProviderConfig, _key: string | null) => ({ provider: 'compatible', fastModel: 'gpt-x', smartModel: 'gpt-y', prices: {}, ...over.client }) as LlmClient);
  const getKey = vi.fn(async (slot: KeySlot, _endpoint: string) => keys[slot] ?? null);
  const o = createProviderOps({
    extensionOrigin: ORIGIN,
    getKey,
    getProvider: async () => over.provider ?? DEFAULT_PROVIDER,
    canReach,
    makeClient: made,
    getDialect: async () => 'en-US',
    now: () => clock,
    fetch: over.fetch ?? endpoint().fetch,
  });
  return { ...o, canReach, made, getKey };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('listModels', () => {
  it('lists the endpoint\'s model ids, sorted, with the slot\'s key', async () => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:openai': 'sk-open' }, fetch });
    expect(await o.listModels({ slot: 'compatible:openai', baseURL: PRESETS.openai.baseURL }, OPTIONS)).toEqual({ ok: true, models: ['a-model', 'b-model'] });
    expect(sent.map((s) => s.url)).toEqual(['https://api.openai.com/v1/models']);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-open');
    expect(o.getKey).toHaveBeenCalledWith('compatible:openai', PRESETS.openai.baseURL);
  });

  it('asks the key store for the key of the address it will call (a Custom key is given only for its own)', async () => {
    const o = ops({ keys: { 'compatible:custom': 'sk-c' } });
    await o.listModels({ slot: 'compatible:custom', baseURL: ' https://llm.example.org/v1 ' }, OPTIONS);
    expect(o.getKey.mock.calls).toEqual([['compatible:custom', 'https://llm.example.org/v1']]);
  });

  it('carries a key typed on the page in place of any stored one, and stores nothing', async () => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:custom': 'sk-stored' }, fetch });
    expect((await o.listModels({ slot: 'compatible:custom', baseURL: 'https://b.example/v1', key: '  sk-typed  ' }, OPTIONS)).ok).toBe(true);
    expect(sent.map((s) => [s.url, s.headers.get('authorization')])).toEqual([['https://b.example/v1/models', 'Bearer sk-typed']]);
    expect(o.getKey).not.toHaveBeenCalled();
  });

  it('never sends a typed key to a local server, and treats a blank or odd one as none', async () => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:openai': 'sk-open' }, fetch });
    await o.listModels({ slot: 'compatible:ollama', baseURL: '', key: 'typed' }, OPTIONS);
    await o.listModels({ slot: 'compatible:openai', baseURL: '', key: '   ' }, OPTIONS);
    await o.listModels({ slot: 'compatible:openai', baseURL: '', key: 42 as unknown as string }, OPTIONS);
    expect(sent.map((s) => s.headers.get('authorization'))).toEqual([null, 'Bearer sk-open', 'Bearer sk-open']);
  });

  it('asks a fixed preset\'s own address, never the one in the message', async () => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:openai': 'sk-open' }, fetch });
    await o.listModels({ slot: 'compatible:openai', baseURL: 'https://evil.example/v1' }, OPTIONS);
    expect(sent.map((s) => s.url)).toEqual(['https://api.openai.com/v1/models']);
    expect(o.canReach.mock.calls).toEqual([['https://api.openai.com/*']]);
  });

  it('asks a custom endpoint at the address given, with a trailing slash dropped', async () => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:custom': 'sk-c' }, fetch });
    expect((await o.listModels({ slot: 'compatible:custom', baseURL: ' http://127.0.0.1:4011/v1/ ' }, OPTIONS)).ok).toBe(true);
    expect(sent.map((s) => s.url)).toEqual(['http://127.0.0.1:4011/v1/models']);
    expect(o.canReach.mock.calls).toEqual([['http://127.0.0.1:4011/*']]);
  });

  it('sends a local server no key, even with one in its slot', async () => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:ollama': 'stray' }, fetch });
    expect((await o.listModels({ slot: 'compatible:ollama', baseURL: '' }, OPTIONS)).ok).toBe(true);
    expect(sent[0]!.url).toBe('http://localhost:11434/v1/models');
    expect(sent[0]!.headers.has('authorization')).toBe(false);
  });

  it('is key_missing for a keyed preset with no saved key, and sends nothing', async () => {
    const { sent, fetch } = endpoint();
    expect(await ops({ fetch }).listModels({ slot: 'compatible:gemini', baseURL: '' }, OPTIONS)).toEqual({ ok: false, status: 'key_missing' });
    expect(sent).toEqual([]);
  });

  it('is endpoint_blocked when Chrome has not granted the origin, and sends nothing', async () => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:openai': 'sk-open' }, allowed: false, fetch });
    expect(await o.listModels({ slot: 'compatible:openai', baseURL: '' }, OPTIONS)).toEqual({ ok: false, status: 'endpoint_blocked' });
    expect(sent).toEqual([]);
  });

  it.each([
    ['a web page', 'https://example.com/'],
    ['no sender URL', undefined],
  ])('refuses %s, before any key or request', async (_, senderUrl) => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:openai': 'sk-open' }, fetch });
    expect(await o.listModels({ slot: 'compatible:openai', baseURL: '' }, senderUrl)).toEqual({ ok: false, status: 'bad_response' });
    expect(o.getKey).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it.each([
    ['an unknown slot', { slot: 'compatible:other', baseURL: 'https://api.example.com/v1' }],
    ['the Claude slot', { slot: 'anthropic', baseURL: 'https://api.example.com/v1' }],
    ['a custom address that is not https', { slot: 'compatible:custom', baseURL: 'http://example.com/v1' }],
  ])('is bad_response for %s, with no request', async (_, p) => {
    const { sent, fetch } = endpoint();
    const o = ops({ keys: { 'compatible:custom': 'sk-c' }, fetch });
    expect(await o.listModels(p as never, OPTIONS)).toEqual({ ok: false, status: 'bad_response' });
    expect(sent).toEqual([]);
  });

  it.each([
    ['a rejected key', () => Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 }), 'key_invalid'],
    ['a server error', () => new Response('oops', { status: 503 }), 'overloaded'],
    ['an answer with no list', () => Response.json({ object: 'list' }), 'bad_response'],
    ['an answer that is not JSON', () => new Response('<html>', { status: 200 }), 'bad_response'],
    ['the network failing', () => Promise.reject(new TypeError('Failed to fetch')), 'offline'],
  ])('maps %s to a status', async (_, reply, status) => {
    const o = ops({ keys: { 'compatible:openai': 'sk-open' }, fetch: endpoint(reply as () => Response).fetch });
    expect(await o.listModels({ slot: 'compatible:openai', baseURL: '' }, OPTIONS)).toEqual({ ok: false, status });
  });

  it('keeps only string ids, once each', async () => {
    const fetch = endpoint(() => Response.json({ data: [{ id: 'm2' }, { id: 7 }, {}, { id: 'm1' }, { id: 'm2' }] })).fetch;
    expect(await ops({ keys: { 'compatible:openai': 'k' }, fetch }).listModels({ slot: 'compatible:openai', baseURL: '' }, OPTIONS)).toEqual({ ok: true, models: ['m1', 'm2'] });
  });
});

describe('testKey', () => {
  const liveCheck = vi.fn(async () => ({ output: { results: [] }, usage: USAGE, truncated: false, droppedInvalid: 0, model: 'gpt-x' }));

  it('answers with the usage and the model that answered, and bills it at the writer\'s prices', async () => {
    const o = ops({ provider: compat(), keys: { 'compatible:openai': 'sk-open' }, client: { liveCheck, prices: { 'gpt-x': { input: 0.5, output: 2 } } } });
    expect(await o.testKey(OPTIONS)).toEqual({ ok: true, status: 'ok', usage: USAGE, model: 'gpt-x' });
    expect(o.made).toHaveBeenCalledWith(compat(), 'sk-open');
    expect(o.getKey).toHaveBeenCalledWith('compatible:openai', PRESETS.openai.baseURL);
    expect(await getMonthSpend(clock)).toBeCloseTo(0.5);
  });

  it('refuses a sender that is not an EngLint page, before a key or a request', async () => {
    const o = ops({ provider: compat(), keys: { 'compatible:openai': 'sk-open' }, client: { liveCheck } });
    expect(await o.testKey('https://example.com/')).toEqual({ ok: false, status: 'bad_response' });
    expect(o.getKey).not.toHaveBeenCalled();
    expect(o.made).not.toHaveBeenCalled();
  });

  it('is key_missing, then endpoint_blocked, before any request', async () => {
    expect(await ops({ provider: compat() }).testKey(OPTIONS)).toEqual({ ok: false, status: 'key_missing' });
    const blocked = ops({ provider: compat(), keys: { 'compatible:openai': 'sk-open' }, allowed: false });
    expect(await blocked.testKey(OPTIONS)).toEqual({ ok: false, status: 'endpoint_blocked' });
    expect(blocked.made).not.toHaveBeenCalled();
  });

  it('says which model the endpoint doesn\'t know (a 404)', async () => {
    const notFound = new APICallError({
      message: 'The model `gpt-x` does not exist',
      url: 'https://api.openai.com/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 404,
      isRetryable: false,
    });
    const o = ops({ provider: compat(), keys: { 'compatible:openai': 'sk-open' }, client: { liveCheck: async () => Promise.reject(notFound) } });
    expect(await o.testKey(OPTIONS)).toEqual({ ok: false, status: 'bad_response', model: 'gpt-x', modelNotFound: true });
  });

  it('bills an answer that fails to parse, at the writer\'s prices', async () => {
    const unparsed = new LiveCheckParseError('no match', { billed: { usage: USAGE, model: 'gpt-x' } });
    const o = ops({ provider: compat(), keys: { 'compatible:openai': 'sk-open' }, client: { liveCheck: async () => Promise.reject(unparsed), prices: { 'gpt-x': { input: 0.5, output: 2 } } } });
    expect(await o.testKey(OPTIONS)).toEqual({ ok: false, status: 'bad_response' });
    expect(await getMonthSpend(clock)).toBeCloseTo(0.5);
  });

  it('maps any other failure through the status rules', async () => {
    const o = ops({ provider: compat(), keys: { 'compatible:openai': 'sk-open' }, client: { liveCheck: async () => Promise.reject(new TypeError('Failed to fetch')) } });
    expect(await o.testKey(OPTIONS)).toEqual({ ok: false, status: 'offline' });
  });

  it('tests Claude with its own key, as before', async () => {
    const claude = vi.fn(async () => ({ output: { results: [] }, usage: USAGE, truncated: false, droppedInvalid: 0, model: 'claude-haiku-5-5' }));
    const o = ops({ keys: { anthropic: 'sk-ant' }, client: { provider: 'anthropic', liveCheck: claude, prices: undefined } });
    expect(await o.testKey(OPTIONS)).toEqual({ ok: true, status: 'ok', usage: USAGE, model: 'claude-haiku-5-5' });
    expect(claude).toHaveBeenCalledWith({ mode: 'standard', dialect: 'en-US', paragraphs: [{ id: 'p0', text: 'This are a test.' }] });
    expect(o.canReach).not.toHaveBeenCalled();
  });
});
