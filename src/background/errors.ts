import Anthropic from '@anthropic-ai/sdk';
import { APICallError, RetryError, StreamProviderError } from 'ai';
import type { CheckStatus } from '../core/types';
import { LIVE_CHECK_MODEL, LiveCheckParseError } from './claude';

/** The API's wording for an account with no credit left (HTTP 400, invalid_request_error). */
const NO_CREDIT = /credit balance|billing|purchase credits/i;

/** The HTTP status an error event inside a stream stands for: such an event carries the error's type but no status. */
const STATUS_OF_TYPE: Record<string, number> = {
  authentication_error: 401,
  permission_error: 403,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

/** fetch's own TypeError when the request never got an answer, or its body broke off: Chrome says "Failed to fetch" or "network error". */
const NETWORK_TYPE_ERROR = /fetch|network/i;

/**
 * The status an OpenAI-compatible endpoint's HTTP error stands for. A 429 is the account's credit only with
 * OpenAI's `insufficient_quota` code: other providers word a passing rate limit the same way.
 */
function statusOfHttp(status: number, message: string, code: unknown): CheckStatus {
  if (status === 401 || status === 403) return 'key_invalid';
  if (status === 402 || code === 'insufficient_quota') return 'out_of_credit';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'overloaded';
  if (status === 400 && NO_CREDIT.test(message)) return 'out_of_credit';
  return 'bad_response';
}

/** The error code in an OpenAI-style error body (`{ error: { code } }`), if any. */
function codeOf(data: unknown): unknown {
  const error = data !== null && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
  return error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}

/** The status an endpoint's HTTP error stands for, from its status code and body (an OpenAI-style error, or any text). */
export function statusFromHttp(status: number, body: string): CheckStatus {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    // not JSON: the text alone
  }
  return statusOfHttp(status, body, codeOf(data));
}

/** Whether an AI SDK request failed because the endpoint doesn't know the model (a 404), retried or not. */
export function isModelNotFound(err: unknown): boolean {
  const e = RetryError.isInstance(err) ? err.lastError : err;
  return APICallError.isInstance(e) && e.statusCode === 404;
}

/** The status a failed model request shows, for the Anthropic SDK's errors and the AI SDK's. */
export function statusFromError(err: unknown): CheckStatus {
  if (err instanceof LiveCheckParseError) return 'bad_response';
  // APIConnectionError (and its timeout subclass) extends APIError with no status, so test it first.
  if (err instanceof Anthropic.APIConnectionError) return 'offline';
  if (err instanceof Anthropic.APIError) {
    const s = err.status ?? (err.type ? STATUS_OF_TYPE[err.type] : undefined);
    if (s === 401 || s === 403) return 'key_invalid';
    if (s === 429) return 'rate_limited';
    if (s !== undefined && s >= 500) return 'overloaded'; // includes 529
    // The SDK's message is "400 " plus the JSON body, which carries the API's own error message.
    if (s === 400 && NO_CREDIT.test(err.message)) return 'out_of_credit';
    if (s === 404) console.warn('EngLint: the API does not know the model', LIVE_CHECK_MODEL);
    return 'bad_response';
  }
  // A stream the network cut off part-way: the SDK wraps fetch's TypeError in a plain AnthropicError.
  if (err instanceof Anthropic.AnthropicError && err.cause instanceof TypeError) return 'offline';

  // The AI SDK: a request that was retried fails with the last attempt's error inside.
  if (RetryError.isInstance(err)) return statusFromError(err.lastError);
  if (APICallError.isInstance(err)) {
    // No HTTP status: the request never reached the endpoint (the SDK's "Cannot connect to API"). A TypeError
    // inside: the network cut a streamed body off part-way (the SDK wraps it, with the 200 it had).
    if (err.statusCode === undefined || err.cause instanceof TypeError) return 'offline';
    return statusOfHttp(err.statusCode, `${err.message} ${err.responseBody ?? ''}`, codeOf(err.data));
  }
  if (StreamProviderError.isInstance(err)) return err.statusCode === undefined ? 'bad_response' : statusOfHttp(err.statusCode, err.message, err.code);
  // A request aborted at its time limit (or stopped), or one the network failed; any other TypeError is a bug, not the network.
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'offline';
  if (err instanceof TypeError && NETWORK_TYPE_ERROR.test(err.message)) return 'offline';
  return 'bad_response';
}
