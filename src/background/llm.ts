import type Anthropic from '@anthropic-ai/sdk';
import type { UsageLike } from '../core/cost';
import type { ProviderConfig, ProviderId } from '../core/provider';
import type { LiveCheckOutput } from '../core/schema';
import type { Dialect, Mode } from '../core/types';
import {
  LIVE_CHECK_MODEL,
  makeClient,
  REWRITE_MODEL,
  runLiveCheck,
  startCitationSearch,
  startToolCall,
  streamChat,
  type BilledRun,
  type ChatCall,
  type ChatStream,
  type CitationSearchResult,
  type ToolCall,
  type ToolResult,
} from './claude';
import { compatibleClient } from './compatible';
import type { Learned } from './prompts/live-check';

export interface LiveCheckRequest {
  mode: Mode;
  dialect: Dialect;
  learned?: Learned;
  paragraphs: { id: string; text: string }[];
}

export interface LiveCheckReply {
  output: LiveCheckOutput;
  usage: UsageLike;
  truncated: boolean;
  droppedInvalid: number;
  /** The model that answered, for pricing the usage. */
  model: string;
}

/** What the background services need from a model API; one implementation per provider. */
export interface LlmClient {
  provider: ProviderId;
  /** Live checks, synonyms and tone. */
  fastModel: string;
  /** Everything heavier: rewrites, reviews, chat. */
  smartModel: string;
  /** The writer's prices by model id (USD per 1M tokens), for costing usage; Claude's are built in. */
  prices?: Record<string, { input: number; output: number }>;
  liveCheck(req: LiveCheckRequest): Promise<LiveCheckReply>;
  startToolCall(call: ToolCall, opts?: { timeoutMs?: number }): BilledRun<ToolResult>;
  streamChat(call: ChatCall, onText: (text: string) => void): ChatStream;
  /** Web search for the Citation finder; null where the API has none. */
  citations: { start(call: { system: Anthropic.TextBlockParam[]; user: string }): BilledRun<CitationSearchResult> } | null;
}

/** Claude through the Anthropic SDK: the existing request functions, unchanged. */
export function anthropicClient(client: Anthropic): LlmClient {
  return {
    provider: 'anthropic',
    fastModel: LIVE_CHECK_MODEL,
    smartModel: REWRITE_MODEL,
    liveCheck: async (req) => ({ ...(await runLiveCheck(client, req)), model: LIVE_CHECK_MODEL }),
    startToolCall: (call, opts) => startToolCall(client, call, opts),
    streamChat: (call, onText) => streamChat(client, call, onText),
    citations: { start: (call) => startCitationSearch(client, call) },
  };
}

/**
 * The client for the provider in `config`, holding `key` (null only for a provider that needs none). `anthropicBaseURL` replaces Anthropic's address (the e2e
 * build's mock server). Throws when the compatible provider has no settings, or an address it refuses.
 */
export function clientFor(config: ProviderConfig, key: string | null, opts: { anthropicBaseURL?: string } = {}): LlmClient {
  if (config.active === 'anthropic') {
    if (key === null) throw new Error('key missing');
    return anthropicClient(makeClient(key, { baseURL: opts.anthropicBaseURL }));
  }
  if (config.active === 'compatible' && config.compatible) return compatibleClient(config.compatible, key);
  // No compatible settings, or settings it doesn't know: nothing is built, so no key goes anywhere.
  throw new Error('provider not available');
}
