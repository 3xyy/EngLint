import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeModelId, ModelId, UsageLike } from '../core/cost';
import { CITATION_MAX_SEARCHES } from '../core/review-cost';
import { LIVE_CHECK_JSON_SCHEMA, type LiveCheckOutput, parseLiveCheckOutput } from '../core/schema';
import type { Dialect, Mode } from '../core/types';
import { buildLiveCheckSystem, buildLiveCheckUser, learnedReminder, type Learned } from './prompts/live-check';

export const LIVE_CHECK_MODEL = 'claude-haiku-5-5' as const;

/** The model's reply was not valid JSON or did not match the schema. The check service maps this to `bad_response`. */
export class LiveCheckParseError extends Error {
  /** The answer's usage and the model that gave it, when the client knows them: the answer was billed all the same. */
  readonly billed?: { usage: UsageLike; model: string };
  constructor(message: string, options?: { cause?: unknown; billed?: { usage: UsageLike; model: string } }) {
    super(message, options);
    this.name = 'LiveCheckParseError';
    this.billed = options?.billed;
  }
}

/**
 * The live check's limits: its output room, and the timeout and retries it runs with (the client's defaults below,
 * which every other request replaces with its own).
 */
export const LIVE_CHECK_SETTINGS = { max_tokens: 8192, timeout: 20_000, maxRetries: 1 } as const;

export function makeClient(apiKey: string, opts: { baseURL?: string; fetch?: typeof fetch } = {}): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: opts.baseURL,
    fetch: opts.fetch,
    dangerouslyAllowBrowser: true,
    maxRetries: LIVE_CHECK_SETTINGS.maxRetries,
    timeout: LIVE_CHECK_SETTINGS.timeout,
  });
}

export async function runLiveCheck(
  client: Anthropic,
  req: { mode: Mode; dialect: Dialect; learned?: Learned; paragraphs: { id: string; text: string }[] },
): Promise<{ output: LiveCheckOutput; usage: UsageLike; truncated: boolean; droppedInvalid: number }> {
  // `create` rather than `parse`: parse() throws on cut-off JSON, and we need the usage
  // from a truncated response (it was billed). We validate the text ourselves below.
  const msg = await client.messages.create({
    model: LIVE_CHECK_MODEL,
    max_tokens: LIVE_CHECK_SETTINGS.max_tokens,
    thinking: { type: 'disabled' },
    system: buildLiveCheckSystem(req.mode, req.dialect, req.learned),
    messages: [{ role: 'user', content: buildLiveCheckUser(req.paragraphs, learnedReminder(req.learned)) }],
    output_config: { format: { type: 'json_schema', schema: LIVE_CHECK_JSON_SCHEMA } },
  });
  const usage: UsageLike = {
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? null,
  };
  if (msg.stop_reason === 'max_tokens') return { output: { results: [] }, usage, truncated: true, droppedInvalid: 0 };

  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    // Issues with an unknown category or severity are dropped one by one (counted in droppedInvalid);
    // only bad JSON or a wrong top-level shape fails the batch.
    return { ...parseLiveCheckOutput(JSON.parse(text)), usage, truncated: false };
  } catch (e) {
    throw new LiveCheckParseError('Claude returned a response that did not match the schema', { cause: e });
  }
}

export const REWRITE_MODEL = 'claude-sonnet-5-5' as const satisfies ClaudeModelId;
export const SYNONYMS_MODEL = 'claude-haiku-5-5' as const satisfies ClaudeModelId;

/** One tools request: the pieces a caller builds; the model and its settings follow from `kind`. */
export interface ToolCall {
  kind: 'rewrite' | 'synonyms' | 'followUp' | 'styleProfile' | 'tone' | 'readers' | 'grader' | 'deepCheck';
  system: Anthropic.TextBlockParam[];
  user: string;
  schema: Record<string, unknown>;
}

