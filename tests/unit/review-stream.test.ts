// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { statusFromError } from '../../src/background/errors';
import { makeClient, startCitationSearch, startToolCall, type ToolCall } from '../../src/background/claude';
import { sourcesFromResponse } from '../../src/core/citations';
import { MADE_UP_URL, SEARCH_RESULTS, startMockAnthropic, webSearchReply, type MockReply } from '../e2e/mock-anthropic';

// The streamed review requests against the mock Messages API, over real server-sent events.

const PORT = 4988;
const CALL = { system: [{ type: 'text' as const, text: 's' }], user: 'u' };
const tool = (kind: ToolCall['kind']): ToolCall => ({ ...CALL, kind, schema: { type: 'object' } });
let mock: Awaited<ReturnType<typeof startMockAnthropic>> | null = null;

afterEach(async () => {
  await mock?.close();
  mock = null;
});

async function serve(reply: MockReply) {
  mock = await startMockAnthropic(PORT, async () => reply);
  return makeClient('sk-test', { baseURL: `http://127.0.0.1:${PORT}` });
}
const outcome = <T>(p: Promise<T>) =>
  p.then(
    (result) => ({ result, error: null as unknown }),
    (error: unknown) => ({ result: null, error }),
  );

describe('streamed review requests against the mock server', () => {
  it('a Deep check asks for a stream with its schema, and its answer parses as a whole one would', async () => {
    const client = await serve({ results: [], notes: [] });
    const { result } = await outcome(startToolCall(client, tool('deepCheck')).done);
    expect(result).toEqual({
      data: { results: [], notes: [] },
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      truncated: false,
      model: 'claude-sonnet-5-5',
    });
    expect(mock!.requests[0].stream).toBe(true);
    expect(mock!.requests[0].output_config.format).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('an answer that stalls after its headers is aborted at its whole-answer time, as a timeout, and reports its input and streamed text', async () => {
    const client = await serve({ chunks: ['{"criteria":'], stall: true });
    const run = startToolCall(client, tool('grader'), { timeoutMs: 300 });
    const t0 = Date.now();
    const { error } = await outcome(run.done);
    const ms = Date.now() - t0;
    expect(error).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(statusFromError(error)).toBe('offline');
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(5000);
    // 12 characters streamed: 3 tokens.
    expect(run.spentSoFar()).toEqual({
      input_tokens: 100,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
    });
  });

  it('an overloaded API is not asked again, and nothing is reported spent', async () => {
    const client = await serve({ status: 529 });
    const run = startToolCall(client, tool('readers'));
    const { error } = await outcome(run.done);
    expect(statusFromError(error)).toBe('overloaded');
    expect(mock!.requests).toHaveLength(1);
    expect(run.spentSoFar()).toBeNull();
  });

  it('a citation search streams its blocks: the results and citations arrive whole, and the searches are counted', async () => {
    const client = await serve(webSearchReply());
    const { result } = await outcome(startCitationSearch(client, CALL).done);
    expect(result!.usage.server_tool_use).toEqual({ web_search_requests: 2 });
    expect(result!.stopReason).toBe('end_turn');
    const sources = sourcesFromResponse(result!.content);
    expect(sources.map((s) => s.url)).toEqual([SEARCH_RESULTS[0].url, SEARCH_RESULTS[1].url]);
    expect(sources[0]!.snippet).toBe('Sleep strengthens newly formed memories.');
    expect(JSON.stringify(sources)).not.toContain(MADE_UP_URL);
  });

  it('a citation search that stalls after its results is aborted, and reports its search and the text it streamed', async () => {
    const reply = webSearchReply();
    const client = await serve({ ...reply, stall: true });
    const run = startCitationSearch(client, CALL, { timeoutMs: 300 });
    const { error } = await outcome(run.done);
    expect(statusFromError(error)).toBe('offline');
    const chars = reply.blocks.reduce(
      (n, b: any) => n + (b.type === 'text' ? b.text.length : b.type === 'server_tool_use' ? JSON.stringify(b.input).length : 0),
      0,
    );
    expect(run.spentSoFar()).toEqual({
      input_tokens: 100,
      output_tokens: Math.ceil(chars / 4),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 1 },
    });
  });
});
