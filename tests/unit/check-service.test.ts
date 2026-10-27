import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getCached, cacheKey, addDismissal } from '../../src/background/cache';
import { LIVE_CHECK_MODEL, LiveCheckParseError, type runLiveCheck } from '../../src/background/claude';
import { anthropicClient, type LlmClient } from '../../src/background/llm';
import { compatibleClient } from '../../src/background/compatible';
import { checkFromSender, createCheckService } from '../../src/background/check-service';
import { statusFromError } from '../../src/background/errors';
import { getMonthSpend } from '../../src/background/usage';
import { costFromUsage } from '../../src/core/cost';
import { activeSlot } from '../../src/core/provider';
import type { RawIssue } from '../../src/core/types';
import { clearStoredKey, getStoredKey, setStoredKey } from '../../src/background/key-store';
import { learnedKey } from '../../src/background/prompts/live-check';
import { capUsdItem, dictionaryItem, disabledSitesItem, rulesItem, styleProfileItem } from '../../src/shared/settings';
import { buildLiveCheckSystem } from '../../src/background/prompts/live-check';

import { defaultFamilies } from '../../src/core/modes';
import { suggestionFamiliesByModeItem } from '../../src/shared/settings';
const DEF = { essay: defaultFamilies('essay'), standard: defaultFamilies('standard'), casual: defaultFamilies('casual') };
const USAGE = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null };
const issue = (original: string): RawIssue => ({
  original, replacement: 'x', before: '', category: 'grammar', severity: 'error', kind: 'k', reason: 'r',
});

type Run = typeof runLiveCheck;
type Req = Parameters<Run>[1];

/** Fake that returns one issue (the paragraph's own text) per paragraph. */
const okRun = () =>
  vi.fn<Run>(async (_c, req) => ({
    output: { results: req.paragraphs.map((p) => ({ paragraph_id: p.id, issues: [issue(p.text)] })) },
    usage: USAGE,
    truncated: false, droppedInvalid: 0,
  }));

/** A client whose live check is `run`, called with the stand-in SDK client the services used to hold. */
const fakeClient = (key: string | null, run: Run) =>
  ({ liveCheck: async (req: Req) => ({ ...(await run({ key } as never, req)), model: LIVE_CHECK_MODEL }) }) as unknown as LlmClient;

let clock = new Date(2026, 9, 18, 12, 0, 0);
function setup(run: Run = okRun()) {
  const svc = createCheckService({
    getApiKey: (p) => getStoredKey(activeSlot(p)!), // the background's key store
    makeClient: (_provider, key) => fakeClient(key, run),
    now: () => clock,
  });
  return { svc, run: run as ReturnType<typeof okRun> };
}
const paras = (n: number, len = 400, prefix = 'p') =>
  Array.from({ length: n }, (_, i) => ({ hash: `${prefix}${i}`, text: `${i}`.padEnd(len, 'x') }));
const req = (paragraphs: { hash: string; text: string }[], host = 'example.com') =>
  ({ host, mode: 'standard' as const, paragraphs });
const apiErr = (status: number) => new Anthropic.APIError(status, { error: { type: 'x' } }, 'boom', new Headers());
/** An API error with the real body shape: `{ type: 'error', error: { type, message } }`. */
const apiErrWith = (status: number, message: string, type = 'invalid_request_error') =>
  new Anthropic.APIError(status, { type: 'error', error: { type, message } }, undefined, new Headers());
const NO_CREDIT =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

let warn: MockInstance<typeof console.warn>;
beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the service logs schema failures and 404s
  fakeBrowser.reset();
  indexedDB.deleteDatabase('englint');
  clock = new Date(2026, 9, 18, 12, 0, 0);
  await setStoredKey('anthropic', 'sk-test');
});

afterEach(() => warn.mockRestore());

