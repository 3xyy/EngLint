import { describe, expect, it, vi } from 'vitest';
import { createWorkerHandler, createWorkerLint, type WorkerLike } from '../../src/offscreen/harper-worker';
import { HARPER_OFFSCREEN, type HarperLintMessage, type HarperLintReply } from '../../src/shared/messages';

const msg = (text: string): HarperLintMessage => ({
  target: HARPER_OFFSCREEN,
  mode: 'standard',
  dialect: 'en-US',
  words: [],
  paragraphs: [{ hash: text, text }],
});
const ok = (hash: string): HarperLintReply => ({ ok: true, results: { [hash]: [] } });

/** A worker that records what the page posts and lets the test answer, or fail, as the real one would. */
function fakeWorker() {
  const posted: any[] = [];
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const state = { terminated: false };
  const worker: WorkerLike = {
    postMessage: (data: unknown) => void posted.push(data),
    addEventListener: (type: string, cb: (e: any) => void) => void (listeners[type] ??= []).push(cb),
    terminate: () => void (state.terminated = true),
  };
  const emit = (type: string, e: any) => (listeners[type] ?? []).forEach((cb) => cb(e));
  return { worker, posted, state, reply: (id: number, reply: HarperLintReply) => emit('message', { data: { id, reply } }), emit };
}
/** A factory of fake workers, keeping each one it made. */
function fakeWorkers() {
  const made: ReturnType<typeof fakeWorker>[] = [];
  const make = vi.fn(() => {
    const f = fakeWorker();
    made.push(f);
    return f.worker;
  });
  return { made, make };
}

describe('createWorkerLint (the offscreen page, relaying to the Harper worker)', () => {
  it('tells the worker where the WebAssembly is first, then posts each check with an id and answers with its reply', async () => {
    const f = fakeWorker();
    const lint = createWorkerLint(() => f.worker, 'chrome-extension://x/harper_wasm_slim_bg.wasm');
    expect(f.posted).toEqual([{ type: 'init', wasmUrl: 'chrome-extension://x/harper_wasm_slim_bg.wasm' }]);
    const answer = lint(msg('a'));
    expect(f.posted[1]).toEqual({ type: 'lint', id: expect.any(Number), msg: msg('a') });
    f.reply(f.posted[1].id, ok('a'));
    await expect(answer).resolves.toEqual(ok('a'));
  });

  it('matches replies to their checks by id, in whatever order they come', async () => {
    const f = fakeWorker();
    const lint = createWorkerLint(() => f.worker, 'u');
    const first = lint(msg('a'));
    const second = lint(msg('b'));
    const [, a, b] = f.posted;
    expect(a.id).not.toBe(b.id);
    f.reply(b.id, ok('b'));
    f.reply(a.id, ok('a'));
    await expect(first).resolves.toEqual(ok('a'));
    await expect(second).resolves.toEqual(ok('b'));
  });

  it('starts its worker at once, before any check', () => {
    const w = fakeWorkers();
    createWorkerLint(w.make, 'u');
    expect(w.make).toHaveBeenCalledTimes(1);
    expect(w.made[0]!.posted).toEqual([{ type: 'init', wasmUrl: 'u' }]);
  });

  it('a worker error answers every pending check { ok: false } at once and ends that worker; the next check goes to a new one, told where the WebAssembly is first', async () => {
    const w = fakeWorkers();
    const lint = createWorkerLint(w.make, 'u');
    const pending = [lint(msg('a')), lint(msg('b'))];
    w.made[0]!.emit('error', new Event('error'));
    await expect(Promise.all(pending)).resolves.toEqual([{ ok: false }, { ok: false }]);
    expect(w.made[0]!.state.terminated).toBe(true);
    expect(w.make).toHaveBeenCalledTimes(1); // nothing new until a check needs it
    const later = lint(msg('c'));
    expect(w.make).toHaveBeenCalledTimes(2);
    const fresh = w.made[1]!;
    expect(fresh.posted).toEqual([{ type: 'init', wasmUrl: 'u' }, { type: 'lint', id: expect.any(Number), msg: msg('c') }]);
    expect(w.made[0]!.posted).toHaveLength(3); // the old one got no more
    fresh.reply(fresh.posted[1].id, ok('c'));
    await expect(later).resolves.toEqual(ok('c'));
  });

  it('a new worker that fails to load too answers its check { ok: false } as soon as it fails, not never', async () => {
    const w = fakeWorkers();
    const lint = createWorkerLint(w.make, 'u');
    w.made[0]!.emit('error', new Event('error'));
    const check = lint(msg('a'));
    let settled = false;
    void check.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    w.made[1]!.emit('error', new Event('error'));
    await expect(check).resolves.toEqual({ ok: false });
  });

  it('a late reply from an ended worker answers nothing', async () => {
    const w = fakeWorkers();
    const lint = createWorkerLint(w.make, 'u');
    const first = lint(msg('a'));
    const oldId = w.made[0]!.posted[1].id;
    w.made[0]!.emit('error', new Event('error'));
    await expect(first).resolves.toEqual({ ok: false });
    const second = lint(msg('b'));
    w.made[0]!.reply(oldId, ok('stale'));
    w.made[0]!.reply(w.made[1]!.posted[1].id, ok('stale'));
    w.made[1]!.reply(w.made[1]!.posted[1].id, ok('b'));
    await expect(second).resolves.toEqual(ok('b'));
  });

  it('a worker that cannot be made answers the check { ok: false } at once, and the next check tries again', async () => {
    let fail = true;
    const f = fakeWorker();
    const make = vi.fn(() => {
      if (fail) throw new Error('blocked');
      return f.worker;
    });
    const lint = createWorkerLint(make, 'u');
    await expect(lint(msg('a'))).resolves.toEqual({ ok: false });
    fail = false;
    const later = lint(msg('b'));
    expect(make).toHaveBeenCalledTimes(3);
    f.reply(f.posted[1].id, ok('b'));
    await expect(later).resolves.toEqual(ok('b'));
  });

  it('a reply that cannot be read answers the pending checks { ok: false } and keeps the worker; a post that throws answers { ok: false }', async () => {
    const w = fakeWorkers();
    const lint = createWorkerLint(w.make, 'u');
    const pending = lint(msg('a'));
    w.made[0]!.emit('messageerror', new Event('messageerror'));
    await expect(pending).resolves.toEqual({ ok: false });
    expect(w.made[0]!.state.terminated).toBe(false);
    const next = lint(msg('b'));
    expect(w.make).toHaveBeenCalledTimes(1);
    w.made[0]!.reply(w.made[0]!.posted.at(-1).id, ok('b'));
    await expect(next).resolves.toEqual(ok('b'));
    w.made[0]!.worker.postMessage = () => {
      throw new Error('worker gone');
    };
    await expect(lint(msg('c'))).resolves.toEqual({ ok: false });
  });
});

