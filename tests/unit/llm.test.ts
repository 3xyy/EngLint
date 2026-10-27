import { describe, expect, it } from 'vitest';
import { makeClient, runLiveCheck, startCitationSearch, startToolCall, streamChat, type ToolCall } from '../../src/background/claude';
import { anthropicClient, clientFor } from '../../src/background/llm';
import { DEFAULT_PROVIDER } from '../../src/core/provider';
import { sseBody } from './stream-fakes';

const GOOD = { results: [{ paragraph_id: 'p0', issues: [] }] };
const USAGE = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: 5 };
const REQ = { mode: 'standard' as const, dialect: 'en-US' as const, paragraphs: [{ id: 'p0', text: 'Its a test.' }] };
const TOOL = (kind: ToolCall['kind']): ToolCall => ({
  kind,
  system: [{ type: 'text', text: 'Be brief.' }],
  user: 'Rewrite this.',
  schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
});
const CHAT = { system: [{ type: 'text' as const, text: 'You help.' }], messages: [{ role: 'user' as const, content: 'Hi' }] };

/** A fake fetch that records each request body and answers with GOOD, streamed when the body asks for it. */
function setup() {
  const bodies: unknown[] = [];
  const fakeFetch = (async (_input: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const text = JSON.stringify(GOOD);
    if (body.stream === true) {
      return new Response(sseBody({ model: body.model, content: [{ type: 'text', text }], usage: USAGE, stop_reason: 'end_turn' }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(
      JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  const sdk = makeClient('sk-test', { baseURL: 'https://example.test', fetch: fakeFetch });
  return { bodies, sdk };
}

/** The request bodies `act` sends through the old functions and through the interface; they must be equal. */
async function bothWays(act: (via: 'old' | 'new', sdk: ReturnType<typeof setup>['sdk']) => Promise<unknown>) {
  const old = setup();
  await act('old', old.sdk);
  const next = setup();
  await act('new', next.sdk);
  expect(old.bodies.length).toBeGreaterThan(0);
  expect(next.bodies).toEqual(old.bodies);
}

describe('anthropicClient', () => {
  it('names its models', () => {
    const c = anthropicClient(setup().sdk);
    expect([c.provider, c.fastModel, c.smartModel]).toEqual(['anthropic', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
  });
  it('sends a live check as runLiveCheck does, and says which model answered', async () => {
    await bothWays((via, sdk) => (via === 'old' ? runLiveCheck(sdk, REQ) : anthropicClient(sdk).liveCheck(REQ)));
    const out = await anthropicClient(setup().sdk).liveCheck(REQ);
    expect(out.model).toBe('claude-haiku-5-5');
    expect(out.output).toEqual(GOOD);
  });
  it.each(['synonyms', 'rewrite'] as const)('sends a %s tool call whole as startToolCall does', async (kind) => {
    await bothWays((via, sdk) => (via === 'old' ? startToolCall(sdk, TOOL(kind)).done : anthropicClient(sdk).startToolCall(TOOL(kind)).done));
  });
  it.each(['readers', 'deepCheck'] as const)('sends a %s tool call streamed as startToolCall does', async (kind) => {
    await bothWays((via, sdk) => (via === 'old' ? startToolCall(sdk, TOOL(kind)).done : anthropicClient(sdk).startToolCall(TOOL(kind)).done));
  });
  it('sends a chat as streamChat does, passing the text on', async () => {
    const got: string[] = [];
    await bothWays((via, sdk) => (via === 'old' ? streamChat(sdk, CHAT, () => {}).done : anthropicClient(sdk).streamChat(CHAT, (t) => got.push(t)).done));
    expect(got.join('')).toBe(JSON.stringify(GOOD));
  });
  it('sends a citation search as startCitationSearch does', async () => {
    const call = { system: [{ type: 'text' as const, text: 'Find.' }], user: 'claim' };
    await bothWays((via, sdk) => (via === 'old' ? startCitationSearch(sdk, call).done : anthropicClient(sdk).citations!.start(call).done));
  });
});

describe('clientFor', () => {
  const COMPATIBLE = { preset: 'groq' as const, baseURL: 'https://api.groq.com/openai/v1', fastModel: 'fast-1', smartModel: 'smart-1', structuredOutputs: false, prices: {} };
  it('builds Claude for Anthropic', () => {
    const c = clientFor(DEFAULT_PROVIDER, 'sk-test');
    expect([c.provider, c.fastModel, c.smartModel]).toEqual(['anthropic', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
  });
  it('builds the OpenAI-compatible client, with its models, for a compatible provider', () => {
    const c = clientFor({ active: 'compatible', compatible: COMPATIBLE }, 'sk-test');
    expect([c.provider, c.fastModel, c.smartModel, c.citations]).toEqual(['compatible', 'fast-1', 'smart-1', null]);
  });
  it('refuses a compatible provider that has no settings', () => {
    expect(() => clientFor({ active: 'compatible', compatible: null }, 'sk-test')).toThrow('provider not available');
  });
  it.each([['an unknown active', 'bogus'], ['a missing active', undefined]])('builds nothing for %s, whatever the compatible settings', (_, active) => {
    const tampered = { active, compatible: { ...COMPATIBLE, preset: 'custom', baseURL: 'https://evil.example/v1' } } as unknown as Parameters<typeof clientFor>[0];
    expect(() => clientFor(tampered, 'sk-ant-CLAUDE')).toThrow('provider not available');
  });
});