describe('check service', () => {
  it('returns results by hash and caches them', async () => {
    const { svc, run } = setup();
    const r = await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(r.status).toBe('ok');
    expect(r.results.h1).toEqual([issue('hello')]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1].paragraphs).toEqual([{ id: 'p0', text: 'hello' }]);
    expect((await getCached([cacheKey('h1', 'standard', 'en-US', '')])).size).toBe(1);
  });
  it('passes the dictionary, and no rules, to the request and keys the cache by the dictionary', async () => {
    await dictionaryItem.setValue(['lyon']);
    await rulesItem.setValue([{ mode: 'standard', kind: 'passive_voice' }]);
    const { svc, run } = setup();
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(run.mock.calls[0]![1].learned).toEqual({ dictionary: ['lyon'] });
    const userHash = learnedKey({ dictionary: ['lyon'] });
    expect(userHash).not.toBe('');
    expect((await getCached([cacheKey('h1', 'standard', 'en-US', userHash)])).size).toBe(1);
    expect((await getCached([cacheKey('h1', 'standard', 'en-US', '')])).size).toBe(0);
  });
  it('a stored style profile reaches neither the request nor the live-check prompt, nor its cache key', async () => {
    await styleProfileItem.setValue({ text: 'Short, plain sentences.', updatedAt: 1 });
    const { svc, run } = setup();
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(JSON.stringify(run.mock.calls[0]![1])).not.toContain('Short, plain');
    expect(JSON.stringify(buildLiveCheckSystem('standard', 'en-US', run.mock.calls[0]![1].learned))).not.toMatch(/style_profile|How this writer writes/);
    expect((await getCached([cacheKey('h1', 'standard', 'en-US', '')])).size).toBe(1);
  });
  it('a changed dictionary misses the cache and asks again; a changed rule list does not', async () => {
    const { svc, run } = setup();
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(run).toHaveBeenCalledTimes(1);
    await dictionaryItem.setValue(['lyon']);
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(run).toHaveBeenCalledTimes(2);
    await rulesItem.setValue([{ mode: 'standard', kind: 'passive_voice' }, { mode: 'essay', kind: 'passive_voice' }]);
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('a Standard or Essay request with stored rules sends no rule text, in the system or after the paragraphs', async () => {
    await dictionaryItem.setValue(['lyon']);
    await rulesItem.setValue([{ mode: 'standard', kind: 'wordy_phrase' }, { mode: 'essay', kind: 'long_sentence' }]);
    const sent: { system: { text: string }[]; messages: { content: string }[] }[] = [];
    const create = vi.fn(async (params: (typeof sent)[number]) => {
      sent.push(params);
      return { content: [{ type: 'text', text: JSON.stringify({ results: [{ paragraph_id: 'p0', issues: [] }] }) }], stop_reason: 'end_turn', usage: USAGE };
    });
    const svc = createCheckService({ getApiKey: (p) => getStoredKey(activeSlot(p)!), makeClient: () => anthropicClient({ messages: { create } } as unknown as Anthropic), now: () => clock });
    for (const mode of ['standard', 'essay'] as const) await svc.check({ host: 'example.com', mode, paragraphs: [{ hash: `h-${mode}`, text: 'hello' }] });
    expect(sent).toHaveLength(2);
    for (const { system, messages } of sent) {
      const writer = system[2]!.text;
      const after = messages[0]!.content.split('</paragraphs>')[1]!;
      expect(writer).toContain('"lyon"');
      expect(after).toContain('"lyon"');
      for (const t of [writer, after]) expect(t).not.toMatch(/wordy_phrase|long_sentence/);
      expect(JSON.stringify(system) + messages[0]!.content).not.toMatch(/stopped|turned off/i);
    }
  });
  it('cached paragraphs skip the API', async () => {
    const { svc, run } = setup();
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    run.mockClear();
    const r = await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(run).not.toHaveBeenCalled();
    expect(r.results.h1).toEqual([issue('hello')]);
  });
  it('batching 30x400-char paragraphs -> 3 calls of 12, 12, 6', async () => {
    const { svc, run } = setup();
    const r = await svc.check(req(paras(30)));
    expect(run.mock.calls.map((c) => c[1].paragraphs.length)).toEqual([12, 12, 6]);
    expect(Object.keys(r.results)).toHaveLength(30);
  });
  it('batches stay within 6,000 characters', async () => {
    const { svc, run } = setup();
    await svc.check(req(paras(10, 2000)));
    expect(run.mock.calls.map((c) => c[1].paragraphs.length)).toEqual([3, 3, 3, 1]);
  });
  it('7,000-char paragraph goes alone', async () => {
    const { svc, run } = setup();
    await svc.check(req([...paras(2, 100, 'a'), { hash: 'big', text: 'y'.repeat(7000) }, ...paras(2, 100, 'b')]));
    expect(run.mock.calls.map((c) => c[1].paragraphs.length)).toEqual([2, 1, 2]);
  });
  it('truncated batch splits and retries', async () => {
    const run = vi.fn<Run>(async (_c, r: Req) => {
      if (r.paragraphs.length > 2) return { output: { results: [] }, usage: USAGE, truncated: true, droppedInvalid: 0 };
      return {
        output: { results: r.paragraphs.map((p) => ({ paragraph_id: p.id, issues: [issue(p.text)] })) },
        usage: USAGE, truncated: false, droppedInvalid: 0,
      };
    });
    const { svc } = setup(run);
    const r = await svc.check(req(paras(4)));
    expect(run.mock.calls.map((c) => c[1].paragraphs.length)).toEqual([4, 2, 2]);
    expect(r.status).toBe('ok');
    expect(Object.keys(r.results)).toHaveLength(4);
  });
  it('truncated single paragraph -> bad_response, nothing cached', async () => {
    const run = vi.fn<Run>(async () => ({ output: { results: [] }, usage: USAGE, truncated: true, droppedInvalid: 0 }));
    const { svc } = setup(run);
    const r = await svc.check(req([{ hash: 'h1', text: 'hi' }]));
    expect(r.status).toBe('bad_response');
    expect(r.results).toEqual({});
    expect(run).toHaveBeenCalledTimes(1);
    expect((await getCached([cacheKey('h1', 'standard', 'en-US', '')])).size).toBe(0);
  });
  it('a half that is truncated again is not split further', async () => {
    const run = vi.fn<Run>(async () => ({ output: { results: [] }, usage: USAGE, truncated: true, droppedInvalid: 0 }));
    const { svc } = setup(run);
    const r = await svc.check(req(paras(4)));
    expect(run).toHaveBeenCalledTimes(3);
    expect(r.status).toBe('bad_response');
  });
  it('missing ids cache as [], duplicate ids concatenate, unknown ids ignored', async () => {
    const run = vi.fn<Run>(async () => ({
      output: {
        results: [
          { paragraph_id: 'p0', issues: [issue('a')] },
          { paragraph_id: 'p0', issues: [issue('b')] },
          { paragraph_id: 'p9', issues: [issue('zzz')] },
        ],
      },
      usage: USAGE, truncated: false, droppedInvalid: 0,
    }));
    const { svc } = setup(run);
    const r = await svc.check(req([{ hash: 'h0', text: 'one' }, { hash: 'h1', text: 'two' }]));
    expect(r.results.h0).toEqual([issue('a'), issue('b')]);
    expect(r.results.h1).toEqual([]);
    expect(Object.keys(r.results).sort()).toEqual(['h0', 'h1']);
    const c = await getCached([cacheKey('h1', 'standard', 'en-US', '')]);
    expect(c.get(cacheKey('h1', 'standard', 'en-US', ''))).toEqual([]);
  });
  it('passes mode and dialect, and no families', async () => {
    const { svc, run } = setup();
    await svc.check({ host: 'example.com', mode: 'casual', paragraphs: [{ hash: 'h', text: 't' }] });
    expect(run.mock.calls[0]![1]).toMatchObject({ mode: 'casual', dialect: 'en-US' });
    expect(run.mock.calls[0]![1]).not.toHaveProperty('families');
  });
  it('stored family toggles change neither the request nor the cache key', async () => {
    const fam = { clarity: false, engagement: true, delivery: false, generic: true };
    await suggestionFamiliesByModeItem.setValue({ ...DEF, standard: fam });
    const { svc, run } = setup();
    await svc.check(req([{ hash: 'h0', text: 'one' }]));
    expect(run.mock.calls[0]![1]).not.toHaveProperty('families');
    const c = await getCached([cacheKey('h0', 'standard', 'en-US', '')]);
    expect([...c.keys()]).toEqual([cacheKey('h0', 'standard', 'en-US', '')]);
    await suggestionFamiliesByModeItem.setValue(DEF);
    await svc.check(req([{ hash: 'h0', text: 'one' }]));
    expect(run).toHaveBeenCalledTimes(1); // served from the same cache entry
  });
  it('401 -> key_invalid then no calls until key changes', async () => {
    const run = vi.fn<Run>(async () => { throw apiErr(401); });
    const { svc } = setup(run);
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('key_invalid');
    expect(run).toHaveBeenCalledTimes(1);
    expect((await svc.check(req([{ hash: 'b', text: 'b' }]))).status).toBe('key_invalid');
    expect(run).toHaveBeenCalledTimes(1);
    await setStoredKey('anthropic', 'sk-other');
    await svc.check(req([{ hash: 'c', text: 'c' }]));
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('returning to a previously rejected key clears the latch in between', async () => {
    const run = vi.fn<Run>(async (_c, r) => {
      if (run.mock.calls.length === 1) throw apiErr(401);
      return { output: { results: r.paragraphs.map((p) => ({ paragraph_id: p.id, issues: [] })) }, usage: USAGE, truncated: false, droppedInvalid: 0 };
    });
    const { svc } = setup(run);
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('key_invalid');
    await setStoredKey('anthropic', 'sk-other');
    expect((await svc.check(req([{ hash: 'b', text: 'b' }]))).status).toBe('ok');
    await setStoredKey('anthropic', 'sk-test');
    expect((await svc.check(req([{ hash: 'c', text: 'c' }]))).status).toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('403 -> key_invalid', async () => {
    const { svc } = setup(vi.fn<Run>(async () => { throw apiErr(403); }));
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('key_invalid');
  });
  it('429 -> rate_limited; calls within 30 s return rate_limited without calling', async () => {
    const run = vi.fn<Run>(async () => { throw apiErr(429); });
    const { svc } = setup(run);
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('rate_limited');
    clock = new Date(clock.getTime() + 29_000);
    expect((await svc.check(req([{ hash: 'b', text: 'b' }]))).status).toBe('rate_limited');
    expect(run).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + 2_000);
    await svc.check(req([{ hash: 'c', text: 'c' }]));
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('paused check still returns cached results', async () => {
    const run = okRun();
    const { svc } = setup(run);
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    run.mockImplementation(async () => { throw apiErr(529); });
    expect((await svc.check(req([{ hash: 'n', text: 'new' }]))).status).toBe('overloaded');
    const r = await svc.check(req([{ hash: 'h1', text: 'hello' }, { hash: 'n', text: 'new' }]));
    expect(r.status).toBe('overloaded');
    expect(r.results.h1).toEqual([issue('hello')]);
    expect(r.results.n).toBeUndefined();
  });
  it('529 and other 5xx -> overloaded', async () => {
    for (const s of [529, 500, 503]) {
      const { svc } = setup(vi.fn<Run>(async () => { throw apiErr(s); }));
      expect((await svc.check(req([{ hash: 'a' + s, text: 'a' }]))).status).toBe('overloaded');
    }
  });
  it('offline -> offline, nothing cached', async () => {
    const run = vi.fn<Run>(async () => { throw new Anthropic.APIConnectionError({}); });
    const { svc } = setup(run);
    const r = await svc.check(req([{ hash: 'a', text: 'a' }]));
    expect(r.status).toBe('offline');
    expect((await getCached([cacheKey('a', 'standard', 'en-US', '')])).size).toBe(0);
    await svc.check(req([{ hash: 'a', text: 'a' }]));
    expect(run).toHaveBeenCalledTimes(2); // offline does not pause
  });
  it('parse error -> bad_response; other batches still succeed', async () => {
    let n = 0;
    const run = vi.fn<Run>(async (_c, r) => {
      if (n++ === 0) throw new LiveCheckParseError('bad');
      return { output: { results: r.paragraphs.map((p) => ({ paragraph_id: p.id, issues: [] })) }, usage: USAGE, truncated: false, droppedInvalid: 0 };
    });
    const { svc } = setup(run);
    const r = await svc.check(req(paras(20)));
    expect(r.status).toBe('bad_response');
    expect(Object.keys(r.results)).toHaveLength(8);
  });
  it('a schema failure is logged with counts and the error class, never the text', async () => {
    const run = vi.fn<Run>(async () => {
      throw new LiveCheckParseError('bad', { cause: new SyntaxError('Unexpected token in SECRET-TEXT') });
    });
    const { svc } = setup(run);
    await svc.check(req([{ hash: 'a', text: 'SECRET-TEXT one' }, { hash: 'b', text: 'two' }]));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('LiveCheckParseError');
    expect(logged).toContain('SyntaxError');
    expect(warn.mock.calls[0]).toContainEqual(expect.objectContaining({ paragraphs: 2 }));
    expect(logged).not.toContain('SECRET');
  });
  it('issues dropped by the schema are logged as a count only', async () => {
    const run = vi.fn<Run>(async (_c, r) => ({
      output: { results: r.paragraphs.map((p) => ({ paragraph_id: p.id, issues: [] })) },
      usage: USAGE, truncated: false, droppedInvalid: 2,
    }));
    const { svc } = setup(run);
    expect((await svc.check(req([{ hash: 'a', text: 'SECRET-TEXT' }]))).status).toBe('ok');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContainEqual(expect.objectContaining({ droppedIssues: 2 }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
  it('a clean response logs nothing', async () => {
    const { svc } = setup();
    await svc.check(req([{ hash: 'a', text: 'a' }]));
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([
    ['throws', () => { throw new Error('provider not available'); }],
    ['rejects', async () => { throw new Error('provider not available'); }],
  ] as const)('a client that cannot be built (makeClient %s) is a status, not a throw', async (_, makeClient) => {
    const svc = createCheckService({ getApiKey: (p) => getStoredKey(activeSlot(p)!), makeClient, now: () => clock });
    const r = await svc.check(req([{ hash: 'a', text: 'a' }]));
    expect(r.status).toBe('bad_response');
    expect(r.results).toEqual({});
  });
  it('400 with a credit-balance message -> out_of_credit', async () => {
    const run = vi.fn<Run>(async () => { throw apiErrWith(400, NO_CREDIT); });
    const { svc } = setup(run);
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('out_of_credit');
  });
  it('classifies billing wording case-insensitively; other 400s stay bad_response', () => {
    expect(statusFromError(apiErrWith(400, NO_CREDIT))).toBe('out_of_credit');
    expect(statusFromError(apiErrWith(400, 'Check BILLING settings'))).toBe('out_of_credit');
    expect(statusFromError(apiErrWith(400, 'You must Purchase Credits first'))).toBe('out_of_credit');
    expect(statusFromError(apiErrWith(400, 'messages: field required'))).toBe('bad_response');
    expect(statusFromError(apiErr(400))).toBe('bad_response');
    // Only a 400 means the account: a 5xx that mentions billing is still a busy server.
    expect(statusFromError(apiErrWith(503, 'billing service unavailable', 'api_error'))).toBe('overloaded');
  });
  it('classifies an error event inside a stream (no HTTP status) by its type', () => {
    const event = (type: string) =>
      new Anthropic.APIError(undefined, { type: 'error', error: { type, message: 'm' } }, undefined, new Headers(), type as ConstructorParameters<typeof Anthropic.APIError>[4]);
    expect(statusFromError(event('overloaded_error'))).toBe('overloaded');
    expect(statusFromError(event('api_error'))).toBe('overloaded');
    expect(statusFromError(event('rate_limit_error'))).toBe('rate_limited');
    expect(statusFromError(event('authentication_error'))).toBe('key_invalid');
    expect(statusFromError(event('invalid_request_error'))).toBe('bad_response');
  });
  it('a stream the network cut off is offline; other stream failures stay bad_response', () => {
    const cut = new Anthropic.AnthropicError('network error');
    (cut as { cause?: unknown }).cause = new TypeError('network error');
    expect(statusFromError(cut)).toBe('offline');
    expect(statusFromError(new Anthropic.AnthropicError('stream ended without producing a Message with role=assistant'))).toBe('bad_response');
  });
  it('out_of_credit outranks a parse error in the same request and stops the rest', async () => {
    let n = 0;
    const run = vi.fn<Run>(async () => {
      if (n++ === 0) throw new LiveCheckParseError('bad');
      throw apiErrWith(400, NO_CREDIT);
    });
    const { svc } = setup(run);
    expect((await svc.check(req(paras(30)))).status).toBe('out_of_credit');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('404 (a model id the API does not know) -> bad_response, warning with the model id', async () => {
    const run = vi.fn<Run>(async () => { throw apiErrWith(404, 'model: claude-haiku-5-5', 'not_found_error'); });
    const { svc } = setup(run);
    expect((await svc.check(req([{ hash: 'a', text: 'SECRET-TEXT' }]))).status).toBe('bad_response');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('claude-haiku-5-5');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
  it('unknown error -> bad_response', async () => {
    const { svc } = setup(vi.fn<Run>(async () => { throw new Error('weird'); }));
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('bad_response');
  });
  it('worst status wins; successful batch results are kept', async () => {
    let n = 0;
    const run = vi.fn<Run>(async (_c, r) => {
      if (n++ === 0) return { output: { results: r.paragraphs.map((p) => ({ paragraph_id: p.id, issues: [] })) }, usage: USAGE, truncated: false, droppedInvalid: 0 };
      throw apiErr(429);
    });
    const { svc } = setup(run);
    const r = await svc.check(req(paras(30)));
    expect(r.status).toBe('rate_limited');
    expect(Object.keys(r.results)).toHaveLength(12);
    expect(run).toHaveBeenCalledTimes(2); // stops after the pause-worthy error
  });
  it('over cap -> paused_cap, cached only', async () => {
    const { svc, run } = setup();
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    run.mockClear();
    await capUsdItem.setValue(0.0001);
    const r = await svc.check(req([{ hash: 'h1', text: 'hello' }, { hash: 'h2', text: 'new' }]));
    expect(r.status).toBe('paused_cap');
    expect(r.results.h1).toEqual([issue('hello')]);
    expect(r.results.h2).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
  it('over cap with everything cached -> paused_cap', async () => {
    const { svc } = setup();
    await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    await capUsdItem.setValue(0.0001);
    const r = await svc.check(req([{ hash: 'h1', text: 'hello' }]));
    expect(r.status).toBe('paused_cap');
    expect(r.results.h1).toEqual([issue('hello')]);
  });
  it('worst status wins regardless of batch order', async () => {
    let n = 0;
    const run = vi.fn<Run>(async () => {
      if (n++ === 0) throw new LiveCheckParseError('bad');
      throw apiErr(429);
    });
    const { svc } = setup(run);
    expect((await svc.check(req(paras(30)))).status).toBe('rate_limited');
  });
  it('stops mid-request when a batch pushes spend over the cap', async () => {
    await capUsdItem.setValue(costFromUsage('claude-haiku-5-5', USAGE) * 1.5);
    const { svc, run } = setup();
    const r = await svc.check(req(paras(30)));
    expect(run).toHaveBeenCalledTimes(2);
    expect(r.status).toBe('paused_cap');
  });
  it('records spend from usage', async () => {
    const { svc } = setup();
    await svc.check(req(paras(30)));
    expect(await getMonthSpend(clock)).toBeCloseTo(3 * costFromUsage('claude-haiku-5-5', USAGE));
  });
  it('a Claude answer that fails to parse records nothing, as before', async () => {
    const run = vi.fn<Run>(async () => { throw new LiveCheckParseError('bad'); });
    const { svc } = setup(run);
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('bad_response');
    expect(await getMonthSpend(clock)).toBe(0);
  });
  it('records spend for truncated calls too', async () => {
    const run = vi.fn<Run>(async () => ({ output: { results: [] }, usage: USAGE, truncated: true, droppedInvalid: 0 }));
    const { svc } = setup(run);
    await svc.check(req([{ hash: 'a', text: 'a' }]));
    expect(await getMonthSpend(clock)).toBeCloseTo(costFromUsage('claude-haiku-5-5', USAGE));
  });
  it('disabled site -> off_site, no API call', async () => {
    await disabledSitesItem.setValue(['example.com']);
    const { svc, run } = setup();
    const r = await svc.check(req([{ hash: 'a', text: 'a' }], 'Example.com'));
    expect(r.status).toBe('off_site');
    expect(run).not.toHaveBeenCalled();
  });
  it('a frame is refused when its top-level host is switched off, whatever its own host', async () => {
    await disabledSitesItem.setValue(['example.com']);
    const { svc, run } = setup();
    const framed = req([{ hash: 'a', text: 'a' }], 'widget.vendor.com');
    expect((await svc.check(framed, { topHost: 'example.com' })).status).toBe('off_site');
    expect(run).not.toHaveBeenCalled();
    expect((await svc.check(framed, { topHost: 'other.com' })).status).toBe('ok');
    expect((await svc.check(req([{ hash: 'b', text: 'b' }], 'widget.vendor.com'), { topHost: null })).status).toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    await disabledSitesItem.setValue(['widget.vendor.com']);
    expect((await svc.check(req([{ hash: 'c', text: 'c' }], 'widget.vendor.com'), { topHost: 'example.com' })).status).toBe(
      'off_site',
    );
  });
  it('the check message takes the top-level host from the sender tab, never from the request', async () => {
    await disabledSitesItem.setValue(['example.com']);
    const { svc, run } = setup();
    const framed = req([{ hash: 'a', text: 'a' }], 'widget.vendor.com');
    const off = await checkFromSender(svc, framed, { tab: { url: 'https://example.com/page?x=1' } });
    expect(off.status).toBe('off_site');
    expect(run).not.toHaveBeenCalled();
    expect((await checkFromSender(svc, framed, { tab: { url: 'https://other.com/' } })).status).toBe('ok');
    expect((await checkFromSender(svc, framed, {})).status).toBe('ok'); // no tab: only the frame's own host
  });
  it('check-service treats only the exact host as disabled', async () => {
    await disabledSitesItem.setValue(['example.com']);
    const { svc, run } = setup();
    expect((await svc.check(req([{ hash: 'a', text: 'a' }], 'mail.example.com'))).status).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    await disabledSitesItem.setValue(['mail.example.com']);
    expect((await svc.check(req([{ hash: 'b', text: 'b' }], 'example.com'))).status).toBe('ok');
  });
  it('no key -> key_missing', async () => {
    await clearStoredKey('anthropic');
    const { svc, run } = setup();
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('key_missing');
    expect(run).not.toHaveBeenCalled();
  });
  it('returns dismissals for requested hashes', async () => {
    await addDismissal('h1|teh|spelling');
    await addDismissal('zz|teh|spelling');
    const { svc } = setup();
    const r = await svc.check(req([{ hash: 'h1', text: 'a' }]));
    expect(r.dismissed).toEqual(['h1|teh|spelling']);
  });
  it('duplicate hashes in one request are sent once', async () => {
    const { svc, run } = setup();
    await svc.check(req([{ hash: 'h', text: 'a' }, { hash: 'h', text: 'a' }]));
    expect(run.mock.calls[0]![1].paragraphs).toHaveLength(1);
  });
});

describe('check service on an OpenAI-compatible endpoint without JSON schema', () => {
  const OLLAMA = { preset: 'ollama' as const, baseURL: 'http://localhost:11434/v1', fastModel: 'llama', smartModel: 'llama', structuredOutputs: false, prices: {} };
  /** An endpoint that answers every request with `content` and `finish`, counting the requests. */
  function answering(content: string, finish = 'stop') {
    const calls = { n: 0 };
    const fetch = (async () => {
      calls.n++;
      const body = { id: 'c', model: 'llama', choices: [{ message: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = createCheckService({ getApiKey: (p) => getStoredKey(activeSlot(p)!), makeClient: () => compatibleClient(OLLAMA, null, { fetch }), now: () => clock });
    return { svc, calls };
  }

  it('a batch answered with prose around the JSON is bad_response, with nothing cached, and nothing thrown', async () => {
    const { svc, calls } = answering('Here you go: {"results": []}');
    const r = await svc.check(req([{ hash: 'a', text: 'a' }]));
    expect(r).toMatchObject({ status: 'bad_response', results: {} });
    expect(calls.n).toBe(1);
    expect((await getCached([cacheKey('a', 'standard', 'en-US', '')])).size).toBe(0);
  });

  it('a batch that fails to parse is billed at the writer\'s prices all the same', async () => {
    const fetch = (async () =>
      Response.json({ id: 'c', model: 'llama', choices: [{ message: { role: 'assistant', content: '{"paragraphs": []}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })) as unknown as typeof globalThis.fetch;
    const priced = { ...OLLAMA, prices: { llama: { input: 1000, output: 2000 } } };
    const svc = createCheckService({ getApiKey: (p) => getStoredKey(activeSlot(p)!), makeClient: () => compatibleClient(priced, null, { fetch }), now: () => clock });
    expect((await svc.check(req([{ hash: 'a', text: 'a' }]))).status).toBe('bad_response');
    expect(await getMonthSpend(clock)).toBeCloseTo((10 * 1000 + 5 * 2000) / 1_000_000);
  });

  it('a batch cut off at its limit is the truncation case: split once, then bad_response', async () => {
    const { svc, calls } = answering('', 'length');
    const r = await svc.check(req([{ hash: 'a', text: 'a' }, { hash: 'b', text: 'b' }]));
    expect(r.status).toBe('bad_response');
    expect(calls.n).toBe(3);
  });
});
