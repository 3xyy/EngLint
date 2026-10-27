import Anthropic from '@anthropic-ai/sdk';
import { anthropicClient } from '../../src/background/llm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { clearChat, loadChat } from '../../src/background/chat-store';
import { createChatService, watchTabsForChat } from '../../src/background/chat-service';
import { setStoredKey } from '../../src/background/key-store';
import { applyIssuesUpdate, setTabOff } from '../../src/background/tab-state';
import { getMonthSpend } from '../../src/background/usage';
import type { ChatServerMessage, ChatTurn } from '../../src/core/chat-format';
import { costFromUsage } from '../../src/core/cost';
import { capUsdItem, disabledSitesItem, spendItem } from '../../src/shared/settings';

const USAGE = { input_tokens: 3000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const START_USAGE = { input_tokens: 3000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const clock = new Date(2026, 9, 22, 12, 0, 0);

interface Script {
  deltas?: string[];
  stop_reason?: string;
  /** Rejects with this, after `errorAfter` deltas (default: after all of them). */
  error?: unknown;
  errorAfter?: number;
  /** Waits for `release()` before finishing. */
  hold?: boolean;
  /** Fails before message_start: no usage is ever reported. */
  failBeforeStart?: unknown;
}

/** A stand-in for the SDK's MessageStream: `on('text')`, `finalMessage()`, `abort()` and `currentMessage`. */
function fakeStream(script: Script) {
  const listeners: ((d: string) => void)[] = [];
  let rejectFinal: (e: unknown) => void = () => {};
  let release: () => void = () => {};
  const gate = script.hold ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  let aborted = false;
  const s = {
    currentMessage: undefined as undefined | { usage: typeof START_USAGE },
    /** Set as the answer finishes. */
    finished: false,
    on(event: string, cb: (d: string) => void) {
      if (event === 'text') listeners.push(cb);
      return s;
    },
    abort: vi.fn(() => {
      aborted = true;
      rejectFinal(new Anthropic.APIUserAbortError());
    }),
    finalMessage: () =>
      new Promise((resolve, reject) => {
        rejectFinal = reject;
        void (async () => {
          await Promise.resolve();
          if (script.failBeforeStart) return reject(script.failBeforeStart);
          s.currentMessage = { usage: START_USAGE };
          const deltas = script.deltas ?? [];
          for (const [i, d] of deltas.entries()) {
            if (aborted) return;
            if (script.error && i === script.errorAfter) return reject(script.error);
            listeners.forEach((cb) => cb(d));
            await Promise.resolve();
          }
          await gate;
          if (aborted) return;
          if (script.error) return reject(script.error);
          s.finished = true;
          resolve({ content: [{ type: 'text', text: deltas.join('') }], stop_reason: script.stop_reason ?? 'end_turn', usage: USAGE });
        })();
      }),
    release: () => release(),
  };
  return s;
}

const ORIGIN = 'chrome-extension://pfkhcgfebppldojflbbnoffdphlcnhjk/';
const PANEL = `${ORIGIN}sidepanel.html`;

function setup(script: Script = { deltas: ['Try ', 'this.'] }, tabUrl: string | null = 'https://mail.example.com/inbox', now: () => Date = () => clock) {
  const streams: ReturnType<typeof fakeStream>[] = [];
  const stream = vi.fn((_params: Record<string, any>, _opts?: Record<string, any>) => {
    const s = fakeStream(script);
    streams.push(s);
    return s;
  });
  const svc = createChatService({
    getApiKey: async () => (await storage.getItem<string>('local:k')) ?? null,
    makeClient: () => anthropicClient(({ messages: { stream } }) as unknown as Anthropic),
    now,
    tabUrl: async () => tabUrl,
    extensionOrigin: ORIGIN,
  });
  return { svc, stream, streams };
}

/** A runtime.Port stand-in, from the side panel by default. Like Chrome's, it throws when used after a disconnect. */
function fakePort(name = 'englint-chat', sender: { url?: string; tab?: object } = { url: PANEL }) {
  const sent: ChatServerMessage[] = [];
  const onMsg: ((m: unknown) => void)[] = [];
  const onGone: (() => void)[] = [];
  let gone = false;
  const port = {
    name,
    sender,
    postMessage(m: ChatServerMessage) {
      if (gone) throw new Error('Attempting to use a disconnected port object');
      sent.push(m);
    },
    onMessage: { addListener: (cb: (m: unknown) => void) => onMsg.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => onGone.push(cb) },
  };
  return {
    port,
    sent,
    send: (m: unknown) => onMsg.forEach((cb) => cb(m)),
    disconnect: () => {
      gone = true;
      onGone.forEach((cb) => cb());
    },
  };
}

const send = (over: Record<string, unknown> = {}) => ({
  type: 'send', tabId: 7, fieldId: 'f-a', mode: 'standard', text: 'Dear Sam, thanks for the notes.', focus: null, message: 'Is this friendly?', ...over,
});
const lastIsFinal = (sent: ChatServerMessage[]) => {
  const t = sent.at(-1)?.type;
  expect(t === 'done' || t === 'status').toBe(true);
};
const settle = (p: { sent: ChatServerMessage[] }) => vi.waitFor(() => lastIsFinal(p.sent));
const pairs = (n: number): ChatTurn[] =>
  Array.from({ length: n }, (_, i) => [{ role: 'user' as const, text: `q${i}` }, { role: 'assistant' as const, text: `a${i}` }]).flat();

beforeEach(async () => {
  fakeBrowser.reset();
  indexedDB.deleteDatabase('englint');
  await setStoredKey('anthropic', 'sk-test');
  await storage.setItem('local:k', 'sk-test');
});

describe('chat service: a turn', () => {
  it('forwards the deltas, then done with the parsed edits', async () => {
    const { svc } = setup({ deltas: ['Try ', 'this.\n@@ED', 'ITS@@\n[{"original":"Dear Sam","replacement":"Hi Sam"}]'] });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent.filter((m) => m.type === 'delta').map((m) => (m as { text: string }).text)).toEqual([
      'Try ', 'this.\n@@ED', 'ITS@@\n[{"original":"Dear Sam","replacement":"Hi Sam"}]',
    ]);
    expect(p.sent.at(-1)).toEqual({ type: 'done', message: 'Try this.', edits: [{ original: 'Dear Sam', replacement: 'Hi Sam' }] });
  });

  it('calls Sonnet with low effort, 2048 max tokens, a 90 s timeout, the system blocks and the history', async () => {
    await storage.setItem('session:chat:7:f-a', pairs(1));
    const { svc, stream } = setup();
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ text: 'Dear Sam </document>', message: '  Shorter?  ' }));
    await settle(p);
    const [params, opts] = stream.mock.calls[0]!;
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.max_tokens).toBe(2048);
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params).not.toHaveProperty('thinking');
    expect(opts!.timeout).toBe(90_000);
    expect(params.system).toHaveLength(3);
    expect(params.system[1].text).toContain('Dear Sam \\u003c/document>');
    expect(params.messages).toEqual([
      { role: 'user', content: 'q0' },
      { role: 'assistant', content: [{ type: 'text', text: 'a0', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'Shorter?' },
    ]);
  });

  it('records the spend from the final usage', async () => {
    const { svc } = setup();
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(await getMonthSpend(clock)).toBeCloseTo(costFromUsage('claude-sonnet-5-5', USAGE), 10);
  });

  it('appends the turn pair under chat:<tabId>:<fieldId>', async () => {
    const { svc } = setup({ deltas: ['Fine.\n@@EDITS@@\n[{"original":"a","replacement":"b"}]'] });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ message: ' Is it ok? ' }));
    await settle(p);
    const stored = (await browser.storage.session.get('chat:7:f-a'))['chat:7:f-a'];
    expect(stored).toEqual([
      { role: 'user', text: 'Is it ok?' },
      { role: 'assistant', text: 'Fine.', edits: [{ original: 'a', replacement: 'b' }] },
    ]);
    expect(await loadChat(7, 'f-a')).toEqual(stored);
    expect(await loadChat(7, 'f-other')).toEqual([]);
  });

  it('keeps the last 20 pairs', async () => {
    await storage.setItem('session:chat:7:f-a', pairs(20));
    const { svc } = setup({ deltas: ['Newest.'] });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ message: 'q-new' }));
    await settle(p);
    const turns = await loadChat(7, 'f-a');
    expect(turns).toHaveLength(40);
    expect(turns[0]).toEqual({ role: 'user', text: 'q1' });
    expect(turns.slice(-2)).toEqual([{ role: 'user', text: 'q-new' }, { role: 'assistant', text: 'Newest.' }]);
  });

  it('ignores a port from a content script', async () => {
    const { svc, stream } = setup();
    const p = fakePort('englint-chat', { url: 'https://mail.example.com/', tab: { id: 7 } });
    svc.connect(p.port);
    p.send(send());
    p.send({ type: 'reset', tabId: 7, fieldId: 'f-a' });
    p.send({ type: 'send', tabId: 7 });
    await new Promise((r) => setTimeout(r, 20));
    expect(p.sent).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  });

  it('sends the selected text before the writer\'s message, escaped, and keeps only the message', async () => {
    const text = 'Dear Sam, thanks for the <b>notes</b>. See you soon.';
    const start = text.indexOf('thanks');
    const end = text.indexOf('.') + 1;
    const { svc, stream } = setup({ deltas: ['Yes.'] });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ text, focus: { start, end }, message: 'Is this warm enough?' }));
    await settle(p);
    const last = stream.mock.calls[0]![0].messages.at(-1);
    expect(last.role).toBe('user');
    expect(last.content).toBe(`<selection>\n${JSON.stringify('thanks for the <b>notes</b>.').replace(/</g, '\\u003c')}\n</selection>\nIs this warm enough?`);
    expect((await loadChat(7, 'f-a'))[0]).toEqual({ role: 'user', text: 'Is this warm enough?' });
  });

  it('cuts a selection over 4,000 characters, with an ellipsis', async () => {
    const text = 'a'.repeat(5000);
    const { svc, stream } = setup({ deltas: ['Long.'] });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ text, focus: { start: 0, end: 5000 } }));
    await settle(p);
    const content: string = stream.mock.calls[0]![0].messages.at(-1).content;
    expect(content).toContain(JSON.stringify(`${'a'.repeat(3999)}…`));
    expect(content).not.toContain('a'.repeat(4000));
  });

  it('sends no selection for a caret', async () => {
    const { svc, stream } = setup({ deltas: ['Yes.'] });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ focus: { start: 4, end: 4 } }));
    await settle(p);
    expect(stream.mock.calls[0]![0].messages.at(-1).content).toBe('Is this friendly?');
  });

  it('ignores a port with another name', async () => {
    const { svc, stream } = setup();
    const p = fakePort('englint-other');
    svc.connect(p.port);
    p.send(send());
    await new Promise((r) => setTimeout(r, 20));
    expect(p.sent).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('chat service: refusals before any call', () => {
  it.each([
    ['paused_cap', async () => { await capUsdItem.setValue(1); await spendItem.setValue({ '2026-10': 1 }); }],
    ['key_missing', async () => { await storage.removeItem('local:k'); }],
    ['off_site', async () => { await disabledSitesItem.setValue(['mail.example.com']); }],
  ] as const)('%s gives that status and makes no call', async (status, arrange) => {
    await arrange();
    const { svc, stream } = setup();
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent).toEqual([{ type: 'status', status }]);
    expect(stream).not.toHaveBeenCalled();
  });

  it('off_site from the host the tab\'s fields reported when Chrome hides the tab\'s URL', async () => {
    await disabledSitesItem.setValue(['mail.example.com']);
    await applyIssuesUpdate(7, { fieldId: 'f-a', host: 'mail.example.com', mode: 'standard', status: 'ok', focused: true, issues: [] }, 0);
    const { svc, stream } = setup(undefined, null);
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent).toEqual([{ type: 'status', status: 'off_site' }]);
    expect(stream).not.toHaveBeenCalled();
  });

  it('off_site when the host is unknown and the tab says its site is off', async () => {
    await setTabOff(7, true);
    const { svc, stream } = setup(undefined, null);
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent).toEqual([{ type: 'status', status: 'off_site' }]);
    expect(stream).not.toHaveBeenCalled();
  });

  it('refuses a message over 2,000 characters, or a blank one, with bad_response', async () => {
    const { svc, stream } = setup();
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ message: 'x'.repeat(2001) }));
    await settle(p);
    p.send(send({ message: '   ' }));
    await vi.waitFor(() => expect(p.sent).toHaveLength(2));
    expect(p.sent).toEqual([{ type: 'status', status: 'bad_response' }, { type: 'status', status: 'bad_response' }]);
    expect(stream).not.toHaveBeenCalled();
  });

  it('accepts a message of exactly 2,000 characters', async () => {
    const { svc, stream } = setup();
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ message: 'x'.repeat(2000) }));
    await settle(p);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed message with bad_response', async () => {
    const { svc, stream } = setup();
    const p = fakePort();
    svc.connect(p.port);
    p.send({ type: 'send', tabId: 7 });
    await settle(p);
    expect(p.sent).toEqual([{ type: 'status', status: 'bad_response' }]);
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('chat service: a broken stream', () => {
  it('a stream that drops mid-way sends offline, keeps nothing and bills what it reported', async () => {
    const drop = new Anthropic.APIConnectionError({ message: 'network' });
    const { svc } = setup({ deltas: ['Half ', 'an ', 'answer'], error: drop, errorAfter: 2 });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent).toEqual([{ type: 'delta', text: 'Half ' }, { type: 'delta', text: 'an ' }, { type: 'status', status: 'offline' }]);
    expect(await loadChat(7, 'f-a')).toEqual([]);
    // 'Half an ' is 8 characters: a floor of 2 output tokens on top of message_start's input.
    expect(await getMonthSpend(clock)).toBeCloseTo(costFromUsage('claude-sonnet-5-5', { ...START_USAGE, output_tokens: 2 }), 10);
  });

  it('an overloaded error event mid-stream sends overloaded', async () => {
    const overloaded = new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(), 'overloaded_error');
    const { svc } = setup({ deltas: ['Half '], error: overloaded, errorAfter: 1 });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent.at(-1)).toEqual({ type: 'status', status: 'overloaded' });
    expect(await loadChat(7, 'f-a')).toEqual([]);
  });

  it('an answer cut off at max_tokens is reported and not kept, but billed', async () => {
    const { svc } = setup({ deltas: ['A long answer that'], stop_reason: 'max_tokens' });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent).toEqual([{ type: 'delta', text: 'A long answer that' }, { type: 'status', status: 'bad_response' }]);
    expect(await loadChat(7, 'f-a')).toEqual([]);
    expect(await getMonthSpend(clock)).toBeCloseTo(costFromUsage('claude-sonnet-5-5', USAGE), 10);
  });

  it('an empty answer is bad_response and not kept', async () => {
    const { svc } = setup({ deltas: ['  '] });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent.at(-1)).toEqual({ type: 'status', status: 'bad_response' });
    expect(await loadChat(7, 'f-a')).toEqual([]);
  });

  it('a disconnected port aborts the stream, sends nothing more and keeps nothing', async () => {
    const { svc, streams } = setup({ deltas: ['Partial'], hold: true });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(p.sent).toEqual([{ type: 'delta', text: 'Partial' }]));
    p.disconnect();
    expect(streams[0]!.abort).toHaveBeenCalledTimes(1);
    streams[0]!.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.sent).toEqual([{ type: 'delta', text: 'Partial' }]);
    expect(await loadChat(7, 'f-a')).toEqual([]);
    // 'Partial' is 7 characters: a floor of 2 output tokens.
    expect(await getMonthSpend(clock)).toBeCloseTo(costFromUsage('claude-sonnet-5-5', { ...START_USAGE, output_tokens: 2 }), 10);
  });
});

