import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A Messages API stand-in: replies with the real Message shape, wrapping `respond`'s object as the JSON text.
 * `{ status, message? }` replies with that HTTP error instead (the API's error body, with `message` if given).
 * `MockBlocks` replies with its content blocks as they are (a web search answer). A request with
 * `stream: true` gets server-sent events instead: a `MockStream`'s chunks as text deltas, a `MockBlocks`'s blocks
 * as the API streams them (see streamEvents), or any other object as one chunk of JSON text.
 */
export type MockReply = object | { status: number; message?: string } | MockStream | MockBlocks;

/** A reply whose content blocks are sent as given, with its usage merged over the default and its stop reason. */
export interface MockBlocks {
  blocks: object[];
  usage?: Record<string, unknown>;
  stopReason?: string;
  /** Streamed only: drops the connection after the blocks, before the message ends (a broken stream). */
  closeEarly?: boolean;
  /** Streamed only: holds the connection open after the blocks, sending nothing more (a stalled stream). */
  stall?: boolean;
}

/** A streamed answer: its text in pieces, and how it ends. */
export interface MockStream {
  chunks: string[];
  /** A pause before each chunk, so a test can watch the text arrive. */
  delayMs?: number;
  /** Drops the connection after the chunks, before the message ends (a broken stream). */
  closeEarly?: boolean;
  /** Holds the connection open after the chunks, sending nothing more (a stalled stream). */
  stall?: boolean;
  /** How the message ends (default end_turn); max_tokens is an answer cut off. */
  stopReason?: 'end_turn' | 'max_tokens';
}

const isStatus = (r: MockReply): r is { status: number; message?: string } =>
  typeof (r as { status?: unknown }).status === 'number';
const isStream = (r: MockReply): r is MockStream => Array.isArray((r as { chunks?: unknown }).chunks);
const isBlocks = (r: MockReply): r is MockBlocks => Array.isArray((r as { blocks?: unknown }).blocks);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': '*',
};

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  429: 'rate_limit_error',
  529: 'overloaded_error',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_USAGE = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** A whole message as the streaming events would build it. */
export interface StreamedMessage {
  id?: string;
  model?: string;
  content: unknown[];
  usage: Record<string, unknown>;
  stop_reason: string;
}

/** One content block's events: its start, then text and a citations_delta per citation, or a tool's input as JSON; then its stop. */
function blockEvents(index: number, block: any): object[] {
  const delta = (d: object) => ({ type: 'content_block_delta', index, delta: d });
  const start = (content_block: object) => ({ type: 'content_block_start', index, content_block });
  const stop = { type: 'content_block_stop', index };
  if (block.type === 'text') {
    return [
      start({ type: 'text', text: '' }),
      ...(block.text ? [delta({ type: 'text_delta', text: block.text })] : []),
      ...(Array.isArray(block.citations) ? block.citations.map((citation: object) => delta({ type: 'citations_delta', citation })) : []),
      stop,
    ];
  }
  if (block.type === 'server_tool_use' || block.type === 'tool_use') {
    return [start({ ...block, input: {} }), delta({ type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }), stop];
  }
  // A web_search_tool_result (and any other block) arrives whole in its start event.
  return [start(block), stop];
}

/**
 * The Messages API's streaming events for a whole message: message_start (with the input usage and 1 output
 * token), each block's events, message_delta (the stop reason, the output tokens and any server tool use) and
 * message_stop.
 */
export function streamEvents(msg: StreamedMessage): object[] {
  const { output_tokens, server_tool_use, ...input } = { ...DEFAULT_USAGE, ...msg.usage } as Record<string, unknown>;
  return [
    {
      type: 'message_start',
      message: {
        id: msg.id ?? 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: msg.model ?? 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...input, output_tokens: 1 },
      },
    },
    ...msg.content.flatMap((block, i) => blockEvents(i, block)),
    {
      type: 'message_delta',
      delta: { stop_reason: msg.stop_reason, stop_sequence: null },
      usage: { output_tokens, ...(server_tool_use ? { server_tool_use } : {}) },
    },
    { type: 'message_stop' },
  ];
}

