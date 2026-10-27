import type Anthropic from '@anthropic-ai/sdk';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  streamText,
  wrapLanguageModel,
  type FinishReason,
  type JSONSchema7,
  type LanguageModelUsage,
  type LogWarningsFunction,
  type ModelMessage,
} from 'ai';
import type { UsageLike } from '../core/cost';
import { endpointOf, PRESETS, validateBaseURL, type CompatibleConfig } from '../core/provider';
import { LIVE_CHECK_JSON_SCHEMA, parseLiveCheckOutput } from '../core/schema';
import {
  CHAT_SETTINGS,
  LIVE_CHECK_MODEL,
  LIVE_CHECK_SETTINGS,
  LiveCheckParseError,
  TOOL_SETTINGS,
  type BilledRun,
  type ChatStream,
  type ToolResult,
} from './claude';
import type { LlmClient } from './llm';
import { buildLiveCheckSystem, buildLiveCheckUser, learnedReminder } from './prompts/live-check';

/**
 * The SDK's warnings, to console.warn, less one: without structured outputs the provider asks for plain JSON
 * (`json_object`) and warns, on every request, that the schema isn't sent. That fallback is intended here: the
 * schema goes into the instructions instead (instructionsFor).
 */
export const logSdkWarnings: LogWarningsFunction = ({ warnings, provider, model }) => {
  for (const warning of warnings) {
    if (warning.type === 'unsupported' && warning.feature === 'responseFormat') continue;
    console.warn('AI SDK warning', { provider, model, warning });
  }
};
globalThis.AI_SDK_LOG_WARNINGS = logSdkWarnings;

/** Reasoning models spend output tokens thinking before they answer, so no request gets less room than this. */
export const MIN_OUTPUT_TOKENS = 4096;
const room = (maxTokens: number) => Math.max(maxTokens, MIN_OUTPUT_TOKENS);

type ChatModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>;

/** One request, before its retries and time limit. */
interface Request {
  model: ChatModel;
  instructions: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  /** The JSON schema the answer follows; none for chat. */
  schema?: Record<string, unknown>;
}

/** An answer: its text (JSON or not; the callers parse it), its usage and why it finished. */
interface Answer {
  text: string;
  usage: UsageLike;
  finishReason: FinishReason;
}

/** The system blocks as one system message: other APIs have no cache breakpoints, so the blocks only join. */
const joined = (blocks: Anthropic.TextBlockParam[]) => blocks.map((b) => b.text).join('\n\n');

/** A message's text, its blocks joined as the system blocks are. */
const textOf = (content: Anthropic.MessageParam['content']) =>
  typeof content === 'string' ? content : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');

const toModelMessage = (m: Anthropic.MessageParam): ModelMessage =>
  m.role === 'user' ? { role: 'user', content: textOf(m.content) } : { role: 'assistant', content: textOf(m.content) };

/**
 * AI SDK usage as the cost functions read it: the input read from the cache split out of the input (a provider
 * bills it at the input price unless the writer prices it), and no cache writes. Missing counts are 0.
 */
export function usageFrom(u: LanguageModelUsage | undefined): UsageLike {
  const input = u?.inputTokens ?? 0;
  const cached = Math.min(u?.inputTokenDetails.cacheReadTokens ?? 0, input);
  return { input_tokens: input - cached, output_tokens: u?.outputTokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached };
}

const outputOf = (schema: Record<string, unknown>) => Output.object({ schema: jsonSchema(schema as JSONSchema7) });

/**
 * The instructions for an endpoint without JSON schema support: the SDK then asks only for JSON (`json_object`) and
 * sends no schema, and the prompts don't name every field (the live check never names `results`), so the schema
 * goes into the instructions. An endpoint with JSON schema support gets it as the response format instead.
 */
function instructionsFor(system: string, schema: Record<string, unknown> | undefined, schemaSupported: boolean): string {
  return schema && !schemaSupported ? `${system}\n\nAnswer with JSON only, matching this JSON schema: ${JSON.stringify(schema)}` : system;
}

/**
 * Sends `req` whole and answers its text, whether or not it parses. With a schema the SDK rejects text that isn't
 * JSON (a length finish cuts JSON off too) with NoObjectGeneratedError, which carries the billed answer: it is
 * answered like any other, for the caller to judge. An answer unfinished after `timeoutMs` is aborted, and the
 * promise rejects with a TimeoutError, unless the time ran out while the SDK waited to retry (a 429's retry-after
 * can outlast it): then with the error that caused the wait, so a rate limit pauses the checks as a rate limit.
 */
