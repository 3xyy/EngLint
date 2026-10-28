// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveCheckParseError, type ToolCall } from '../../src/background/claude';
import { compatibleClient, logSdkWarnings } from '../../src/background/compatible';
import { statusFromError } from '../../src/background/errors';
import { buildLiveCheckSystem, buildLiveCheckUser } from '../../src/background/prompts/live-check';
import { PRESETS, type CompatibleConfig } from '../../src/core/provider';
import { LIVE_CHECK_JSON_SCHEMA } from '../../src/core/schema';

const GOOD = { results: [{ paragraph_id: 'p0', issues: [] }] };
const REQ = { mode: 'standard' as const, dialect: 'en-US' as const, paragraphs: [{ id: 'p0', text: 'Its a test.' }] };
/** OpenAI's usage shape: 120 input tokens, 20 of them read from the cache, and 30 output. */
const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } };
const MAPPED = { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 20 };
const CONFIG: CompatibleConfig = {
  preset: 'openai',
  baseURL: 'https://api.openai.com/v1',
  fastModel: 'fast-1',
  smartModel: 'smart-1',
  structuredOutputs: true,
  prices: {},
};
const OLLAMA: CompatibleConfig = { ...CONFIG, preset: 'ollama', baseURL: 'http://localhost:11434/v1', structuredOutputs: false };
const GROQ: CompatibleConfig = { ...CONFIG, preset: 'groq', baseURL: PRESETS.groq.baseURL, structuredOutputs: false };
const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
const TOOL = (kind: ToolCall['kind']): ToolCall => ({
  kind,
  system: [
    { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Standard mode.', cache_control: { type: 'ephemeral' } },
  ],
  user: 'Rewrite this.',
  schema: SCHEMA,
});
const CHAT = {
  system: [{ type: 'text' as const, text: 'You help.', cache_control: { type: 'ephemeral' as const } }],
  messages: [
    { role: 'user' as const, content: 'Hi' },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Hello.', cache_control: { type: 'ephemeral' as const } }] },
    { role: 'user' as const, content: 'Fix my intro.' },
  ],
};

/** One answer from the endpoint: its text (streamed in `chunks` when the request streams), finish reason and usage, or an HTTP error. */
interface Reply {
  text?: string;
  chunks?: string[];
  finish?: string;
  usage?: object | null;
  status?: number;
  error?: object;
  /** With `status`: a Retry-After header (seconds) in place of the default `retry-after-ms: 0`. */
  retryAfter?: string;
  /** Streamed: after the chunks, the body fails with this, or (with `stall`) never ends. */
  breakWith?: unknown;
  stall?: boolean;
  /** Sent whole: the response never arrives (until the request is aborted). */
  hang?: boolean;
}

interface Sent {
  url: string;
  headers: Headers;
  raw: string;
  body: Record<string, any>;
}

const enc = new TextEncoder();
const data = (o: object) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);

/** The SSE body an OpenAI-compatible endpoint streams: text deltas, the finish reason, the usage-only chunk, then [DONE]. */
function sseStream(r: Reply, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const pieces = (r.chunks ?? [r.text ?? '']).map((c) => data({ id: 'c1', model: 'm', choices: [{ delta: { content: c }, finish_reason: null }] }));
  const tail = [
    data({ id: 'c1', model: 'm', choices: [{ delta: {}, finish_reason: r.finish ?? 'stop' }] }),
    ...(r.usage === null ? [] : [data({ id: 'c1', model: 'm', choices: [], usage: r.usage ?? USAGE })]),
    enc.encode('data: [DONE]\n\n'),
  ];
  const queue = r.breakWith !== undefined || r.stall ? pieces : [...pieces, ...tail];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) return controller.enqueue(next);
      if (r.breakWith !== undefined) return controller.error(r.breakWith);
      if (r.stall) {
        return new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      controller.close();
    },
  });
}