describe('chat service: the spend of a stopped answer', () => {
  // About 4 characters a token: 400 + 401 characters streamed is a floor of 201 output tokens.
  const TEXT = ['x'.repeat(400), 'y'.repeat(401)];
  const FLOOR = { ...START_USAGE, output_tokens: 201 };
  const billed = () => getMonthSpend(clock);

  it('a dropped connection bills message_start\'s input and a floor for the text streamed', async () => {
    const { svc } = setup({ deltas: [...TEXT, 'never sent'], error: new Anthropic.APIConnectionError({ message: 'network' }), errorAfter: 2 });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent.at(-1)).toEqual({ type: 'status', status: 'offline' });
    expect(await billed()).toBeCloseTo(costFromUsage('claude-sonnet-5-5', FLOOR), 10);
  });

  it('an answer stopped by New chat bills the floor too', async () => {
    const { svc, streams } = setup({ deltas: TEXT, hold: true });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(p.sent).toHaveLength(2));
    p.send({ type: 'reset', tabId: 7, fieldId: 'f-a' });
    await vi.waitFor(() => expect(streams[0]!.abort).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await billed()).toBeCloseTo(costFromUsage('claude-sonnet-5-5', FLOOR), 10));
  });

  it('an answer stopped by a newer send bills the floor too', async () => {
    const { svc, streams } = setup({ deltas: TEXT, hold: true });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(p.sent).toHaveLength(2));
    p.send(send({ message: 'Another question.' }));
    await vi.waitFor(() => expect(streams[0]!.abort).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await billed()).toBeCloseTo(costFromUsage('claude-sonnet-5-5', FLOOR), 10));
  });

  it('an answer that stalls for 90 s bills the floor too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { svc } = setup({ deltas: TEXT, hold: true });
      const p = fakePort();
      svc.connect(p.port);
      p.send(send());
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.advanceTimersByTimeAsync(10);
      expect(p.sent.at(-1)).toEqual({ type: 'status', status: 'offline' });
      expect(await billed()).toBeCloseTo(costFromUsage('claude-sonnet-5-5', FLOOR), 10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stream that fails before message_start records nothing', async () => {
    const { svc } = setup({ failBeforeStart: new Anthropic.APIConnectionError({ message: 'network' }) });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(p.sent).toEqual([{ type: 'status', status: 'offline' }]);
    expect(await billed()).toBe(0);
  });
});

