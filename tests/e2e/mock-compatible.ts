import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * An OpenAI-format endpoint stand-in (Chat Completions): `GET /v1/models` lists `models`, and
 * `POST /v1/chat/completions` answers with `respond`'s object as the message's JSON text. `{ status, message? }`
 * replies with that HTTP error instead, in OpenAI's error shape. A request with `stream: true` gets server-sent
 * events: a `CompatStream`'s chunks as content deltas (or any other object as one chunk of JSON text), the finish
 * reason, the usage chunk (the client asks for it with `stream_options.include_usage`) and `[DONE]`.
 */
export type CompatReply = object | { status: number; message?: string } | CompatStream;

export interface CompatStream {
  chunks: string[];
}

/** One request as the endpoint saw it: its JSON body (none for the model list) and its Authorization header. */
export interface CompatRequest {
  path: string;
  body: any;
  authorization: string | undefined;
}

const isStatus = (r: CompatReply): r is { status: number; message?: string } => typeof (r as { status?: unknown }).status === 'number';
const isStream = (r: CompatReply): r is CompatStream => Array.isArray((r as { chunks?: unknown }).chunks);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
};

/** OpenAI's usage shape: 100 input tokens, 20 output. */
const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

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

/** The chunks as Chat Completions streams them, then the finish, the usage-only chunk and [DONE]. */
function sendStream(res: ServerResponse, id: string, model: string, chunks: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS });
  const data = (o: object) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, ...o })}\n\n`);
  data({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (const content of chunks) data({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  data({ choices: [], usage: USAGE });
  res.write('data: [DONE]\n\n');
  res.end();
}

export async function startMockCompatible(
  port: number,
  models: string[],
  respond: (body: any) => Promise<CompatReply>,
): Promise<{ requests: CompatRequest[]; close(): Promise<void> }> {
  const requests: CompatRequest[] = [];
  const state = { requests, close: async () => {} };
  let seq = 0;

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const authorization = req.headers.authorization;
    if (req.method === 'GET' && path === '/v1/models') {
      requests.push({ path, body: null, authorization });
      send(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' })) });
      return;
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') {
      send(res, 404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } });
      return;
    }
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { error: { message: 'bad json', type: 'invalid_request_error', code: null } });
      return;
    }
    requests.push({ path, body, authorization });
    let reply: CompatReply;
    try {
      reply = await respond(body);
    } catch (e) {
      send(res, 500, { error: { message: String(e), type: 'server_error', code: null } });
      return;
    }
    if (isStatus(reply)) {
      send(res, reply.status, { error: { message: reply.message ?? `mock ${reply.status}`, type: 'invalid_request_error', code: null } });
      return;
    }
    const id = `chatcmpl-mock-${++seq}`;
    if (body.stream === true) {
      sendStream(res, id, body.model, isStream(reply) ? reply.chunks : [JSON.stringify(reply)]);
      return;
    }
    send(res, 200, {
      id,
      object: 'chat.completion',
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: 'stop' }],
      usage: USAGE,
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

/** The text of a request's messages with `role`, joined (the system prompt is one message on this path). */
function textOf(body: any, role: string): string {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((m) => m.role === role)
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n');
}

/** The paragraphs a live-check request carries (see buildLiveCheckUser). */
export function compatParagraphs(body: any): { id: string; text: string }[] {
  const m = /<paragraphs>\n([\s\S]*)\n<\/paragraphs>/.exec(textOf(body, 'user'));
  return m ? JSON.parse(m[1]!) : [];
}

export interface CompatReplies {
  /** The fast model's id: the live check answers to it. */
  fast: string;
  /** The smart model's id: rewrites answer to it. */
  smart: string;
  /** The live check's issues for a paragraph's text (default: none). */
  issues?: (text: string) => object[];
  /** Rewrite, variants stage (core/tool-schema.ts VariantsOutputSchema). */
  variants?: string[];
}

/** Answers by model, as the client picks it: the smart model rewrites (critique or variants), the fast model runs the live check. */
export function compatResponder(replies: CompatReplies): (body: any) => Promise<CompatReply> {
  return async (body) => {
    if (body.model === replies.smart) {
      return textOf(body, 'user').includes('Task: critique.')
        ? { weakness: 'It says little.', light_fix: 'It says a little more.' }
        : { variants: replies.variants ?? ['Version one.', 'Version two.', 'Version three.'] };
    }
    return { results: compatParagraphs(body).map((p) => ({ paragraph_id: p.id, issues: replies.issues?.(p.text) ?? [] })) };
  };
}