/** A fake fetch for an OpenAI-compatible endpoint: records each request and answers with `reply` (by request number). */
function endpoint(reply: Reply | ((n: number) => Reply) = { text: JSON.stringify(GOOD) }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL, init: RequestInit) => {
    const raw = String(init.body);
    sent.push({ url: String(url), headers: new Headers(init.headers), raw, body: JSON.parse(raw) });
    const r = typeof reply === 'function' ? reply(sent.length) : reply;
    const signal = init.signal ?? undefined;
    if (r.hang) {
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    if (r.status) {
      return new Response(JSON.stringify(r.error ?? { error: { message: 'boom', type: 'server_error' } }), {
        status: r.status,
        headers: { 'content-type': 'application/json', ...(r.retryAfter ? { 'retry-after': r.retryAfter } : { 'retry-after-ms': '0' }) },
      });
    }
    if (sent.at(-1)!.body.stream === true) {
      return new Response(sseStream(r, signal), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({
      id: 'c1',
      created: 1,
      model: 'm',
      choices: [{ message: { role: 'assistant', content: r.text ?? '' }, finish_reason: r.finish ?? 'stop' }],
      usage: r.usage === null ? undefined : (r.usage ?? USAGE),
    });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const outcome = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  );

describe('compatibleClient', () => {
  it('names its provider and models, and has no web search', () => {
    const c = compatibleClient(CONFIG, 'sk-test', { fetch: endpoint().fetch });
    expect([c.provider, c.fastModel, c.smartModel, c.citations]).toEqual(['compatible', 'fast-1', 'smart-1', null]);
  });

  it('refuses an address that is neither https nor http on this computer, before sending anything', () => {
    const { sent, fetch } = endpoint();
    expect(() => compatibleClient({ ...CONFIG, preset: 'custom', baseURL: 'http://api.example.com/v1' }, 'sk-test', { fetch })).toThrow();
    expect(sent).toEqual([]);
  });
});

describe('compatibleClient live check', () => {
  it('gives the parsed output, the usage with cached input split out, and the fast model', async () => {
    const { sent, fetch } = endpoint();
    const out = await compatibleClient(CONFIG, 'sk-test', { fetch }).liveCheck(REQ);
    expect(out).toEqual({ output: GOOD, usage: MAPPED, truncated: false, droppedInvalid: 0, model: 'fast-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent[0]!.body.model).toBe('fast-1');
    expect(sent[0]!.body.messages).toEqual([
      { role: 'system', content: buildLiveCheckSystem('standard', 'en-US').map((b) => b.text).join('\n\n') },
      { role: 'user', content: buildLiveCheckUser(REQ.paragraphs) },
    ]);
  });

  it.each([
    ['prose around the JSON', `Here are the issues: ${JSON.stringify(GOOD)}`],
    ['invalid JSON', '{"results": [{"paragraph_id": "p0", "issues": [}'],
    ['JSON of the wrong shape', '{"issues": []}'],
    ['no text', ''],
  ])('throws LiveCheckParseError for %s', async (_, text) => {
    const { error } = await outcome(compatibleClient(OLLAMA, null, { fetch: endpoint({ text }).fetch }).liveCheck(REQ));
    expect(error).toBeInstanceOf(LiveCheckParseError);
    expect(statusFromError(error)).toBe('bad_response');
    // The answer was billed all the same: the error carries its usage and the model that gave it.
    expect((error as LiveCheckParseError).billed).toEqual({ usage: MAPPED, model: 'fast-1' });
  });

  it('a length finish is truncated, with its usage kept', async () => {
    const fetch = endpoint({ text: '{"results": [{"paragraph_id": "p0", "iss', finish: 'length' }).fetch;
    expect(await compatibleClient(CONFIG, 'sk-test', { fetch }).liveCheck(REQ)).toEqual({
      output: { results: [] },
      usage: MAPPED,
      truncated: true,
      droppedInvalid: 0,
      model: 'fast-1',
    });
  });

  it('a reasoning model that spends its whole budget thinking (a length finish with no text) is truncated, with its usage kept', async () => {
    const fetch = endpoint({ text: '', finish: 'length' }).fetch;
    const out = await compatibleClient(CONFIG, 'sk-test', { fetch }).liveCheck(REQ);
    expect(out).toMatchObject({ truncated: true, usage: MAPPED });
  });

  it('an answer without usage counts zero tokens', async () => {
    const fetch = endpoint({ text: JSON.stringify(GOOD), usage: null }).fetch;
    const out = await compatibleClient(CONFIG, 'sk-test', { fetch }).liveCheck(REQ);
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  });

  it.each([
    [401, 'key_invalid'],
    [429, 'rate_limited'],
    [503, 'overloaded'],
  ] as const)('an HTTP %i (after its one retry, when it may retry) maps to %s', async (status, expected) => {
    const { sent, fetch } = endpoint({ status });
    const { error } = await outcome(compatibleClient(CONFIG, 'sk-test', { fetch }).liveCheck(REQ));
    expect(statusFromError(error)).toBe(expected);
    expect(sent).toHaveLength(status === 401 ? 1 : 2);
  });

  it('a network failure maps to offline', async () => {
    const fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const { error } = await outcome(compatibleClient(CONFIG, 'sk-test', { fetch }).liveCheck(REQ));
    expect(statusFromError(error)).toBe('offline');
  });
});

describe('compatibleClient request shape', () => {
  it('sends the system blocks as one system message, with no cache_control, thinking or effort', async () => {
    const { sent, fetch } = endpoint({ text: '{"a":"b"}' });
    await compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('rewrite')).done;
    expect(sent[0]!.body.messages).toEqual([
      { role: 'system', content: 'Be brief.\n\nStandard mode.' },
      { role: 'user', content: 'Rewrite this.' },
    ]);
    for (const word of ['cache_control', 'thinking', 'effort', 'output_config']) expect(sent[0]!.raw).not.toContain(word);
  });

  it.each([
    ['tone', 4096],
    ['synonyms', 4096],
    ['rewrite', 4096],
    ['wordLimit', 8192],
    ['grader', 6144],
    ['deepCheck', 12_000],
  ] as const)('gives %s max_tokens %i (the kind its own room, never under 4096)', async (kind, expected) => {
    const { sent, fetch } = endpoint({ text: '{"a":"b"}' });
    await compatibleClient(GROQ, 'sk-test', { fetch }).startToolCall(TOOL(kind)).done;
    expect(sent[0]!.body.max_tokens).toBe(expected);
  });

  it('gives the live check max_tokens 8192 and chat 4096', async () => {
    const { sent, fetch } = endpoint({ text: JSON.stringify(GOOD) });
    const c = compatibleClient(GROQ, 'sk-test', { fetch });
    await c.liveCheck(REQ);
    await c.streamChat(CHAT, () => {}).done;
    expect(sent.map((s) => s.body.max_tokens)).toEqual([8192, 4096]);
  });

  it('sends OpenAI max_completion_tokens in place of max_tokens, whole and streamed; another preset keeps max_tokens', async () => {
    const openai = endpoint({ text: JSON.stringify(GOOD) });
    const c = compatibleClient(CONFIG, 'sk-test', { fetch: openai.fetch });
    await c.liveCheck(REQ);
    await c.startToolCall(TOOL('deepCheck')).done;
    await c.streamChat(CHAT, () => {}).done;
    expect(openai.sent.map((s) => [s.body.max_completion_tokens, 'max_tokens' in s.body])).toEqual([[8192, false], [12_000, false], [4096, false]]);
    const groq = endpoint({ text: JSON.stringify(GOOD) });
    await compatibleClient(GROQ, 'sk-test', { fetch: groq.fetch }).liveCheck(REQ);
    expect(groq.sent[0]!.body).toMatchObject({ max_tokens: 8192 });
    expect(groq.sent[0]!.body).not.toHaveProperty('max_completion_tokens');
  });

  it("a fixed preset calls its own address with its own JSON support, whatever the stored settings say", async () => {
    const tampered = endpoint();
    await compatibleClient({ ...CONFIG, baseURL: 'https://evil.example/v1', structuredOutputs: false }, 'sk-abc', { fetch: tampered.fetch }).liveCheck(REQ);
    expect(tampered.sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(tampered.sent[0]!.body.response_format.type).toBe('json_schema');
    const groq = endpoint();
    await compatibleClient({ ...GROQ, baseURL: 'https://evil.example/v1', structuredOutputs: true }, 'sk-abc', { fetch: groq.fetch }).liveCheck(REQ);
    expect(groq.sent[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(groq.sent[0]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('a custom endpoint uses its stored address and JSON support', async () => {
    const custom = endpoint();
    const config: CompatibleConfig = { ...CONFIG, preset: 'custom', baseURL: 'https://llm.example.com/v1', structuredOutputs: true };
    await compatibleClient(config, 'sk-c', { fetch: custom.fetch }).liveCheck(REQ);
    expect(custom.sent[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(custom.sent[0]!.body.response_format.type).toBe('json_schema');
    const plain = endpoint();
    await compatibleClient({ ...config, structuredOutputs: false }, 'sk-c', { fetch: plain.fetch }).liveCheck(REQ);
    expect(plain.sent[0]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it.each([
    ['rewrite', 'smart-1'],
    ['wordLimit', 'smart-1'],
    ['followUp', 'smart-1'],
    ['styleProfile', 'smart-1'],
    ['readers', 'smart-1'],
    ['deepCheck', 'smart-1'],
    ['synonyms', 'fast-1'],
    ['tone', 'fast-1'],
  ] as const)('sends %s to %s', async (kind, model) => {
    const { sent, fetch } = endpoint({ text: '{"a":"b"}' });
    const run = compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL(kind));
    expect(run.model).toBe(model);
    expect((await run.done).model).toBe(model);
    expect(sent[0]!.body.model).toBe(model);
  });

  it('an endpoint without JSON schema is told the schema in its instructions: the live check, a whole and a streamed call', async () => {
    const { sent, fetch } = endpoint((n) => ({ text: n === 1 ? JSON.stringify(GOOD) : '{"a":"b"}' }));
    const c = compatibleClient(GROQ, 'sk-test', { fetch });
    await c.liveCheck(REQ);
    await c.startToolCall(TOOL('rewrite')).done;
    await c.startToolCall(TOOL('deepCheck')).done;
    const system = sent.map((s) => s.body.messages[0]);
    const live = buildLiveCheckSystem('standard', 'en-US').map((b) => b.text).join('\n\n');
    expect(system).toEqual([
      { role: 'system', content: `${live}\n\nAnswer with JSON only, matching this JSON schema: ${JSON.stringify(LIVE_CHECK_JSON_SCHEMA)}` },
      { role: 'system', content: `Be brief.\n\nStandard mode.\n\nAnswer with JSON only, matching this JSON schema: ${JSON.stringify(SCHEMA)}` },
      { role: 'system', content: `Be brief.\n\nStandard mode.\n\nAnswer with JSON only, matching this JSON schema: ${JSON.stringify(SCHEMA)}` },
    ]);
    // The live check's top-level key, which its prompt never names, is in what the model reads.
    expect(system[0].content).toContain('"results"');
    expect(sent.map((s) => s.body.response_format)).toEqual([{ type: 'json_object' }, { type: 'json_object' }, { type: 'json_object' }]);
    expect(sent[2]!.body.stream).toBe(true);
  });

  it('a custom endpoint is told the schema with its box unticked, and not with it ticked', async () => {
    const base: CompatibleConfig = { ...CONFIG, preset: 'custom', baseURL: 'https://llm.example.com/v1' };
    const plain = endpoint({ text: '{"a":"b"}' });
    await compatibleClient({ ...base, structuredOutputs: false }, 'sk-c', { fetch: plain.fetch }).startToolCall(TOOL('rewrite')).done;
    expect(plain.sent[0]!.body.messages[0].content).toBe(`Be brief.\n\nStandard mode.\n\nAnswer with JSON only, matching this JSON schema: ${JSON.stringify(SCHEMA)}`);
    const ticked = endpoint({ text: '{"a":"b"}' });
    await compatibleClient({ ...base, structuredOutputs: true }, 'sk-c', { fetch: ticked.fetch }).startToolCall(TOOL('rewrite')).done;
    expect(ticked.sent[0]!.body.messages[0].content).toBe('Be brief.\n\nStandard mode.');
  });

  it('an endpoint with JSON schema gets the schema as the response format, with its instructions unchanged; chat gets no schema anywhere', async () => {
    const { sent, fetch } = endpoint((n) => ({ text: n === 1 ? JSON.stringify(GOOD) : '{"a":"b"}' }));
    const c = compatibleClient(CONFIG, 'sk-test', { fetch });
    await c.liveCheck(REQ);
    await c.startToolCall(TOOL('deepCheck')).done;
    expect(sent.map((s) => s.body.messages[0].content)).toEqual([buildLiveCheckSystem('standard', 'en-US').map((b) => b.text).join('\n\n'), 'Be brief.\n\nStandard mode.']);
    expect(sent.map((s) => s.body.response_format.type)).toEqual(['json_schema', 'json_schema']);
    const groq = endpoint({ text: 'Sure.' });
    await compatibleClient(GROQ, 'sk-test', { fetch: groq.fetch }).streamChat(CHAT, () => {}).done;
    expect(groq.sent[0]!.body.messages[0]).toEqual({ role: 'system', content: 'You help.' });
    expect(groq.sent[0]!.raw).not.toContain('JSON schema');
  });

  it('asks for the JSON schema where the endpoint supports it, and for JSON otherwise', async () => {
    const schema = endpoint({ text: '{"a":"b"}' });
    await compatibleClient(CONFIG, 'sk-test', { fetch: schema.fetch }).startToolCall(TOOL('rewrite')).done;
    expect(schema.sent[0]!.body.response_format).toEqual({ type: 'json_schema', json_schema: { schema: SCHEMA, strict: true, name: 'response' } });
    const json = endpoint({ text: '{"a":"b"}' });
    await compatibleClient(OLLAMA, null, { fetch: json.fetch }).startToolCall(TOOL('rewrite')).done;
    expect(json.sent[0]!.body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('compatibleClient tool calls', () => {
  it('answers a whole call with the parsed JSON, the mapped usage and the model, with nothing spent so far', async () => {
    const run = compatibleClient(CONFIG, 'sk-test', { fetch: endpoint({ text: '{"a":"b"}' }).fetch }).startToolCall(TOOL('rewrite'));
    expect(await run.done).toEqual({ data: { a: 'b' }, usage: MAPPED, truncated: false, model: 'smart-1' });
    expect(run.spentSoFar()).toBeNull();
  });

  it('answers prose with data null and the usage, as the Anthropic path does', async () => {
    const fetch = endpoint({ text: 'Sure! {"a":"b"}' }).fetch;
    expect(await compatibleClient(OLLAMA, null, { fetch }).startToolCall(TOOL('synonyms')).done).toEqual({
      data: null,
      usage: MAPPED,
      truncated: false,
      model: 'fast-1',
    });
  });

  it('marks a length finish truncated, with the usage', async () => {
    const fetch = endpoint({ text: '{"a":"b', finish: 'length' }).fetch;
    expect(await compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('rewrite')).done).toMatchObject({ truncated: true, usage: MAPPED });
  });

  it.each([
    ['rewrite', 2],
    ['wordLimit', 1],
    ['tone', 1],
    ['deepCheck', 1],
  ] as const)('retries a failed %s request to %i request(s) in all', async (kind, requests) => {
    const { sent, fetch } = endpoint((n) => (n === 1 ? { status: 500 } : { text: '{"a":"b"}' }));
    const { error } = await outcome(compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL(kind)).done);
    expect(sent).toHaveLength(requests);
    expect(error === null ? 'ok' : statusFromError(error)).toBe(requests === 2 ? 'ok' : 'overloaded');
  });

  it('a 429 whose retry wait outlasts the time limit is rate_limited, after one request', async () => {
    const { sent, fetch } = endpoint({ status: 429, retryAfter: '2' });
    const t0 = Date.now();
    const { error } = await outcome(compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('rewrite'), { timeoutMs: 1000 }).done);
    expect(statusFromError(error)).toBe('rate_limited');
    expect(sent).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('aborts a whole call that runs past its time, as a timeout', async () => {
    const run = compatibleClient(CONFIG, 'sk-test', { fetch: endpoint({ hang: true }).fetch }).startToolCall(TOOL('rewrite'), { timeoutMs: 50 });
    const { error } = await outcome(run.done);
    expect((error as Error).name).toBe('TimeoutError');
    expect(statusFromError(error)).toBe('offline');
  });

  it.each(['readers', 'grader', 'deepCheck'] as const)('streams %s and asks the stream for its usage', async (kind) => {
    const { sent, fetch } = endpoint({ text: '{"a":"b"}' });
    await compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL(kind)).done;
    expect(sent[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it.each(['rewrite', 'synonyms', 'followUp', 'styleProfile', 'tone'] as const)('sends %s whole', async (kind) => {
    const { sent, fetch } = endpoint({ text: '{"a":"b"}' });
    await compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL(kind)).done;
    expect(sent[0]!.body.stream).toBeUndefined();
  });

  it('a Deep check consumes the stream and parses the JSON at the end', async () => {
    const fetch = endpoint({ chunks: ['{"a"', ':"', 'b"}'] }).fetch;
    const run = compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('deepCheck'));
    expect(await run.done).toEqual({ data: { a: 'b' }, usage: MAPPED, truncated: false, model: 'smart-1' });
    expect(run.spentSoFar()).toEqual(MAPPED);
  });

  it('a streamed answer cut off at its limit is truncated, with its usage', async () => {
    const fetch = endpoint({ chunks: ['{"a"', ':"b'], finish: 'length' }).fetch;
    expect(await compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('grader')).done).toEqual({
      data: null,
      usage: MAPPED,
      truncated: true,
      model: 'smart-1',
    });
  });

  it('a stream that breaks before its usage rejects as offline, with nothing known spent', async () => {
    const fetch = endpoint({ chunks: ['{"a"'], breakWith: new TypeError('network error') }).fetch;
    const run = compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('readers'));
    const { error } = await outcome(run.done);
    expect(statusFromError(error)).toBe('offline');
    expect(run.spentSoFar()).toBeNull();
  });

  it('an error event in the stream rejects with its status', async () => {
    const fetch = (async () =>
      new Response(sseStreamOf([{ error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 429 } }]), {
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch;
    const { error } = await outcome(compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('deepCheck')).done);
    expect(statusFromError(error)).toBe('rate_limited');
  });

  it('aborts a stream that runs past its time, as a timeout', async () => {
    const fetch = endpoint({ chunks: ['{"a"'], stall: true }).fetch;
    const { error } = await outcome(compatibleClient(CONFIG, 'sk-test', { fetch }).startToolCall(TOOL('deepCheck'), { timeoutMs: 50 }).done);
    expect((error as Error).name).toBe('TimeoutError');
    expect(statusFromError(error)).toBe('offline');
  });
});

/** An SSE body of these raw events, then [DONE]. */
function sseStreamOf(events: object[]): string {
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
}

describe('compatibleClient chat', () => {
  it('passes text through onText as it arrives, then done carries the text, the usage and the smart model', async () => {
    const { sent, fetch } = endpoint({ chunks: ['Try ', 'this.'] });
    const deltas: string[] = [];
    const s = compatibleClient(CONFIG, 'sk-test', { fetch }).streamChat(CHAT, (t) => deltas.push(t));
    expect(await s.done).toEqual({ text: 'Try this.', usage: MAPPED, complete: true, model: 'smart-1' });
    expect(deltas).toEqual(['Try ', 'this.']);
    expect(s.usageSoFar()).toEqual(MAPPED);
    expect(sent[0]!.body).toMatchObject({
      model: 'smart-1',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'You help.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'Fix my intro.' },
      ],
    });
    expect(sent[0]!.raw).not.toContain('cache_control');
  });

  it('an answer cut off at its limit is not complete', async () => {
    const s = compatibleClient(CONFIG, 'sk-test', { fetch: endpoint({ chunks: ['Try '], finish: 'length' }).fetch }).streamChat(CHAT, () => {});
    expect(await s.done).toMatchObject({ text: 'Try ', complete: false });
  });

  it('abort() rejects done, with no usage known', async () => {
    const deltas: string[] = [];
    const s = compatibleClient(CONFIG, 'sk-test', { fetch: endpoint({ chunks: ['Try '], stall: true }).fetch }).streamChat(CHAT, (t) => {
      deltas.push(t);
      s.abort();
    });
    const { error } = await outcome(s.done);
    expect(deltas).toEqual(['Try ']);
    expect((error as Error).name).toBe('AbortError');
    expect(s.usageSoFar()).toBeNull();
  });
});

describe('compatibleClient keys', () => {
  it('a key-less preset (Ollama) sends no Authorization header, even with a key at hand', async () => {
    for (const key of [null, 'sk-stray']) {
      const { sent, fetch } = endpoint();
      await compatibleClient(OLLAMA, key, { fetch }).liveCheck(REQ);
      expect(sent[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(sent[0]!.headers.has('authorization')).toBe(false);
    }
  });

  it('a keyed preset sends Bearer {key}', async () => {
    const { sent, fetch } = endpoint();
    await compatibleClient(CONFIG, 'sk-abc', { fetch }).liveCheck(REQ);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-abc');
  });
});

describe('SDK warnings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('go to console.warn, except the one every request without structured outputs raises', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(logSdkWarnings);
    const schemaNotSent = { type: 'unsupported' as const, feature: 'responseFormat', details: 'JSON response format schema is only supported with structuredOutputs' };
    logSdkWarnings({ warnings: [schemaNotSent], provider: 'compatible.chat', model: 'llama' });
    expect(warn).not.toHaveBeenCalled();
    const topK = { type: 'unsupported' as const, feature: 'topK' };
    const other = { type: 'other' as const, message: 'Something else.' };
    logSdkWarnings({ warnings: [schemaNotSent, topK, other], provider: 'compatible.chat', model: 'llama' });
    expect(warn.mock.calls.map((c) => c[1])).toEqual([
      { provider: 'compatible.chat', model: 'llama', warning: topK },
      { provider: 'compatible.chat', model: 'llama', warning: other },
    ]);
  });

  it('a request to an endpoint without JSON schema logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await compatibleClient(OLLAMA, null, { fetch: endpoint().fetch }).liveCheck(REQ);
    expect(warn).not.toHaveBeenCalled();
  });
});
