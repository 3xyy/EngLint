import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AuthenticationError } from '@anthropic-ai/sdk';
import {
  LiveCheckParseError,
  makeClient,
  runCitationSearch,
  runLiveCheck,
  runToolCall,
  startCitationSearch,
  startToolCall,
  type ToolCall,
} from '../../src/background/claude';
import { fakeStream, firstEvents, sseBody, type BrokenReply } from './stream-fakes';

const REQ = {
  mode: 'standard' as const,
  dialect: 'en-US' as const,
  paragraphs: [{ id: 'p0', text: 'Its a test.' }],
};
const GOOD = {
  results: [
    {
      paragraph_id: 'p0',
      issues: [
        { original: 'Its', replacement: "It's", before: '', category: 'grammar', severity: 'error', kind: 'its_vs_it_is', reason: 'Use "it\'s".' },
      ],
    },
  ],
};
const USAGE = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: 5 };

function setup(text: string, stop_reason = 'end_turn') {
  const seen: { url: string; headers: Headers; body: any }[] = [];
  const fakeFetch = (async (input: any, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body });
    if (body.stream === true) {
      return new Response(sseBody({ model: body.model, content: [{ type: 'text', text }], usage: USAGE, stop_reason }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
        content: [{ type: 'text', text }], stop_reason, stop_sequence: null, usage: USAGE,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { seen, client: makeClient('sk-test', { baseURL: 'https://example.test', fetch: fakeFetch }) };
}

describe('runLiveCheck', () => {
  it('sends the expected request', async () => {
    const { seen, client } = setup(JSON.stringify(GOOD));
    await runLiveCheck(client, REQ);
    const r = seen[0]!;
    expect(r.url.endsWith('/v1/messages')).toBe(true);
    expect(r.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(r.body.model).toBe('claude-haiku-5-5');
    expect(r.body.max_tokens).toBe(8192);
    expect(r.body.thinking).toEqual({ type: 'disabled' });
    expect(r.body.output_config.format.type).toBe('json_schema');
    expect('output_format' in r.body).toBe(false);
    expect('tool_choice' in r.body).toBe(false);
    expect(r.body.system).toHaveLength(2);
    expect(r.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(r.body.messages[0].content).toContain('<paragraphs>');
  });
  it('repeats the writer\'s dictionary words after the paragraphs, and adds nothing without any', async () => {
    const plain = setup(JSON.stringify(GOOD));
    await runLiveCheck(plain.client, REQ);
    expect(plain.seen[0]!.body.messages[0].content.endsWith('</paragraphs>')).toBe(true);
    const taught = setup(JSON.stringify(GOOD));
    await runLiveCheck(taught.client, { ...REQ, learned: { dictionary: ['lyon'] } });
    const content: string = taught.seen[0]!.body.messages[0].content;
    expect(content).toMatch(/<\/paragraphs>\nDictionary words .*"lyon"/);
  });
  it('asks for every family the mode allows, with no toggle lines in the mode block', async () => {
    const { seen, client } = setup(JSON.stringify(GOOD));
    await runLiveCheck(client, REQ);
    const modeBlock = seen[0]!.body.system[1].text;
    expect(modeBlock).toContain('Suggestion families on: Clarity, Engagement, Delivery, Generic phrasing.');
    expect(modeBlock).not.toMatch(/ is off/);
  });
  it('request schema constrains category and severity with enums', async () => {
    const { seen, client } = setup(JSON.stringify(GOOD));
    await runLiveCheck(client, REQ);
    const schema = seen[0]!.body.output_config.format.schema;
    const issue = schema.properties.results.items.properties.issues.items.properties;
    expect(issue.category.enum).toEqual(['spelling', 'grammar', 'punctuation', 'word_choice', 'clarity', 'engagement', 'delivery']);
    expect(issue.severity.enum).toEqual(['error', 'suggestion']);
    expect('$schema' in schema).toBe(false);
  });
  it('parses output and returns usage', async () => {
    const { client } = setup(JSON.stringify(GOOD));
    const res = await runLiveCheck(client, REQ);
    expect(res.output).toEqual(GOOD);
    expect(res.usage).toEqual(USAGE);
    expect(res.truncated).toBe(false);
    expect(res.droppedInvalid).toBe(0);
  });
  it('max_tokens gives truncated:true without throwing, even on cut-off JSON', async () => {
    const { client } = setup('{"results":[{"paragraph_id":"p0","iss', 'max_tokens');
    const res = await runLiveCheck(client, REQ);
    expect(res).toEqual({ output: { results: [] }, usage: USAGE, truncated: true, droppedInvalid: 0 });
  });
  it('throws LiveCheckParseError on invalid JSON', async () => {
    const { client } = setup('not json');
    await expect(runLiveCheck(client, REQ)).rejects.toBeInstanceOf(LiveCheckParseError);
  });
  it('throws LiveCheckParseError on schema mismatch', async () => {
    const { client } = setup(JSON.stringify({ results: [{ paragraph_id: 'p0' }] }));
    await expect(runLiveCheck(client, REQ)).rejects.toBeInstanceOf(LiveCheckParseError);
  });
  it('invented category drops only that issue', async () => {
    const good = GOOD.results[0]!.issues[0]!;
    const { client } = setup(
      JSON.stringify({ results: [{ paragraph_id: 'p0', issues: [{ ...good, category: 'capitalization' }, good] }] }),
    );
    const res = await runLiveCheck(client, REQ);
    expect(res.output).toEqual(GOOD);
    expect(res.droppedInvalid).toBe(1);
  });
  it('invalid severity drops only that issue', async () => {
    const good = GOOD.results[0]!.issues[0]!;
    const { client } = setup(
      JSON.stringify({ results: [{ paragraph_id: 'p0', issues: [good, { ...good, severity: 'warning' }] }] }),
    );
    const res = await runLiveCheck(client, REQ);
    expect(res.output).toEqual(GOOD);
    expect(res.droppedInvalid).toBe(1);
  });
  it('bad top-level shape still throws LiveCheckParseError', async () => {
    for (const body of [{ results: 'none' }, { answers: [] }]) {
      const { client } = setup(JSON.stringify(body));
      await expect(runLiveCheck(client, REQ)).rejects.toBeInstanceOf(LiveCheckParseError);
    }
  });
  it('propagates SDK API errors, not LiveCheckParseError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const client = makeClient('sk-test', { baseURL: 'https://example.test', fetch: fakeFetch });
    const err = await runLiveCheck(client, REQ).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).not.toBeInstanceOf(LiveCheckParseError);
  });
});

describe('runToolCall settings', () => {
  const call = (kind: ToolCall['kind']): ToolCall => ({ kind, system: [{ type: 'text', text: 's' }], user: 'u', schema: { type: 'object' } });
  const sent = async (kind: ToolCall['kind']) => {
    const { seen, client } = setup(JSON.stringify({}));
    await runToolCall(client, call(kind));
    return seen[0]!.body;
  };
  it('tone: Haiku, 256 tokens, thinking disabled and no effort', async () => {
    const body = await sent('tone');
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(256);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).not.toHaveProperty('effort');
  });
  it('deepCheck: Sonnet, 12000 tokens, medium effort and no thinking field', async () => {
    const body = await sent('deepCheck');
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(12000);
    expect(body.output_config.effort).toBe('medium');
    expect(body).not.toHaveProperty('thinking');
  });
  it('readers and grader: Sonnet with low effort', async () => {
    const readers = await sent('readers');
    expect(readers.output_config.effort).toBe('low');
    expect(readers.max_tokens).toBe(4096);
    const grader = await sent('grader');
    expect(grader.output_config.effort).toBe('low');
    expect(grader.max_tokens).toBe(6144);
  });
  it('synonyms keep thinking disabled and no effort; rewrite and follow-up keep low effort and no thinking field', async () => {
    const syn = await sent('synonyms');
    expect(syn.thinking).toEqual({ type: 'disabled' });
    expect(syn.output_config).not.toHaveProperty('effort');
    for (const kind of ['rewrite', 'followUp'] as const) {
      const body = await sent(kind);
      expect(body.output_config.effort).toBe('low');
      expect(body).not.toHaveProperty('thinking');
    }
  });
});

describe('runCitationSearch', () => {
  const CALL = { system: [{ type: 'text' as const, text: 'cf system' }], user: 'the claim' };
  const CONTENT = [
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' }, caller: { type: 'direct' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', caller: { type: 'direct' }, content: [] },
    { type: 'text', text: 'Nothing.', citations: null },
  ];
  const fake = (usage: Record<string, unknown>, stop_reason = 'end_turn') => {
    const stream = vi.fn((_body: Record<string, any>, _opts?: Record<string, any>) => fakeStream(Promise.resolve({ content: CONTENT, usage, stop_reason })));
    return { stream, client: { messages: { stream } } as unknown as Anthropic };
  };

  it('streams Sonnet with the web search tool, low effort, 4096 tokens and no output format, with a 90 s timeout and no retries', async () => {
    const { stream, client } = fake({ ...USAGE, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } });
    await runCitationSearch(client, CALL);
    const [body, opts] = stream.mock.calls[0]!;
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(4096);
    expect(body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] }]);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('thinking');
    expect(body.system).toEqual(CALL.system);
    expect(body.messages).toEqual([{ role: 'user', content: 'the claim' }]);
    expect(opts).toEqual({ timeout: 90_000, maxRetries: 0 });
  });

  it('returns the content, the stop reason, the model and the usage with its web search count', async () => {
    const { client } = fake({ ...USAGE, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } }, 'pause_turn');
    const out = await runCitationSearch(client, CALL);
    // A streamed text block with no citations carries no citations field.
    expect(out.content).toEqual([CONTENT[0], CONTENT[1], { type: 'text', text: 'Nothing.' }]);
    expect(out.stopReason).toBe('pause_turn');
    expect(out.model).toBe('claude-sonnet-5-5');
    expect(out.usage).toEqual({ ...USAGE, server_tool_use: { web_search_requests: 2 } });
  });

  it('gives a null server_tool_use when the response has none', async () => {
    const { client } = fake(USAGE);
    expect((await runCitationSearch(client, CALL)).usage.server_tool_use).toBeNull();
  });

  it('through the SDK: the request body asks for a stream and carries the tool and no output format', async () => {
    const { seen, client } = setup('Nothing.');
    await runCitationSearch(client, CALL);
    expect(seen[0]!.body.stream).toBe(true);
    expect(seen[0]!.body.tools[0]).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] });
    expect(seen[0]!.body.output_config).not.toHaveProperty('format');
  });
});

