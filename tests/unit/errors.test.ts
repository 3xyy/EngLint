// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError, RetryError, StreamProviderError } from 'ai';
import { describe, expect, it } from 'vitest';
import { LiveCheckParseError } from '../../src/background/claude';
import { isModelNotFound, statusFromError, statusFromHttp } from '../../src/background/errors';

/** An AI SDK HTTP error as the OpenAI-compatible provider builds it: the provider's message, its parsed body and the raw body. */
const httpErr = (statusCode: number, message = 'boom', code?: string) =>
  new APICallError({
    message,
    url: 'https://api.example.com/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ error: { message, type: 'x', code } }),
    data: { error: { message, type: 'x', code } },
  });
const retried = (last: unknown) => new RetryError({ message: 'Failed after 2 attempts.', reason: 'maxRetriesExceeded', errors: [last, last] });
const anthropicErr = (status: number) => new Anthropic.APIError(status, { error: { type: 'x' } }, 'boom', new Headers());

describe('statusFromError with the AI SDK', () => {
  it.each([
    [401, 'key_invalid'],
    [403, 'key_invalid'],
    [402, 'out_of_credit'],
    [429, 'rate_limited'],
    [500, 'overloaded'],
    [503, 'overloaded'],
    [529, 'overloaded'],
    [404, 'bad_response'],
    [400, 'bad_response'],
  ] as const)('maps an HTTP %i to %s', (status, expected) => {
    expect(statusFromError(httpErr(status))).toBe(expected);
  });

  it('maps a 400 about credit or billing to out_of_credit', () => {
    expect(statusFromError(httpErr(400, 'Your credit balance is too low.'))).toBe('out_of_credit');
    expect(statusFromError(httpErr(400, 'Check your billing details.'))).toBe('out_of_credit');
  });

  it("maps OpenAI's insufficient_quota 429 to out_of_credit, and a plain 429 about quota to rate_limited", () => {
    expect(statusFromError(httpErr(429, 'You exceeded your current quota.', 'insufficient_quota'))).toBe('out_of_credit');
    expect(statusFromError(httpErr(429, 'You exceeded your current quota.', 'rate_limit_exceeded'))).toBe('rate_limited');
  });

  it('reads the last error of a request that was retried', () => {
    expect(statusFromError(retried(httpErr(429)))).toBe('rate_limited');
    expect(statusFromError(retried(httpErr(503)))).toBe('overloaded');
  });

  it('maps a request that never reached the endpoint (no HTTP status) to offline', () => {
    const cut = new APICallError({ message: 'Cannot connect to API: refused', url: 'u', requestBodyValues: {}, cause: new Error('ECONNREFUSED'), isRetryable: true });
    expect(statusFromError(cut)).toBe('offline');
    expect(statusFromError(retried(cut))).toBe('offline');
  });

  it('maps a streamed body the network cut off part-way (a 200 with a TypeError inside) to offline', () => {
    const broken = new APICallError({ message: 'Failed to process successful response', url: 'u', requestBodyValues: {}, statusCode: 200, cause: new TypeError('network error') });
    expect(statusFromError(broken)).toBe('offline');
    expect(statusFromError(httpErr(200))).toBe('bad_response');
  });

  it("maps the browser's network TypeError to offline, and any other TypeError to bad_response", () => {
    expect(statusFromError(new TypeError('Failed to fetch'))).toBe('offline');
    expect(statusFromError(new TypeError('network error'))).toBe('offline');
    expect(statusFromError(new TypeError("Cannot read properties of undefined (reading 'text')"))).toBe('bad_response');
  });

  it('maps a timeout or an abort to offline', () => {
    expect(statusFromError(new DOMException('The answer took too long.', 'TimeoutError'))).toBe('offline');
    expect(statusFromError(new DOMException('This operation was aborted', 'AbortError'))).toBe('offline');
  });

  it('maps an error event in a stream by its status, and one with none to bad_response', () => {
    expect(statusFromError(new StreamProviderError({ message: 'slow down', statusCode: 429 }))).toBe('rate_limited');
    expect(statusFromError(new StreamProviderError({ message: 'overloaded', statusCode: 503 }))).toBe('overloaded');
    expect(statusFromError(new StreamProviderError({ message: 'bad key', statusCode: 401 }))).toBe('key_invalid');
    expect(statusFromError(new StreamProviderError({ message: 'odd' }))).toBe('bad_response');
  });

  it('maps an answer that was not JSON, or no answer, to bad_response', () => {
    const usage = { inputTokens: 1, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokens: 1, outputTokenDetails: { textTokens: 1, reasoningTokens: 0 }, totalTokens: 2 };
    const noObject = new NoObjectGeneratedError({ text: 'prose', response: { id: 'r', timestamp: new Date(0), modelId: 'm' }, usage, finishReason: 'stop' });
    expect(statusFromError(noObject)).toBe('bad_response');
    expect(statusFromError(new NoOutputGeneratedError())).toBe('bad_response');
    expect(statusFromError(new LiveCheckParseError('no'))).toBe('bad_response');
  });
});

describe('statusFromError with the Anthropic SDK', () => {
  it.each([
    [401, 'key_invalid'],
    [429, 'rate_limited'],
    [503, 'overloaded'],
    [400, 'bad_response'],
  ] as const)('maps an HTTP %i to %s, as before', (status, expected) => {
    expect(statusFromError(anthropicErr(status))).toBe(expected);
  });

  it('maps a connection error to offline, as before', () => {
    expect(statusFromError(new Anthropic.APIConnectionError({ message: 'down' }))).toBe('offline');
    expect(statusFromError(new Anthropic.APIConnectionTimeoutError({ message: 'slow' }))).toBe('offline');
  });

  it('keeps a 402 from the Anthropic SDK at bad_response, as before', () => {
    expect(statusFromError(anthropicErr(402))).toBe('bad_response');
  });
});

describe('statusFromHttp', () => {
  it('maps a status and an OpenAI-style body as statusFromError maps the SDK\'s errors', () => {
    expect(statusFromHttp(401, JSON.stringify({ error: { message: 'Incorrect API key' } }))).toBe('key_invalid');
    expect(statusFromHttp(429, JSON.stringify({ error: { message: 'Quota', code: 'insufficient_quota' } }))).toBe('out_of_credit');
    expect(statusFromHttp(429, JSON.stringify({ error: { message: 'Slow down' } }))).toBe('rate_limited');
    expect(statusFromHttp(503, 'Service Unavailable')).toBe('overloaded');
    expect(statusFromHttp(404, '<html>Not found</html>')).toBe('bad_response');
  });
});

describe('isModelNotFound', () => {
  it('holds for a 404, retried or not', () => {
    expect(isModelNotFound(httpErr(404, 'The model does not exist'))).toBe(true);
    expect(isModelNotFound(retried(httpErr(404)))).toBe(true);
  });
  it('fails for any other error', () => {
    expect(isModelNotFound(httpErr(400))).toBe(false);
    expect(isModelNotFound(retried(httpErr(500)))).toBe(false);
    expect(isModelNotFound(anthropicErr(404))).toBe(false);
    expect(isModelNotFound(new TypeError('Failed to fetch'))).toBe(false);
  });
});