async function generate(req: Request, maxRetries: number, timeoutMs: number): Promise<Answer> {
  const { schema, model, ...call } = req;
  const signal = AbortSignal.timeout(timeoutMs);
  let lastError: unknown; // each attempt's error, kept by the wrapper below (the SDK's retries run inside it)
  try {
    const r = await generateText({
      ...call,
      model: wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: 'v4',
          wrapGenerate: async ({ doGenerate }) => {
            try {
              return await doGenerate();
            } catch (err) {
              lastError = err;
              throw err;
            }
          },
        },
      }),
      ...(schema ? { output: outputOf(schema) } : {}),
      maxRetries,
      abortSignal: signal,
    });
    return { text: r.text, usage: usageFrom(r.usage), finishReason: r.finishReason };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) return { text: err.text ?? '', usage: usageFrom(err.usage), finishReason: err.finishReason ?? 'other' };
    // Timed out during a request, the last error is the abort itself; during the wait, the endpoint's answer.
    if (signal.aborted && APICallError.isInstance(lastError)) throw lastError;
    throw err;
  }
}

/**
 * Streams `req`, so the response starts at once (a service worker is stopped when a fetch response takes over 30 s
 * to arrive), passing each piece of text to `onText`. An answer still unfinished after `timeoutMs` is aborted, and
 * `done` rejects with a TimeoutError; `abort()` rejects it with an AbortError. The stream's parts are read here
 * rather than through the result's promises: a failed request reaches those as a bare NoOutputGeneratedError, and
 * here as the error itself. `usageSoFar` is the usage once the stream's finish part has arrived, or null: a stream
 * that breaks before then shows nothing billed.
 */
function stream(req: Request, maxRetries: number, timeoutMs: number, onText?: (text: string) => void) {
  const { schema, ...call } = req;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The answer took too long.', 'TimeoutError')), timeoutMs);
  let usage: UsageLike | null = null;
  const result = streamText({
    ...call,
    ...(schema ? { output: outputOf(schema) } : {}),
    maxRetries,
    abortSignal: controller.signal,
    onError: () => {}, // the error part below carries it; the SDK would otherwise log it, prompt text included
  });
  const done = (async (): Promise<Answer> => {
    let text = '';
    let finishReason: FinishReason | null = null;
    let failure: { error: unknown } | null = null;
    try {
      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          text += part.text;
          onText?.(part.text);
        } else if (part.type === 'finish') {
          usage = usageFrom(part.totalUsage);
          finishReason = part.finishReason;
        } else if (part.type === 'error') failure ??= { error: part.error };
        else if (part.type === 'abort') throw controller.signal.reason;
      }
    } catch (err) {
      throw controller.signal.aborted ? controller.signal.reason : err;
    }
    if (failure) throw failure.error;
    if (finishReason === null || usage === null) throw new Error('The answer ended without finishing.');
    return { text, usage, finishReason };
  })().finally(() => clearTimeout(timer));
  return { done, abort: () => controller.abort(), usageSoFar: (): UsageLike | null => usage };
}

function toolResult(a: Answer, model: string): ToolResult {
  let data: unknown = null;
  try {
    data = JSON.parse(a.text);
  } catch {
    // data stays null
  }
  return { data, usage: a.usage, truncated: a.finishReason === 'length', model };
}

/** OpenAI's reasoning models refuse `max_tokens`; its API takes `max_completion_tokens` for every chat model. */
function asCompletionTokens(body: Record<string, unknown>): Record<string, unknown> {
  const { max_tokens, ...rest } = body;
  return max_tokens === undefined ? rest : { ...rest, max_completion_tokens: max_tokens };
}

/**
 * Any OpenAI-compatible endpoint through the AI SDK: the same prompts as Claude's, with the system blocks joined
 * and no Claude-only settings (cache breakpoints, thinking, effort). Each kind keeps Claude's output room (at least
 * MIN_OUTPUT_TOKENS), time limit, retries and streaming; the kinds Claude runs on Haiku run on the fast model, the
 * rest on the smart one. The answers are parsed as on the Anthropic path. An endpoint without JSON schema support is
 * told the schema in its instructions.
 *
 * A fixed preset's address and JSON support come from PRESETS, never from the stored settings, so its key only
 * ever goes to its own endpoint; only a custom endpoint uses the stored ones. A preset that needs no key is never
 * sent one. Throws for an address that isn't https (or http on this computer).
 */