// Per-request timeouts: a long rewrite on Sonnet can take well over the live check's 20 s client default.
// Rewrite's max_tokens leaves room for adaptive thinking, which counts toward it even though it isn't
// returned: three versions of a 2,000-character selection need about 1,500 tokens on their own.
// Billing follows the tokens used, not this limit. A popover follow-up gets the same room on Sonnet: asked
// for three new versions of a long selection, it writes as much as a rewrite, plus its message.
//
// `effort` is the output_config effort; `thinkingOff` sends `thinking: disabled` (Sonnet rejects it, Haiku thinks
// by default without it). Reviews: tone is a one-line Haiku read; deep check reads the whole text, so it gets
// medium effort and room for the paragraphs' issues plus notes.
//
// `stream`: readers, grader and deep check can run past 30 s, and a service worker is stopped when a fetch
// response takes longer than that to arrive. Streamed, the response starts at once; `timeout` then bounds the
// whole answer (see streamMessage). The review kinds never retry: a retry would run, and bill, the call again.
interface ToolSetting {
  model: ModelId;
  max_tokens: number;
  timeout: number;
  effort?: 'low' | 'medium';
  thinkingOff?: true;
  stream?: true;
  /** Retries after a failed request, for a call sent whole (default 1). A streamed call never retries. */
  maxRetries?: 0;
}
export const TOOL_SETTINGS: Readonly<Record<ToolCall['kind'], Readonly<ToolSetting>>> = {
  rewrite: { model: REWRITE_MODEL, max_tokens: 4096, timeout: 60_000, effort: 'low' },
  synonyms: { model: SYNONYMS_MODEL, max_tokens: 1024, timeout: 20_000, thinkingOff: true },
  followUp: { model: REWRITE_MODEL, max_tokens: 4096, timeout: 60_000, effort: 'low' },
  styleProfile: { model: REWRITE_MODEL, max_tokens: 2048, timeout: 60_000, effort: 'low' },
  tone: { model: 'claude-haiku-5-5', max_tokens: 256, timeout: 20_000, thinkingOff: true, maxRetries: 0 },
  readers: { model: 'claude-sonnet-5-5', max_tokens: 4096, timeout: 60_000, effort: 'low', stream: true },
  grader: { model: 'claude-sonnet-5-5', max_tokens: 6144, timeout: 90_000, effort: 'low', stream: true },
  deepCheck: { model: 'claude-sonnet-5-5', max_tokens: 12_000, timeout: 120_000, effort: 'medium', stream: true },
};

/** What a tools request answers: the parsed JSON (null when the text isn't JSON), its usage, and whether it was cut off. */
export interface ToolResult {
  data: unknown;
  usage: UsageLike;
  truncated: boolean;
  model: string;
}

/** A billed request on its way. */
export interface BilledRun<T> {
  model: string;
  /** Resolves with the answer; rejects with what the SDK throws (a timeout as APIConnectionTimeoutError). */
  done: Promise<T>;
  /**
   * After `done` rejects: what the request was billed as far as its stream showed, or null when it failed before
   * message_start (or was not streamed), when nothing is known to be billed. See streamMessage.
   */
  spentSoFar(): UsageLike | null;
}

const usageOf = (u: Anthropic.Usage): UsageLike => ({
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
  cache_read_input_tokens: u.cache_read_input_tokens ?? null,
  server_tool_use: u.server_tool_use ? { web_search_requests: u.server_tool_use.web_search_requests ?? 0 } : null,
});

/** About how many characters of English text make one output token, for the spend of a stream that broke. */
export const CHARS_PER_TOKEN = 4;

/**
 * Sends `params` as a stream, so the response starts at once, with no retries. An answer still unfinished after
 * `timeoutMs` is aborted (the SDK's own timeout only covers the wait for the response headers), and `done`
 * rejects with the SDK's timeout error.
 *
 * `spentSoFar`, for a stream that broke after message_start: its input and cache tokens; as output, the larger of
 * the output tokens it reported and the text, thinking and tool input streamed at CHARS_PER_TOKEN (unshown thinking
 * isn't counted, so it is a floor); and as web searches, the larger of the count it reported and the searches
 * whose results arrived.
 */
function streamMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number,
): { done: Promise<Anthropic.Message>; spentSoFar(): UsageLike | null } {
  const stream = client.messages.stream(params, { timeout: timeoutMs, maxRetries: 0 });
  let shown: Anthropic.Message | null = null; // the message as the events built it, kept past the stream's end
  let generated = 0; // characters of text, thinking and tool input received
  stream.on('streamEvent', (event, snapshot) => {
    shown = snapshot;
    if (event.type !== 'content_block_delta') return;
    const d = event.delta;
    if (d.type === 'text_delta') generated += d.text.length;
    else if (d.type === 'thinking_delta') generated += d.thinking.length;
    else if (d.type === 'input_json_delta') generated += d.partial_json.length;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.abort();
  }, timeoutMs);
  const done = stream
    .finalMessage()
    .catch((err: unknown) => {
      throw timedOut ? new Anthropic.APIConnectionTimeoutError({ message: 'The answer took too long.' }) : err;
    })
    .finally(() => clearTimeout(timer));
  return {
    done,
    spentSoFar: () => {
      const m: Anthropic.Message | null = shown;
      if (!m) return null;
      const u = usageOf(m.usage);
      const results = m.content.filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content)).length;
      const searches = Math.max(u.server_tool_use?.web_search_requests ?? 0, results);
      return {
        ...u,
        output_tokens: Math.max(u.output_tokens, Math.ceil(generated / CHARS_PER_TOKEN)),
        server_tool_use: searches > 0 || u.server_tool_use ? { web_search_requests: searches } : null,
      };
    },
  };
}

function toolResult(msg: Anthropic.Message, model: ModelId): ToolResult {
  const usage: UsageLike = {
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? null,
  };
  let data: unknown = null;
  try {
    data = JSON.parse(msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
  } catch {
    // data stays null
  }
  return { data, usage, truncated: msg.stop_reason === 'max_tokens', model };
}

/**
 * Starts a tools request (rewrite, critique, synonyms, follow-ups and the reviews), shared by the background
 * services and the evals: streamed or sent whole as its kind says. Pure: no WXT imports. `timeoutMs` replaces the
 * kind's timeout (for tests).
 */
export function startToolCall(client: Anthropic, call: ToolCall, opts: { timeoutMs?: number } = {}): BilledRun<ToolResult> {
  const { model, max_tokens, timeout, effort, thinkingOff, stream, maxRetries } = TOOL_SETTINGS[call.kind];
  const timeoutMs = opts.timeoutMs ?? timeout;
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens,
    // Sonnet runs adaptive thinking when this is omitted (`disabled` is a 400 there). Haiku 5.5 thinks by
    // default too; `disabled`, valid at its default effort, turns that off for synonyms.
    ...(thinkingOff ? { thinking: { type: 'disabled' as const } } : {}),
    system: call.system,
    messages: [{ role: 'user', content: call.user }],
    output_config: {
      ...(effort ? { effort } : {}),
      format: { type: 'json_schema', schema: call.schema },
    },
  };
  if (stream) {
    const run = streamMessage(client, params, timeoutMs);
    return { model, done: run.done.then((msg) => toolResult(msg, model)), spentSoFar: run.spentSoFar };
  }
  const done = client.messages.create(params, { timeout: timeoutMs, maxRetries: maxRetries ?? 1 }).then((msg) => toolResult(msg, model));
  return { model, done, spentSoFar: () => null };
}

/** A tools request's answer (see startToolCall). Throws what the SDK throws. */
export function runToolCall(client: Anthropic, call: ToolCall): Promise<ToolResult> {
  return startToolCall(client, call).done;
}

export const CHAT_MODEL = REWRITE_MODEL;
// A chat answer is a few short paragraphs, or a short draft in Standard. Adaptive thinking at low effort
// counts toward max_tokens too. The SDK's timeout covers only the request up to the response headers (when a
// stream starts), so streamChat keeps its own timer for the whole answer.
export const CHAT_SETTINGS = { max_tokens: 2048, timeout: 90_000, maxRetries: 1 } as const;

/** One chat request: the system blocks (instructions, document, mode) and the conversation. */
export interface ChatCall {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
}

export interface ChatResult {
  text: string;
  usage: UsageLike;
  /** Only `end_turn` (or a stop sequence) is a finished answer; `max_tokens`, `refusal` and the rest are not. */
  complete: boolean;
  model: string;
}