describe('review request options', () => {
  const REPLY = { content: [{ type: 'text', text: '{}' }], usage: USAGE, stop_reason: 'end_turn' };
  const call = (kind: ToolCall['kind']): ToolCall => ({ kind, system: [{ type: 'text', text: 's' }], user: 'u', schema: { type: 'object' } });
  const fakeClient = () => {
    const create = vi.fn(async (_body: Record<string, any>, _opts?: Record<string, any>) => REPLY);
    const stream = vi.fn((_body: Record<string, any>, _opts?: Record<string, any>) => fakeStream(Promise.resolve(REPLY)));
    return { create, stream, client: { messages: { create, stream } } as unknown as Anthropic };
  };

  it('tone is sent whole, with its 20 s timeout and no retries', async () => {
    const { create, stream, client } = fakeClient();
    await runToolCall(client, call('tone'));
    expect(create.mock.calls[0]![1]).toEqual({ timeout: 20_000, maxRetries: 0 });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each([
    ['readers', 60_000],
    ['grader', 90_000],
    ['deepCheck', 120_000],
  ] as const)('%s streams with its schema, a %i ms timeout and no retries', async (kind, timeout) => {
    const { create, stream, client } = fakeClient();
    await runToolCall(client, call(kind));
    expect(create).not.toHaveBeenCalled();
    const [body, opts] = stream.mock.calls[0]!;
    expect(opts).toEqual({ timeout, maxRetries: 0 });
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('the citation search streams with a 90 s timeout and no retries', async () => {
    const { create, stream, client } = fakeClient();
    await runCitationSearch(client, { system: [{ type: 'text', text: 's' }], user: 'u' });
    expect(create).not.toHaveBeenCalled();
    expect(stream.mock.calls[0]![1]).toEqual({ timeout: 90_000, maxRetries: 0 });
  });

  it('rewrite, synonyms and follow-ups are sent whole and keep one retry', async () => {
    for (const kind of ['rewrite', 'synonyms', 'followUp'] as const) {
      const { create, stream, client } = fakeClient();
      await runToolCall(client, call(kind));
      expect(create.mock.calls[0]![1]).toMatchObject({ maxRetries: 1 });
      expect(stream).not.toHaveBeenCalled();
    }
  });
});

describe('a streamed review answer', () => {
  const call = (kind: ToolCall['kind']): ToolCall => ({ kind, system: [{ type: 'text', text: 's' }], user: 'u', schema: { type: 'object' } });

  it('through the SDK: parses into the same data, usage and truncation as a whole answer', async () => {
    const { seen, client } = setup(JSON.stringify({ results: [], notes: [] }));
    expect(await runToolCall(client, call('deepCheck'))).toEqual({ data: { results: [], notes: [] }, usage: USAGE, truncated: false, model: 'claude-sonnet-5-5' });
    expect(seen[0]!.body.stream).toBe(true);
  });

  it('through the SDK: an answer cut off at max_tokens is truncated, with null data', async () => {
    const { client } = setup('{"criteria":[{"na', 'max_tokens');
    expect(await runToolCall(client, call('grader'))).toEqual({ data: null, usage: USAGE, truncated: true, model: 'claude-sonnet-5-5' });
  });
});

describe('what a broken review stream spent', () => {
  const call = (kind: ToolCall['kind']): ToolCall => ({ kind, system: [{ type: 'text', text: 's' }], user: 'u', schema: { type: 'object' } });
  const broken = (reply: BrokenReply) => ({ messages: { stream: () => fakeStream(Promise.resolve(reply)) } }) as unknown as Anthropic;
  const TEXT_41 = { content: [{ type: 'text', text: 'x'.repeat(41) }], usage: USAGE, stop_reason: 'end_turn' };
  const BOOM = new Error('connection dropped');

  it('after message_start: the input usage, and the streamed text at 4 characters a token as the output', async () => {
    // message_start, the text block's start and its 41 characters.
    const run = startToolCall(broken({ events: firstEvents(TEXT_41, 3), error: BOOM }), call('grader'));
    await expect(run.done).rejects.toThrow('connection dropped');
    expect(run.spentSoFar()).toEqual({ ...USAGE, output_tokens: 11, server_tool_use: null });
  });

  it('counts streamed thinking and tool input toward the output too', async () => {
    const start = firstEvents(TEXT_41, 1);
    const events = [
      ...start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a'.repeat(8) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"q"}' } },
    ];
    const run = startCitationSearch(broken({ events, error: BOOM }), { system: [{ type: 'text', text: 's' }], user: 'u' });
    await expect(run.done).rejects.toThrow();
    // 8 + 13 characters: 6 tokens.
    expect(run.spentSoFar()?.output_tokens).toBe(6);
  });

  it('before message_start: nothing', async () => {
    const run = startToolCall(broken({ events: [], error: BOOM }), call('deepCheck'));
    await expect(run.done).rejects.toThrow();
    expect(run.spentSoFar()).toBeNull();
  });

  it('a stream that ends without message_stop: what it showed, though nothing failed on the wire', async () => {
    const run = startToolCall(broken({ events: firstEvents(TEXT_41, 4) }), call('readers'));
    await expect(run.done).rejects.toThrow();
    expect(run.spentSoFar()).toEqual({ ...USAGE, output_tokens: 11, server_tool_use: null });
  });

  it('a citation search counts each search whose results came back, and not one that failed', async () => {
    const result = (id: string, content: unknown) => ({ type: 'web_search_tool_result', tool_use_id: id, caller: { type: 'direct' }, content });
    const msg = {
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'a' }, caller: { type: 'direct' } },
        result('s1', [{ type: 'web_search_result', url: 'https://a.example/', title: 'A', page_age: null, encrypted_content: 'e' }]),
        { type: 'server_tool_use', id: 's2', name: 'web_search', input: { query: 'b' }, caller: { type: 'direct' } },
        result('s2', { type: 'web_search_tool_result_error', error_code: 'unavailable' }),
        { type: 'server_tool_use', id: 's3', name: 'web_search', input: { query: 'c' }, caller: { type: 'direct' } },
      ],
      usage: USAGE,
      stop_reason: 'end_turn',
    };
    // Everything up to the third search's start: one search came back, one failed, one is still running.
    const events = firstEvents(msg, 1 + 3 + 2 + 3 + 2 + 1);
    const run = startCitationSearch(broken({ events, error: BOOM }), { system: [{ type: 'text', text: 's' }], user: 'u' });
    await expect(run.done).rejects.toThrow();
    expect(run.spentSoFar()?.server_tool_use).toEqual({ web_search_requests: 1 });
  });
});