/** A `MockBlocks` reply as server-sent events, block by block; it can break or stall before the message ends. */
async function sendBlocksStream(res: ServerResponse, body: any, id: string, reply: MockBlocks): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS });
  const events = streamEvents({ id, model: body.model, content: reply.blocks, usage: reply.usage ?? {}, stop_reason: reply.stopReason ?? 'end_turn' }) as {
    type: string;
  }[];
  const send = (e: { type: string }) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const ending = events.splice(-2); // message_delta and message_stop
  for (const e of events) send(e);
  if (reply.stall) return; // the connection stays open until the server closes
  if (reply.closeEarly) {
    await sleep(50); // let the blocks reach the client first
    res.socket?.destroy();
    return;
  }
  for (const e of ending) send(e);
  res.end();
}

/** The Messages API's streaming events: message_start, the text block's start, deltas and stop, message_delta, message_stop. */
async function sendStream(res: ServerResponse, body: any, id: string, reply: MockStream): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS });
  const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const text of reply.chunks) {
    if (reply.delayMs) await sleep(reply.delayMs);
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  }
  if (reply.stall) return; // the connection stays open until the server closes
  if (reply.closeEarly) {
    await sleep(50); // let the chunks reach the client first
    res.socket?.destroy();
    return;
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: reply.stopReason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  event('message_stop', {});
  res.end();
}