describe('chat service: a stalled or overtaken answer', () => {
  it('aborts an answer that stalls for 90 s and reports it, keeping nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { svc, streams } = setup({ deltas: ['Partial'], hold: true });
      const p = fakePort();
      svc.connect(p.port);
      p.send(send());
      await vi.advanceTimersByTimeAsync(89_000);
      expect(p.sent).toEqual([{ type: 'delta', text: 'Partial' }]);
      expect(streams[0]!.abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(streams[0]!.abort).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(p.sent).toEqual([{ type: 'delta', text: 'Partial' }, { type: 'status', status: 'offline' }]);
      expect(await loadChat(7, 'f-a')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('posts no done when a reset arrives while the spend is being recorded', async () => {
    let p!: ReturnType<typeof fakePort>;
    let streams!: ReturnType<typeof setup>['streams'];
    let resetSent = false;
    const now = () => {
      // The answer has finished and the service is about to record its spend.
      if (streams?.[0]?.finished && !resetSent) {
        resetSent = true;
        p.send({ type: 'reset', tabId: 7, fieldId: 'f-a' });
      }
      return clock;
    };
    const s = setup({ deltas: ['Late answer.'] }, undefined, now);
    streams = s.streams;
    p = fakePort();
    s.svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(resetSent).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(p.sent).toEqual([{ type: 'delta', text: 'Late answer.' }]);
    expect(await loadChat(7, 'f-a')).toEqual([]);
    expect(await getMonthSpend(clock)).toBeCloseTo(costFromUsage('claude-sonnet-5-5', USAGE), 10);
  });

  it('posts no done when a reset arrives while the turn is being stored', async () => {
    const { svc } = setup({ deltas: ['Stored, then cleared.'] });
    const p = fakePort();
    let resetSent = false;
    const unwatch = storage.watch('session:chat:7:f-a', (v) => {
      if (v && !resetSent) {
        resetSent = true;
        p.send({ type: 'reset', tabId: 7, fieldId: 'f-a' });
      }
    });
    try {
      svc.connect(p.port);
      p.send(send());
      await vi.waitFor(() => expect(resetSent).toBe(true));
      await new Promise((r) => setTimeout(r, 20));
      expect(p.sent).toEqual([{ type: 'delta', text: 'Stored, then cleared.' }]);
      await vi.waitFor(async () => expect(await loadChat(7, 'f-a')).toEqual([]));
    } finally {
      unwatch();
    }
  });

  it('posts only the newer done when a new send arrives while the spend is being recorded', async () => {
    let p!: ReturnType<typeof fakePort>;
    let streams!: ReturnType<typeof setup>['streams'];
    let resent = false;
    const now = () => {
      if (streams?.[0]?.finished && !resent) {
        resent = true;
        p.send(send({ message: 'Second question' }));
      }
      return clock;
    };
    const s = setup({ deltas: ['An answer.'] }, undefined, now);
    streams = s.streams;
    p = fakePort();
    s.svc.connect(p.port);
    p.send(send({ message: 'First question' }));
    await vi.waitFor(() => expect(s.stream).toHaveBeenCalledTimes(2));
    await settle(p);
    await new Promise((r) => setTimeout(r, 20));
    expect(p.sent.filter((m) => m.type === 'done')).toHaveLength(1);
    expect((await loadChat(7, 'f-a')).map((t) => t.text)).toEqual(['Second question', 'An answer.']);
  });
});

describe('chat service: clearing', () => {
  it('reset clears that field\'s chat only', async () => {
    await storage.setItem('session:chat:7:f-a', pairs(2));
    await storage.setItem('session:chat:7:f-b', pairs(1));
    const { svc } = setup();
    const p = fakePort();
    svc.connect(p.port);
    p.send({ type: 'reset', tabId: 7, fieldId: 'f-a' });
    await vi.waitFor(async () => expect(await loadChat(7, 'f-a')).toEqual([]));
    expect(await loadChat(7, 'f-b')).toHaveLength(2);
    expect(p.sent).toEqual([]);
  });

  it('reset during a stream aborts it quietly and the answer is not kept', async () => {
    const { svc, streams } = setup({ deltas: ['Partial'], hold: true });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(p.sent).toHaveLength(1));
    p.send({ type: 'reset', tabId: 7, fieldId: 'f-a' });
    await vi.waitFor(() => expect(streams[0]!.abort).toHaveBeenCalled());
    streams[0]!.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.sent).toEqual([{ type: 'delta', text: 'Partial' }]);
    expect(await loadChat(7, 'f-a')).toEqual([]);
  });

  it('a reset for another field leaves the answer streaming alone: it finishes, is kept and its done is posted', async () => {
    await storage.setItem('session:chat:7:f-b', pairs(1));
    const { svc, streams } = setup({ deltas: ['About the first box.'], hold: true });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(p.sent).toHaveLength(1));
    p.send({ type: 'reset', tabId: 7, fieldId: 'f-b' });
    await vi.waitFor(async () => expect(await loadChat(7, 'f-b')).toEqual([]));
    streams[0]!.release();
    await settle(p);
    expect(streams[0]!.abort).not.toHaveBeenCalled();
    expect(p.sent.at(-1)).toEqual({ type: 'done', message: 'About the first box.', edits: [] });
    expect((await loadChat(7, 'f-a')).map((t) => t.text)).toEqual(['Is this friendly?', 'About the first box.']);
  });

  it('a reset for another field while the answer is being billed still lets it finish', async () => {
    let p!: ReturnType<typeof fakePort>;
    let streams!: ReturnType<typeof setup>['streams'];
    let resetSent = false;
    const now = () => {
      if (streams?.[0]?.finished && !resetSent) {
        resetSent = true;
        p.send({ type: 'reset', tabId: 7, fieldId: 'f-b' });
      }
      return clock;
    };
    const s = setup({ deltas: ['Still mine.'] }, undefined, now);
    streams = s.streams;
    p = fakePort();
    s.svc.connect(p.port);
    p.send(send());
    await settle(p);
    expect(resetSent).toBe(true);
    expect(p.sent.at(-1)).toEqual({ type: 'done', message: 'Still mine.', edits: [] });
    expect(await loadChat(7, 'f-a')).toHaveLength(2);
  });

  it('a reset for the same field in another tab leaves the answer alone too', async () => {
    const { svc, streams } = setup({ deltas: ['Tab seven.'], hold: true });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(p.sent).toHaveLength(1));
    p.send({ type: 'reset', tabId: 8, fieldId: 'f-a' });
    await new Promise((r) => setTimeout(r, 10));
    streams[0]!.release();
    await settle(p);
    expect(streams[0]!.abort).not.toHaveBeenCalled();
    expect(p.sent.at(-1)?.type).toBe('done');
  });

  it("tab updates never end the tab's chats (a new fragment, path or query, or a status): a new page ends them through pageStarted", async () => {
    watchTabsForChat(fakeBrowser.tabs);
    const { svc } = setup({ deltas: ['Ok.'] }, 'https://docs.google.com/document/d/1/edit?tab=t.0');
    const p = fakePort();
    svc.connect(p.port);
    p.send(send({ fieldId: 'gdocs' }));
    await settle(p);
    expect(await loadChat(7, 'gdocs')).toHaveLength(2);
    for (const change of [
      { status: 'loading', url: 'https://docs.google.com/document/d/1/edit?tab=t.0#heading=h.x' },
      { status: 'loading', url: 'https://docs.google.com/document/d/1/edit?tab=t.1' },
      { url: 'https://docs.google.com/document/d/2/edit' },
      { status: 'loading' },
      { status: 'complete' },
    ]) {
      await fakeBrowser.tabs.onUpdated.trigger(7, change as any, {} as any);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(await loadChat(7, 'gdocs')).toHaveLength(2);
  });

  it("an answer that finishes after the tab's chats were cleared (a new page in the tab) is not kept", async () => {
    const { svc, streams } = setup({ deltas: ['About the old page.'], hold: true });
    const p = fakePort();
    svc.connect(p.port);
    p.send(send());
    await vi.waitFor(() => expect(p.sent).toHaveLength(1));
    await clearChat(7);
    streams[0]!.release();
    await settle(p);
    expect(p.sent.at(-1)?.type).toBe('done');
    expect(await loadChat(7, 'f-a')).toEqual([]);
  });

  it('tabs.onRemoved clears the tab\'s chat keys', async () => {
    watchTabsForChat(fakeBrowser.tabs);
    await storage.setItem('session:chat:7:f-a', pairs(1));
    await storage.setItem('session:chat:8:f-a', pairs(1));
    await fakeBrowser.tabs.onRemoved.trigger(7, { windowId: 1, isWindowClosing: false });
    await vi.waitFor(async () => expect(await loadChat(7, 'f-a')).toEqual([]));
    expect(await loadChat(8, 'f-a')).toHaveLength(2);
  });
});
