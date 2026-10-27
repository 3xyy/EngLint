// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { statusFromError } from '../../src/background/errors';
import { makeClient, streamChat } from '../../src/background/claude';
import { startMockAnthropic, type MockReply } from '../e2e/mock-anthropic';

const PORT = 4987;
const CALL = { system: [{ type: 'text' as const, text: 'x' }], messages: [{ role: 'user' as const, content: 'hi' }] };
let mock: Awaited<ReturnType<typeof startMockAnthropic>> | null = null;

afterEach(async () => {
  await mock?.close();
  mock = null;
});

async function run(reply: MockReply, timeoutMs?: number) {
  mock = await startMockAnthropic(PORT, async () => reply);
  const deltas: string[] = [];
  const s = streamChat(makeClient('sk-test', { baseURL: `http://127.0.0.1:${PORT}` }), CALL, (d) => deltas.push(d), { timeoutMs });
  const t0 = Date.now();
  const outcome = await s.done.then(
    (result) => ({ result, error: null as unknown }),
    (error: unknown) => ({ result: null, error }),
  );
  return { ...outcome, deltas, ms: Date.now() - t0 };
}

describe('streamChat against the mock server', () => {
  it('a finished answer resolves complete', async () => {
    const { result, deltas } = await run({ chunks: ['Try ', 'this.'] });
    expect(deltas).toEqual(['Try ', 'this.']);
    expect(result).toMatchObject({ text: 'Try this.', complete: true });
  });

  it('an answer that stalls after its headers is aborted when the whole-answer time runs out, as a timeout', async () => {
    const { error, deltas, ms } = await run({ chunks: ['Partial'], stall: true }, 300);
    expect(deltas).toEqual(['Partial']);
    expect(error).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(statusFromError(error)).toBe('offline');
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(5000);
  });
});