export async function startMockAnthropic(
  port: number,
  respond: (body: any) => Promise<MockReply>,
): Promise<{ requests: any[]; responses: number; close(): Promise<void> }> {
  const requests: any[] = [];
  const state = { requests, responses: 0, close: async () => {} };
  let seq = 0;

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
      return;
    }
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } });
      return;
    }
    requests.push(body);
    let reply: MockReply;
    try {
      reply = await respond(body);
    } catch (e) {
      send(res, 500, { type: 'error', error: { type: 'api_error', message: String(e) } });
      return;
    }
    state.responses++;
    if (isStatus(reply)) {
      const type = ERROR_TYPES[reply.status] ?? 'api_error';
      send(res, reply.status, { type: 'error', error: { type, message: reply.message ?? `mock ${reply.status}` } });
      return;
    }
    if (body.stream === true) {
      const id = `msg_mock_${++seq}`;
      if (isBlocks(reply)) await sendBlocksStream(res, body, id, reply);
      else await sendStream(res, body, id, isStream(reply) ? reply : { chunks: [JSON.stringify(reply)] });
      return;
    }
    const blocks = isBlocks(reply) ? reply : null;
    send(res, 200, {
      id: `msg_mock_${++seq}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: blocks ? blocks.blocks : [{ type: 'text', text: JSON.stringify(reply) }],
      stop_reason: blocks?.stopReason ?? 'end_turn',
      stop_sequence: null,
      usage: { ...DEFAULT_USAGE, ...blocks?.usage },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections(); // the worker keeps sockets alive; close() alone would hang
      server.close(() => resolve());
    });
  return state;
}

/** The user message of a request, as text. */
export function userText(body: any): string {
  const content = body?.messages?.[0]?.content;
  return typeof content === 'string' ? content : '';
}

/** The paragraphs a live-check request carries (see buildLiveCheckUser). */
export function paragraphsOf(body: any): { id: string; text: string }[] {
  const m = /<paragraphs>\n([\s\S]*)\n<\/paragraphs>/.exec(userText(body));
  return m ? JSON.parse(m[1]!) : [];
}

/** The rewrite model (background/claude.ts REWRITE_MODEL); synonyms and the live check share Haiku. */
export const SONNET = 'claude-sonnet-5-5';
export const HAIKU = 'claude-haiku-5-5';

export interface ToolsReplies {
  /** Rewrite, variants stage (core/tool-schema.ts VariantsOutputSchema). */
  variants?: string[];
  /** Rewrite, Essay critique stage (CritiqueOutputSchema). */
  critique?: { weakness: string; light_fix: string };
  /** Sound like me, variants stage (core/tool-schema.ts VoiceOutputSchema). */
  voice?: { tells: string[]; final: string };
  /** Synonyms (SynonymsOutputSchema). */
  options?: { text: string; nuance: string }[];
  /** A follow-up in the tools popover (FollowUpOutputSchema). */
  followUp?: { message: string; variants: string[] | null };
  /** Fit a word limit (core/tool-schema.ts WordLimitOutputSchema); a function gets the request's body. */
  wordLimit?: { cuts: { original: string; replacement: string; why: string }[]; version: string } | ((body: any) => object);
  /** The live check's issues for a paragraph's text (default: none). */
  issues?: (text: string) => object[];
  /** The Options page's style profile (core/tool-schema.ts StyleProfileOutputSchema). */
  styleProfile?: { profile: string };
  /** The Review tab's tone line (core/review-schema.ts ToneOutputSchema). */
  tones?: string[];
  /** The Review tab's Reader reactions (core/review-schema.ts ReadersOutputSchema). */
  readers?: object;
  /** The Review tab's Grader (core/review-schema.ts GradingOutputSchema). */
  grading?: object;
  /** The Review tab's Deep check: issues for a paragraph's text (live-check format) and notes about the whole text. */
  deep?: { issues?: (text: string) => object[]; notes?: object[] };
  /** A side-panel chat answer, streamed (see core/chat-format.ts for the text format). */
  chat?: MockStream;
  /** The Review tab's Citation finder: a web search answer (default: webSearchReply()). */
  citations?: MockBlocks;
}

/** The pages the default web search answer returns; its sentinel list also names MADE_UP_URL, which no search returned. */
export const SEARCH_RESULTS = [
  { url: 'https://www.example.org/sleep-memory', title: 'Sleep and Memory Consolidation', page_age: 'April 30, 2025' },
  { url: 'https://learn.example.edu/sleep-learning', title: 'How Sleep Affects Learning', page_age: null },
  { url: 'https://blog.example.net/naps', title: 'Do Naps Help?', page_age: '3 days ago' },
] as const;
export const MADE_UP_URL = 'https://made-up.example/fake-study';

/**
 * A web search answer in the API's shape: one server_tool_use, its web_search_tool_result (SEARCH_RESULTS), text
 * citing the first two results, then the sentinel line and a JSON list of the first two plus MADE_UP_URL. Its
 * usage counts 2 searches. Nothing here reaches the web.
 */
export function webSearchReply(): MockBlocks {
  const [a, b] = SEARCH_RESULTS;
  const cite = (r: (typeof SEARCH_RESULTS)[number], cited_text: string) => ({
    type: 'web_search_result_location',
    url: r.url,
    title: r.title,
    cited_text,
    encrypted_index: 'mock-index',
  });
  const list = [
    { url: a.url, note: 'A study finds sleep strengthens new memories.' },
    { url: MADE_UP_URL, note: 'This page was never returned by the search.' },
    { url: b.url, note: 'An overview of how sleep supports learning.' },
  ];
  return {
    blocks: [
      { type: 'text', text: "I'll search for sources on this claim.", citations: null },
      { type: 'server_tool_use', id: 'srvtoolu_mock_1', name: 'web_search', input: { query: 'sleep memory learning study' }, caller: { type: 'direct' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_mock_1',
        caller: { type: 'direct' },
        content: SEARCH_RESULTS.map((r) => ({ type: 'web_search_result', ...r, encrypted_content: 'mock-content' })),
      },
      { type: 'text', text: 'Researchers found that sleep strengthens new memories.', citations: [cite(a, 'Sleep strengthens newly formed memories.')] },
      { type: 'text', text: ' Sleep also supports learning.', citations: [cite(b, 'Students who slept learned more.')] },
      { type: 'text', text: `\n@@SOURCES@@\n${JSON.stringify(list)}`, citations: null },
    ],
    usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } },
  };
}

/** Whether a Sonnet request asks for the Essay critique (buildRewriteUser's task line). */
export const isCritique = (body: any) => userText(body).includes('Task: critique.');
/** Whether a Sonnet request is Sound like me's variants stage (buildRewriteUser's rw-3 task line). */
export const isVoice = (body: any) => userText(body).includes('Task: sound like the writer.');
export const isSynonyms = (body: any) => userText(body).includes('<synonym_request>');
/** Whether a Sonnet request is Fit a word limit (buildWordLimitUser's task line). */
export const isWordLimit = (body: any) => userText(body).includes('Task: fit a word limit.');
/** A stand-in full version for a word-limit request: the selection's first 95% of the target's words. */
export function fittedVersion(body: any): string {
  const user = userText(body);
  const selection: string = JSON.parse(/<selection>\n([\s\S]*?)\n<\/selection>/.exec(user)![1]!);
  const target = Number(/at most (\d+) words/.exec(user)![1]);
  return selection.split(/\s+/).slice(0, Math.max(1, Math.round(target * 0.95))).join(' ');
}
/** Whether a Sonnet request is a popover follow-up (buildFollowUpUser's task line). */
export const isFollowUp = (body: any) => userText(body).includes('Task: follow-up.');
/** Whether a request builds a style profile: its system text names the prompt version sp-1. */
export const isStyleProfile = (body: any) => JSON.stringify(body?.system ?? '').includes('sp-1');
/** Whether a request is the Review tab's tone read: its system text names the prompt version tn-1. */
export const isTone = (body: any) => JSON.stringify(body?.system ?? '').includes('tn-1');
/** Whether a request is the Review tab's Reader reactions (prompt version rr-1) or Grader (gr-1). */
export const isReaders = (body: any) => JSON.stringify(body?.system ?? '').includes('rr-1');
/** Whether a request is the Review tab's Deep check (prompt version dc-1). */
export const isDeepCheck = (body: any) => JSON.stringify(body?.system ?? '').includes('dc-1');
export const isGrader = (body: any) => JSON.stringify(body?.system ?? '').includes('gr-1');
/** Whether a request is the Review tab's Citation finder (prompt version cf-1). */
export const isCitations = (body: any) => JSON.stringify(body?.system ?? '').includes('cf-1');
/** Whether a request is a side-panel chat turn: streamed, under the chat instructions. */
export const isChat = (body: any) => body?.stream === true && JSON.stringify(body?.system ?? '').includes("EngLint's writing chat");
/** A chat request's newest message (the writer's words). */
export function chatMessage(body: any): string {
  const content = body?.messages?.at(-1)?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Answers a chat turn with the streamed `chat` reply, and the rest by `body.model`: Sonnet with the word-limit JSON
 * for its task line, the follow-up JSON for a follow-up, Sound like me's JSON for its task line, else the rewrite JSON (the critique or the
 * variants, from the task line), Haiku with
 * the synonyms JSON for a synonym request, and otherwise the live check (clean by default).
 */
export function toolsResponder(replies: ToolsReplies = {}): (body: any) => Promise<MockReply> {
  return async (body) => {
    if (isChat(body)) return replies.chat ?? { chunks: ['That reads ', 'clearly.'] };
    if (body.model === SONNET) {
      if (isStyleProfile(body)) return replies.styleProfile ?? { profile: 'Short, plain sentences with concrete nouns.' };
      if (isCitations(body)) return replies.citations ?? webSearchReply();
      if (isDeepCheck(body)) {
        return {
          results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: replies.deep?.issues?.(p.text) ?? [] })),
          notes: replies.deep?.notes ?? [],
        };
      }
      if (isReaders(body)) {
        return (
          replies.readers ?? {
            first_impression: 'A plain, friendly start.',
            remember: ['The short sentences'],
            questions: ['What happens next?'],
            lost: [],
            strength: { quote: 'She runs home', why: 'It moves.' },
          }
        );
      }
      if (isGrader(body)) {
        return replies.grading ?? { criteria: [{ name: 'Clarity', rating: 'solid', evidence: [], raise: 'Say more.' }], grade: null };
      }
      if (isWordLimit(body)) {
        const w = replies.wordLimit;
        return typeof w === 'function' ? w(body) : (w ?? { cuts: [], version: fittedVersion(body) });
      }
      if (isFollowUp(body)) return replies.followUp ?? { message: 'Here is another way to say it.', variants: ['Another version.'] };
      if (isVoice(body)) return replies.voice ?? { tells: ['a staged contrast'], final: 'It sounds like me now.' };
      return isCritique(body)
        ? (replies.critique ?? { weakness: 'It says little.', light_fix: 'It says a little more.' })
        : { variants: replies.variants ?? ['Version one.', 'Version two.', 'Version three.'] };
    }
    if (body.model === HAIKU && isTone(body)) return { tones: replies.tones ?? ['calm'] };
    if (body.model === HAIKU && isSynonyms(body)) {
      return { options: replies.options ?? [{ text: 'word', nuance: 'plain' }] };
    }
    return { results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: replies.issues?.(p.text) ?? [] })) };
  };
}