export function compatibleClient(config: CompatibleConfig, key: string | null, opts: { fetch?: typeof fetch } = {}): LlmClient {
  const preset = PRESETS[config.preset];
  const custom = config.preset === 'custom';
  const baseURL = endpointOf(config);
  const checked = validateBaseURL(baseURL);
  if (!checked.ok) throw new Error(checked.reason);
  const schemaSupported = custom ? config.structuredOutputs : preset.structuredOutputs;
  const provider = createOpenAICompatible({
    name: 'compatible',
    baseURL,
    apiKey: preset.needsKey ? (key ?? undefined) : undefined,
    includeUsage: true,
    supportsStructuredOutputs: schemaSupported,
    transformRequestBody: config.preset === 'openai' ? asCompletionTokens : undefined,
    fetch: opts.fetch,
  });
  const model = (id: string) => provider.chatModel(id);

  return {
    provider: 'compatible',
    fastModel: config.fastModel,
    smartModel: config.smartModel,
    prices: config.prices,

    async liveCheck(req) {
      const a = await generate(
        {
          model: model(config.fastModel),
          instructions: instructionsFor(joined(buildLiveCheckSystem(req.mode, req.dialect, req.learned)), LIVE_CHECK_JSON_SCHEMA, schemaSupported),
          messages: [{ role: 'user', content: buildLiveCheckUser(req.paragraphs, learnedReminder(req.learned)) }],
          maxOutputTokens: room(LIVE_CHECK_SETTINGS.max_tokens),
          schema: LIVE_CHECK_JSON_SCHEMA,
        },
        LIVE_CHECK_SETTINGS.maxRetries,
        LIVE_CHECK_SETTINGS.timeout,
      );
      const billed = { usage: a.usage, model: config.fastModel };
      // A reasoning model can spend the whole budget thinking: a length finish, with or without text, is cut off.
      if (a.finishReason === 'length') return { ...billed, output: { results: [] }, truncated: true, droppedInvalid: 0 };
      try {
        return { ...billed, ...parseLiveCheckOutput(JSON.parse(a.text)), truncated: false };
      } catch (e) {
        // Billed all the same: the service records it (an endpoint without JSON schema misses more often than Claude).
        throw new LiveCheckParseError('The model returned a response that did not match the schema', { cause: e, billed });
      }
    },

    startToolCall(call, opts = {}): BilledRun<ToolResult> {
      const { model: claudeModel, max_tokens, timeout, stream: streamed, maxRetries } = TOOL_SETTINGS[call.kind];
      const id = claudeModel === LIVE_CHECK_MODEL ? config.fastModel : config.smartModel;
      const req: Request = {
        model: model(id),
        instructions: instructionsFor(joined(call.system), call.schema, schemaSupported),
        messages: [{ role: 'user', content: call.user }],
        maxOutputTokens: room(max_tokens),
        schema: call.schema,
      };
      const timeoutMs = opts.timeoutMs ?? timeout;
      if (streamed) {
        // A streamed call never retries: a retry would run, and bill, the call again.
        const run = stream(req, 0, timeoutMs);
        return { model: id, done: run.done.then((a) => toolResult(a, id)), spentSoFar: run.usageSoFar };
      }
      return { model: id, done: generate(req, maxRetries ?? 1, timeoutMs).then((a) => toolResult(a, id)), spentSoFar: () => null };
    },

    streamChat(call, onText): ChatStream {
      const run = stream(
        {
          model: model(config.smartModel),
          instructions: joined(call.system),
          messages: call.messages.map(toModelMessage),
          maxOutputTokens: room(CHAT_SETTINGS.max_tokens),
        },
        CHAT_SETTINGS.maxRetries,
        CHAT_SETTINGS.timeout,
        onText,
      );
      return {
        done: run.done.then((a) => ({ text: a.text, usage: a.usage, complete: a.finishReason === 'stop', model: config.smartModel })),
        abort: run.abort,
        usageSoFar: run.usageSoFar,
      };
    },

    citations: null,
  };
}