/** A chat answer streaming in. */
export interface ChatStream {
  /** Resolves when the answer ends; rejects with what the SDK throws (an abort included). */
  done: Promise<ChatResult>;
  abort(): void;
  /**
   * The usage in the stream's message_start event: the input and cache tokens, which are billed once the
   * request starts. It doesn't count the output generated before a stream broke (that arrives only at the end).
   */
  usageSoFar(): UsageLike | null;
}

export const CITATION_MODEL = REWRITE_MODEL;
/**
 * Anthropic's web search tool, run by the API. `allowed_callers: ['direct']` keeps the results as top-level
 * web_search_tool_result blocks; `max_uses` caps the searches, each billed.
 */
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: CITATION_MAX_SEARCHES,
  allowed_callers: ['direct'],
} as const satisfies Anthropic.WebSearchTool20260209;
// No retries: a retry runs, and bills, the searches again. 90 s covers up to three searches and the answer.
const CITATION_SETTINGS = { max_tokens: 4096, timeout: 90_000 } as const;

/** What a citation search answers: the content blocks as they came, the usage with its searches, and the stop reason. */
export interface CitationSearchResult {
  content: Anthropic.ContentBlock[];
  usage: UsageLike;
  stopReason: string | null;
  model: string;
}

/**
 * Starts the Citation finder's request: Sonnet with web search, streamed (see streamMessage) with no retries.
 * Structured outputs can't be used here (they are a 400 alongside citations, and web search always cites), so the
 * caller reads the content blocks themselves. A `pause_turn` is not continued: the caller keeps what came back.
 * Pure: no WXT imports. `timeoutMs` replaces the 90 s (for tests).
 */
export function startCitationSearch(
  client: Anthropic,
  call: { system: Anthropic.TextBlockParam[]; user: string },
  opts: { timeoutMs?: number } = {},
): BilledRun<CitationSearchResult> {
  const run = streamMessage(
    client,
    {
      model: CITATION_MODEL,
      max_tokens: CITATION_SETTINGS.max_tokens,
      system: call.system,
      messages: [{ role: 'user', content: call.user }],
      tools: [WEB_SEARCH_TOOL],
      output_config: { effort: 'low' },
    },
    opts.timeoutMs ?? CITATION_SETTINGS.timeout,
  );
  return {
    model: CITATION_MODEL,
    done: run.done.then((msg) => ({ content: msg.content, usage: usageOf(msg.usage), stopReason: msg.stop_reason, model: CITATION_MODEL })),
    spentSoFar: run.spentSoFar,
  };
}

/** A citation search's answer (see startCitationSearch). Throws what the SDK throws. */
export function runCitationSearch(client: Anthropic, call: { system: Anthropic.TextBlockParam[]; user: string }): Promise<CitationSearchResult> {
  return startCitationSearch(client, call).done;
}

/**
 * Streams a chat answer from Sonnet, calling `onText` with each piece of text as it arrives. Shared by the
 * background chat service and the eval. Pure: no WXT imports. An answer still unfinished after `timeoutMs`
 * (90 s) is aborted, and `done` rejects with the SDK's timeout error.
 */
export function streamChat(
  client: Anthropic,
  call: ChatCall,
  onText: (delta: string) => void,
  opts: { timeoutMs?: number } = {},
): ChatStream {
  const timeoutMs = opts.timeoutMs ?? CHAT_SETTINGS.timeout;
  const stream = client.messages.stream(
    {
      model: CHAT_MODEL,
      max_tokens: CHAT_SETTINGS.max_tokens,
      system: call.system,
      messages: call.messages,
      output_config: { effort: 'low' },
    },
    { timeout: timeoutMs, maxRetries: CHAT_SETTINGS.maxRetries },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.abort();
  }, timeoutMs);
  stream.on('text', (delta) => onText(delta));
  const done = stream
    .finalMessage()
    .then(
      (msg): ChatResult => ({
        text: msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
        usage: usageOf(msg.usage),
        complete: msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence',
        model: CHAT_MODEL,
      }),
      (err: unknown) => {
        throw timedOut ? new Anthropic.APIConnectionTimeoutError({ message: 'The answer took too long.' }) : err;
      },
    )
    .finally(() => clearTimeout(timer));
  return {
    done,
    abort: () => stream.abort(),
    usageSoFar: () => (stream.currentMessage ? usageOf(stream.currentMessage.usage) : null),
  };
}