describe('createWorkerHandler (inside the Harper worker)', () => {
  it('builds the host once, from the WebAssembly address it was given, and posts each check’s reply with its id', async () => {
    const lint = vi.fn(async (m: HarperLintMessage) => ok(m.paragraphs[0]!.hash));
    const makeHost = vi.fn(() => ({ lint }));
    const posted: unknown[] = [];
    const handle = createWorkerHandler(makeHost, (data: unknown) => posted.push(data));
    handle({ type: 'init', wasmUrl: 'chrome-extension://x/w.wasm' });
    await handle({ type: 'lint', id: 7, msg: msg('a') });
    await handle({ type: 'lint', id: 8, msg: msg('b') });
    expect(makeHost.mock.calls).toEqual([['chrome-extension://x/w.wasm']]);
    expect(lint.mock.calls.map(([m]) => m)).toEqual([msg('a'), msg('b')]);
    expect(posted).toEqual([
      { id: 7, reply: ok('a') },
      { id: 8, reply: ok('b') },
    ]);
  });

  it('a check before the address came, or one the host fails, is answered { ok: false }; anything else is ignored', async () => {
    const posted: unknown[] = [];
    const handle = createWorkerHandler(() => ({ lint: async () => Promise.reject(new Error('wasm failed')) }), (data: unknown) => posted.push(data));
    await handle({ type: 'lint', id: 1, msg: msg('a') });
    handle({ type: 'init', wasmUrl: 'u' });
    await handle({ type: 'lint', id: 2, msg: msg('b') });
    await handle('noise');
    await handle({ type: 'lint', msg: msg('c') }); // no id: nothing to answer
    expect(posted).toEqual([
      { id: 1, reply: { ok: false } },
      { id: 2, reply: { ok: false } },
    ]);
  });
});
