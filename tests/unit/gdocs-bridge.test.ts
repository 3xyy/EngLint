import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGdocsBridge } from '../../src/content/gdocs/bridge';
import { startCanvasRecorder } from '../../src/content/gdocs/canvas-recorder';
import { GDOCS_PAINT, GDOCS_READY, GDOCS_REQ, GDOCS_RES, decode, encode } from '../../src/content/gdocs/protocol';
import { startGdocsMain, type AnnotateApi, type GdocsWindow } from '../../src/entrypoints/gdocs-main.content';
import { RATIO, SELECTION_BLUE, asProto, fakeContext, fakeProto } from './canvas-fakes';

const OUR_ID = 'pfkhcgfebppldojflbbnoffdphlcnhjk';
const GRAMMARLY_ID = 'kbfnbcaeplbcioakkpcpgfkobkghlhen';
const TEXT = '\u0003I has a cat.\nSecond paragraph.\n';

/** A fake Docs page: an EventTarget for the DOM events plus a stub of the annotate API as recorded live. */
function fakePage(api: Partial<AnnotateApi> = {}) {
  const target = new EventTarget();
  const setSelectionCalls: Array<[number, number]> = [];
  const annotateApi: AnnotateApi = {
    getText: () => TEXT,
    getAnnotations: () => [],
    getSelection: () => [{ start: 3, end: 6 }, { start: 10, end: 12 }],
    setSelection: (start, end) => {
      setSelectionCalls.push([start, end]);
    },
    ...api,
  };
  // Live: getAnnotatedText(id) returns a Promise of the API object.
  const getAnnotatedText = vi.fn(async (_id: string) => annotateApi);
  const win: GdocsWindow = { _docs_annotate_getAnnotatedText: getAnnotatedText };
  return { target, win, getAnnotatedText, setSelectionCalls };
}

/** Records every protocol event on the target: its raw detail and the parsed message. */
function wiretap(target: EventTarget) {
  const seen: Array<{ type: string; detail: unknown }> = [];
  for (const type of [GDOCS_REQ, GDOCS_RES, GDOCS_READY]) {
    target.addEventListener(type, (e) => seen.push({ type, detail: (e as CustomEvent).detail }));
  }
  return seen;
}

const readyMessages = (seen: ReturnType<typeof wiretap>) =>
  seen.filter((e) => e.type === GDOCS_READY).map((e) => decode(e.detail));
const resMessages = (seen: ReturnType<typeof wiretap>) =>
  seen.filter((e) => e.type === GDOCS_RES).map((e) => decode(e.detail));

/** Sends a request the bridge would never build (bad args, unknown op) straight onto the wire. */
function sendRaw(target: EventTarget, message: object) {
  target.dispatchEvent(new CustomEvent(GDOCS_REQ, { detail: JSON.stringify(message) }));
}

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gdocs bridge round trips', () => {
  it('getText round trip', async () => {
    const page = fakePage();
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    expect(await bridge.whenReady()).toBe(true);
    expect(await bridge.getText()).toBe(TEXT);
    expect(page.getAnnotatedText).toHaveBeenCalledWith(OUR_ID);
  });

  it('resolves the annotate API once and reuses it', async () => {
    const page = fakePage();
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await bridge.whenReady();

    await bridge.getText();
    await bridge.getSelection();
    await bridge.setSelection(1, 2);
    expect(page.getAnnotatedText).toHaveBeenCalledTimes(1);
  });

  it('getSelection returns the first range', async () => {
    const page = fakePage();
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await bridge.whenReady();

    expect(await bridge.getSelection()).toEqual({ start: 3, end: 6 });
  });

  it('getSelection survives ranges whose fields are getters', async () => {
    class Range {
      constructor(private readonly s: number, private readonly e: number) {}
      get start() {
        return this.s;
      }
      get end() {
        return this.e;
      }
    }
    const page = fakePage({ getSelection: () => [new Range(7, 9)] });
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await bridge.whenReady();

    expect(await bridge.getSelection()).toEqual({ start: 7, end: 9 });
  });

  it('getSelection with no ranges returns 0..0', async () => {
    const page = fakePage({ getSelection: () => [] });
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await bridge.whenReady();

    expect(await bridge.getSelection()).toEqual({ start: 0, end: 0 });
  });

  it('setSelection forwards args', async () => {
    const page = fakePage();
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await bridge.whenReady();

    await bridge.setSelection(19, 22);
    expect(page.setSelectionCalls).toEqual([[19, 22]]);
  });

  it('an API error rejects with its message', async () => {
    const page = fakePage({
      setSelection: () => {
        throw new Error('bad range');
      },
    });
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await bridge.whenReady();

    await expect(bridge.setSelection(5, 1)).rejects.toThrow('bad range');
  });

  it('a request before the API is found rejects gdocs-unavailable', async () => {
    const page = fakePage();
    delete page.win._docs_annotate_getAnnotatedText;
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await expect(bridge.getText()).rejects.toThrow('gdocs-unavailable');
  });
});

describe('gdocs bridge readiness', () => {
  it('no ready within timeout → false', async () => {
    const bridge = createGdocsBridge(new EventTarget()); // no MAIN-world script on this page
    const ready = track(bridge.whenReady());

    await vi.advanceTimersByTimeAsync(4999);
    expect(ready.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toEqual({ settled: true, value: false });
  });

  it('main reports unavailable only when the 30 s window ends', async () => {
    const page = fakePage();
    delete page.win._docs_annotate_getAnnotatedText;
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(readyMessages(seen)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(readyMessages(seen)).toEqual([{ available: false }]);
  });

  it('main connects when the annotate API appears during polling', async () => {
    const page = fakePage();
    const getAnnotatedText = page.win._docs_annotate_getAnnotatedText;
    delete page.win._docs_annotate_getAnnotatedText;
    setTimeout(() => {
      page.win._docs_annotate_getAnnotatedText = getAnnotatedText;
    }, 300);
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    const ready = track(bridge.whenReady());

    await vi.advanceTimersByTimeAsync(250);
    expect(ready.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(ready).toEqual({ settled: true, value: true });
  });

  it('polls every 100 ms for the first 5 s, then every 500 ms', async () => {
    const page = fakePage();
    page.getAnnotatedText.mockRejectedValue(new Error('not yet'));
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await vi.advanceTimersByTimeAsync(4999);
    expect(page.getAnnotatedText).toHaveBeenCalledTimes(50); // t = 0, 100, …, 4900
    await vi.advanceTimersByTimeAsync(10_000 - 4999);
    const callsAt10s = page.getAnnotatedText.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(page.getAnnotatedText.mock.calls.length - callsAt10s).toBe(10);
  });

  it('a rejected getAnnotatedText is retried until it resolves', async () => {
    const page = fakePage();
    page.getAnnotatedText.mockRejectedValueOnce(new Error('not yet'));
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await vi.advanceTimersByTimeAsync(99);
    expect(readyMessages(seen)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(readyMessages(seen)).toEqual([{ available: true }]);
    expect(page.getAnnotatedText).toHaveBeenCalledTimes(2);
  });

  it('a synchronously throwing getAnnotatedText is retried, then false when the window ends', async () => {
    const page = fakePage();
    const throwing = vi.fn((_id: string): Promise<AnnotateApi> => {
      throw new Error('sync');
    });
    page.win._docs_annotate_getAnnotatedText = throwing;
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(readyMessages(seen)).toEqual([]);
    expect(throwing.mock.calls.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readyMessages(seen)).toEqual([{ available: false }]);
  });

  it('getText not returning a string is retried, then false when the window ends', async () => {
    const page = fakePage({ getText: (() => Promise.resolve(TEXT)) as unknown as () => string });
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(readyMessages(seen)).toEqual([]);
    expect(page.getAnnotatedText.mock.calls.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readyMessages(seen)).toEqual([{ available: false }]);
  });

  it('a hung getAnnotatedText hits the 3 s deadline and is retried', async () => {
    const page = fakePage();
    page.getAnnotatedText.mockReturnValueOnce(new Promise<AnnotateApi>(() => {}));
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await vi.advanceTimersByTimeAsync(3099);
    expect(page.getAnnotatedText).toHaveBeenCalledTimes(1);
    expect(readyMessages(seen)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); // deadline at 3000, next attempt 100 ms later
    expect(page.getAnnotatedText).toHaveBeenCalledTimes(2);
    expect(readyMessages(seen)).toEqual([{ available: true }]);
  });

  it('the annotate API appearing after 8 s still connects', async () => {
    const page = fakePage();
    const getAnnotatedText = page.win._docs_annotate_getAnnotatedText;
    delete page.win._docs_annotate_getAnnotatedText;
    setTimeout(() => {
      page.win._docs_annotate_getAnnotatedText = getAnnotatedText;
    }, 8000);
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await vi.advanceTimersByTimeAsync(7999);
    expect(readyMessages(seen)).toEqual([]);
    await vi.advanceTimersByTimeAsync(501);
    expect(readyMessages(seen)).toEqual([{ available: true }]);
  });

  it('the window is measured in wall-clock time, not timer ticks', async () => {
    const page = fakePage();
    delete page.win._docs_annotate_getAnnotatedText;
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    // A throttled background tab: 30 s pass on the clock while no timer has fired.
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(readyMessages(seen)).toEqual([{ available: false }]);
  });

  it('ping after ready returns available', async () => {
    const page = fakePage();
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await vi.advanceTimersByTimeAsync(10);
    // The ready event already fired, before the isolated script was listening.
    expect(seen.filter((e) => e.type === GDOCS_READY)).toHaveLength(1);

    const bridge = createGdocsBridge(page.target);
    const ready = track(bridge.whenReady());
    await vi.advanceTimersByTimeAsync(10);
    expect(ready).toEqual({ settled: true, value: true });
  });

  it('a ping during polling is answered when polling ends', async () => {
    const page = fakePage();
    const getAnnotatedText = page.win._docs_annotate_getAnnotatedText;
    delete page.win._docs_annotate_getAnnotatedText;
    setTimeout(() => {
      page.win._docs_annotate_getAnnotatedText = getAnnotatedText;
    }, 300);
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    page.target.dispatchEvent(new CustomEvent(GDOCS_REQ, { detail: encode({ reqId: 'p1', op: 'ping' }) }));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen.filter((e) => e.type === GDOCS_RES)).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.filter((e) => e.type === GDOCS_RES).map((e) => decode(e.detail))).toEqual([
      { reqId: 'p1', ok: true, value: { available: true } },
    ]);
  });
});

describe('gdocs readiness recovery', () => {
  it('a ping after a final false opens a fresh window and reconnects', async () => {
    const page = fakePage();
    const getAnnotatedText = page.win._docs_annotate_getAnnotatedText;
    delete page.win._docs_annotate_getAnnotatedText;
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readyMessages(seen)).toEqual([{ available: false }]);

    page.win._docs_annotate_getAnnotatedText = getAnnotatedText; // Docs finally loaded
    const bridge = createGdocsBridge(page.target);
    const ready = track(bridge.whenReady());
    await vi.advanceTimersByTimeAsync(10);
    expect(ready).toEqual({ settled: true, value: true });
    expect(readyMessages(seen)).toEqual([{ available: false }, { available: true }]);
    expect(await bridge.getText()).toBe(TEXT);
  });

  it('pings during a recovery window share one window and are answered when it ends', async () => {
    const page = fakePage();
    delete page.win._docs_annotate_getAnnotatedText;
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await vi.advanceTimersByTimeAsync(30_000);

    sendRaw(page.target, { reqId: 'p1', op: 'ping' });
    sendRaw(page.target, { reqId: 'p2', op: 'ping' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(resMessages(seen)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(resMessages(seen)).toEqual([
      { reqId: 'p1', ok: true, value: { available: false } },
      { reqId: 'p2', ok: true, value: { available: false } },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readyMessages(seen)).toEqual([{ available: false }, { available: false }]); // one recovery window, not two
  });

  it('a late ready after whenReady returned false is recorded', async () => {
    const target = new EventTarget(); // no MAIN script answers pings here
    const bridge = createGdocsBridge(target);
    const first = track(bridge.whenReady(1000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(first).toEqual({ settled: true, value: false });

    target.dispatchEvent(new CustomEvent(GDOCS_READY, { detail: encode({ available: true }) }));
    const second = track(bridge.whenReady());
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ settled: true, value: true });
  });

  it('a ready event saying unavailable resolves whenReady false', async () => {
    const target = new EventTarget(); // pings go unanswered; only the ready event speaks
    const bridge = createGdocsBridge(target);
    const ready = track(bridge.whenReady());
    target.dispatchEvent(new CustomEvent(GDOCS_READY, { detail: encode({ available: false }) }));
    await vi.advanceTimersByTimeAsync(0);

    expect(ready).toEqual({ settled: true, value: false });
  });

  it('a ping answer of available is recorded too', async () => {
    const target = new EventTarget();
    let answers = 1; // a MAIN script that answers exactly one ping, then goes quiet
    target.addEventListener(GDOCS_REQ, (e) => {
      const req = decode<{ reqId: string; op: string }>((e as CustomEvent).detail);
      if (req?.op !== 'ping' || answers-- <= 0) return;
      target.dispatchEvent(
        new CustomEvent(GDOCS_RES, { detail: encode({ reqId: req.reqId ?? '', ok: true, value: { available: true } }) }),
      );
    });
    const bridge = createGdocsBridge(target);
    expect(await bridge.whenReady()).toBe(true);

    const again = track(bridge.whenReady());
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toEqual({ settled: true, value: true });
  });

  it('whenReady leaves no ping timer behind when the ready event wins', async () => {
    const target = new EventTarget();
    const bridge = createGdocsBridge(target);
    const ready = track(bridge.whenReady());
    target.dispatchEvent(new CustomEvent(GDOCS_READY, { detail: encode({ available: true }) }));
    await vi.advanceTimersByTimeAsync(0);

    expect(ready).toEqual({ settled: true, value: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('gdocs main error paths', () => {
  async function readyPage(api: Partial<AnnotateApi> = {}) {
    const page = fakePage(api);
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await vi.advanceTimersByTimeAsync(10);
    return { ...page, seen };
  }

  it('setSelection with bad args → gdocs-bad-args', async () => {
    const page = await readyPage();
    sendRaw(page.target, { reqId: 'b1', op: 'setSelection', args: ['19', 22] });
    sendRaw(page.target, { reqId: 'b2', op: 'setSelection' });

    expect(resMessages(page.seen)).toEqual([
      { reqId: 'b1', ok: false, error: 'gdocs-bad-args' },
      { reqId: 'b2', ok: false, error: 'gdocs-bad-args' },
    ]);
    expect(page.setSelectionCalls).toEqual([]);
  });

  it('an unknown op → gdocs-unknown-op', async () => {
    const page = await readyPage();
    sendRaw(page.target, { reqId: 'u1', op: 'deleteEverything' });

    expect(resMessages(page.seen)).toEqual([{ reqId: 'u1', ok: false, error: 'gdocs-unknown-op' }]);
  });

  it('a throwing getSelection → ok:false with its message', async () => {
    const page = await readyPage({
      getSelection: () => {
        throw new Error('selection broke');
      },
    });
    const bridge = createGdocsBridge(page.target);

    await expect(bridge.getSelection()).rejects.toThrow('selection broke');
    expect(resMessages(page.seen)).toContainEqual({ reqId: expect.any(String), ok: false, error: 'selection broke' });
  });
});

describe('gdocs bridge requests', () => {
  it('unanswered request rejects gdocs-timeout', async () => {
    const bridge = createGdocsBridge(new EventTarget());
    const request = track(bridge.getText());

    await vi.advanceTimersByTimeAsync(999);
    expect(request.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(request.settled).toBe(true);
    expect(request.error).toBeInstanceOf(Error);
    expect((request.error as Error).message).toBe('gdocs-timeout');
  });

  it('responses are matched by reqId', async () => {
    const target = new EventTarget();
    const requests: Array<{ reqId?: string; op?: string }> = [];
    target.addEventListener(GDOCS_REQ, (e) => requests.push(decode((e as CustomEvent).detail) ?? {}));
    const bridge = createGdocsBridge(target);
    const respond = (reqId: string | undefined, value: string) =>
      target.dispatchEvent(new CustomEvent(GDOCS_RES, { detail: encode({ reqId: reqId ?? '', ok: true, value }) }));

    const first = track(bridge.getText());
    const second = track(bridge.getText());
    expect(requests).toHaveLength(2);
    const [req1, req2] = requests as [{ reqId?: string }, { reqId?: string }];
    expect(req1.reqId).not.toBe(req2.reqId);

    respond('someone-else', 'stray'); // an unknown reqId is ignored
    respond(req2.reqId, 'B');
    respond(req1.reqId, 'A');
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual({ settled: true, value: 'A' });
    expect(second).toEqual({ settled: true, value: 'B' });
  });

  it('detail is a JSON string on the wire', async () => {
    const page = fakePage();
    const seen = wiretap(page.target);
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await bridge.whenReady();
    await bridge.getText();
    await bridge.setSelection(19, 22);

    expect(new Set(seen.map((e) => e.type))).toEqual(new Set([GDOCS_REQ, GDOCS_RES, GDOCS_READY]));
    for (const event of seen) expect(typeof event.detail).toBe('string');
    const messages = seen.map((e) => ({ type: e.type, message: JSON.parse(e.detail as string) }));
    expect(messages).toContainEqual({ type: GDOCS_READY, message: { available: true } });
    expect(messages).toContainEqual({
      type: GDOCS_REQ,
      message: { reqId: expect.any(String), op: 'setSelection', args: [19, 22] },
    });
    expect(messages).toContainEqual({ type: GDOCS_RES, message: { reqId: expect.any(String), ok: true, value: TEXT } });
  });

  it('ignores malformed requests: object detail, bad JSON, non-object JSON, no reqId', async () => {
    const page = fakePage();
    const seen = wiretap(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    await vi.advanceTimersByTimeAsync(10);

    const send = (detail: unknown) => page.target.dispatchEvent(new CustomEvent(GDOCS_REQ, { detail }));
    expect(() => {
      send({ reqId: 'x', op: 'getText' });
      send('{not json');
      send('42');
      send('null');
      send(JSON.stringify({ op: 'getText' }));
      send(JSON.stringify({ reqId: 7, op: 'ping' }));
    }).not.toThrow(); // happy-dom rethrows listener errors from dispatchEvent
    expect(resMessages(seen)).toEqual([]);
  });
});

describe('gdocs main-world flag', () => {
  it("sets the flag to EngLint's id when it is empty", () => {
    const page = fakePage();
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    expect(page.win._docs_annotate_canvas_by_ext).toBe(OUR_ID);

    const blank = fakePage();
    blank.win._docs_annotate_canvas_by_ext = '';
    startGdocsMain(blank.win, blank.target, { extensionId: OUR_ID });
    expect(blank.win._docs_annotate_canvas_by_ext).toBe(OUR_ID);
  });

  it('does not overwrite an existing flag value', async () => {
    const page = fakePage();
    page.win._docs_annotate_canvas_by_ext = GRAMMARLY_ID;
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    expect(page.win._docs_annotate_canvas_by_ext).toBe(GRAMMARLY_ID);
    // Docs' gate accepts any non-empty value, and our own id still works with getAnnotatedText.
    expect(await bridge.whenReady()).toBe(true);
    expect(page.getAnnotatedText).toHaveBeenCalledWith(OUR_ID);
  });

  it('WXT_GDOCS_FLAG off skips setting the flag', () => {
    const page = fakePage();
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID, gdocsFlag: 'off' });
    expect(page.win._docs_annotate_canvas_by_ext).toBeUndefined();
  });
});

describe('gdocs bridge dispose', () => {
  it('rejects pending requests, answers a waiting whenReady false, and stops listening', async () => {
    const target = new EventTarget(); // nothing answers on this page
    const bridge = createGdocsBridge(target);
    const pending = track(bridge.getText());
    const ready = track(bridge.whenReady(30_000));
    const seen = wiretap(target);

    bridge.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.error).toEqual(new Error('gdocs-disposed'));
    expect(ready).toEqual({ settled: true, value: false });

    // A late answer or ready event changes nothing, and new requests fail at once without going out.
    target.dispatchEvent(new CustomEvent(GDOCS_READY, { detail: encode({ available: true }) }));
    expect(await bridge.whenReady(30_000)).toBe(false);
    await expect(bridge.getText()).rejects.toThrow('gdocs-disposed');
    await expect(bridge.setSelection(1, 2)).rejects.toThrow('gdocs-disposed');
    expect(seen.filter((e) => e.type === GDOCS_REQ)).toEqual([]);
  });

  it('a bridge that was ready answers false after dispose', async () => {
    const page = fakePage();
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });
    expect(await bridge.whenReady()).toBe(true);
    bridge.dispose();
    expect(await bridge.whenReady()).toBe(false);
    await expect(bridge.getSelection()).rejects.toThrow('gdocs-disposed');
  });
});

describe('gdocs canvas runs', () => {
  const HELLO = '\u202DHello\u202C';

  /** A page whose MAIN script records canvas paint through a fake 2D-context prototype. */
  function canvasPage() {
    const page = fakePage();
    const proto = fakeProto();
    const startRecorder = (onPaint: (generation: number) => void) =>
      startCanvasRecorder(asProto(proto), { onPaint });
    return { ...page, proto, startRecorder };
  }

  /** A bridge on a bare target, with a hand-written answer for each request it sends. */
  function scriptedBridge(answer: (req: { reqId: string; op?: string }) => string | null) {
    const target = new EventTarget();
    const ops: unknown[] = [];
    target.addEventListener(GDOCS_REQ, (e) => {
      const req = decode<{ reqId: string; op: string; args: unknown }>((e as CustomEvent).detail);
      ops.push(req);
      if (typeof req?.reqId !== 'string') return;
      const detail = answer({ reqId: req.reqId, op: req.op });
      if (detail !== null) target.dispatchEvent(new CustomEvent(GDOCS_RES, { detail }));
    });
    return { bridge: createGdocsBridge(target), target, ops };
  }

  const runsReply = (reqId: string, valueJson: string) => `{"reqId":${JSON.stringify(reqId)},"ok":true,"value":${valueJson}}`;
  const RUN = { text: 'Hello', font: '14.6667px Arial', x: 96, y: 179.7, width: 36.7 };
  const BOX = { x: 150, y: 90, width: 35, height: 19 };

  it('getRuns returns what the page world recorded', async () => {
    const page = canvasPage();
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID, startRecorder: page.startRecorder });
    await bridge.whenReady();
    const ctx = fakeContext(page.proto);
    ctx.fillText(HELLO, 101, 184.7);
    ctx.fillStyle = SELECTION_BLUE;
    ctx.fillRect(279, 171, 35, 19);

    const { generation, canvases } = await bridge.getRuns();

    expect(generation).toBeGreaterThan(0);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.id).toBe(ctx.canvas.dataset.englintCanvas);
    expect(canvases[0]!.runs.map((r) => r.text)).toEqual(['Hello']);
    expect(canvases[0]!.runs[0]!.x).toBeCloseTo((1.8 * 101 - 9) * RATIO, 2);
    expect(canvases[0]!.selection).toHaveLength(1);
  });

  it('runs are served before, and without, the annotate API', async () => {
    const page = canvasPage();
    delete page.win._docs_annotate_getAnnotatedText;
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID, startRecorder: page.startRecorder });

    expect(await bridge.getRuns()).toEqual({ generation: 0, canvases: [] });
    await expect(bridge.getText()).rejects.toThrow('gdocs-unavailable');
  });

  it('without a recorder, runs answers gdocs-no-runs and the canvas methods stay unpatched', async () => {
    const page = canvasPage();
    const fillText = page.proto.fillText;
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID });

    await expect(bridge.getRuns()).rejects.toThrow('gdocs-no-runs');
    expect(page.proto.fillText).toBe(fillText);
    expect(await bridge.getText()).toBe(TEXT); // the rest of the bridge works as before
  });

  it('a recorder that fails to start leaves the rest of the bridge working', async () => {
    const page = fakePage();
    const bridge = createGdocsBridge(page.target);
    startGdocsMain(page.win, page.target, {
      extensionId: OUR_ID,
      startRecorder: () => {
        throw new Error('no canvas here');
      },
    });

    expect(await bridge.whenReady()).toBe(true);
    await expect(bridge.getRuns()).rejects.toThrow('gdocs-no-runs');
    expect(await bridge.getText()).toBe(TEXT);
  });

  it("getRuns sends 'runs' with no args and keeps only well-formed canvases", async () => {
    const value = JSON.stringify({
      generation: 7,
      canvases: [
        { id: '1', runs: [RUN], selection: [BOX] },
        { id: '2"] *', runs: [RUN], selection: [] }, // not an id this recorder makes
        { id: '3', runs: 'Hello', selection: [] },
        { id: '4', runs: [{ ...RUN, text: 5 }], selection: [] },
        { id: '5', runs: [RUN], selection: [{ ...BOX, height: null }] },
        { id: '6', runs: [{ ...RUN, font: undefined }], selection: [] },
        'not a canvas',
        null,
        { id: '9', runs: [], selection: [] },
      ],
    });
    const { bridge, ops } = scriptedBridge(({ reqId }) => runsReply(reqId, value));

    const runs = await bridge.getRuns();

    expect(ops).toEqual([{ reqId: expect.any(String), op: 'runs' }]);
    expect(runs).toEqual({
      generation: 7,
      canvases: [
        { id: '1', runs: [RUN], selection: [BOX] },
        { id: '9', runs: [], selection: [] },
      ],
    });
  });

  it('getRuns drops a canvas carrying a non-finite number, and clamps out-of-range ones', async () => {
    // JSON.parse turns 1e999 into Infinity: a page script can send it even though JSON.stringify never would.
    const value =
      '{"generation":3,"canvases":[' +
      '{"id":"1","runs":[{"text":"a","font":"f","x":1e999,"y":0,"width":1}],"selection":[]},' +
      '{"id":"2","runs":[],"selection":[{"x":0,"y":-1e999,"width":1,"height":1}]},' +
      '{"id":"3","runs":[{"text":"b","font":"f","x":5e7,"y":-5e7,"width":-4}],"selection":[{"x":1,"y":2,"width":3e9,"height":-1}]}' +
      ']}';
    const { bridge } = scriptedBridge(({ reqId }) => runsReply(reqId, value));

    expect(await bridge.getRuns()).toEqual({
      generation: 3,
      canvases: [
        {
          id: '3',
          runs: [{ text: 'b', font: 'f', x: 1e6, y: -1e6, width: 0 }],
          selection: [{ x: 1, y: 2, width: 1e6, height: 0 }],
        },
      ],
    });
  });

  it('a reply over the total budget is rejected whole: 20,000 runs or 2,000,000 characters', async () => {
    const canvas = (id: number, runs: number, text = 'w') => ({
      id: String(id),
      runs: Array.from({ length: runs }, () => ({ ...RUN, text })),
      selection: [],
    });
    const reply = (canvases: unknown[]) => JSON.stringify({ generation: 1, canvases });
    const getRuns = (canvases: unknown[]) => scriptedBridge(({ reqId }) => runsReply(reqId, reply(canvases))).bridge.getRuns();

    const atBudget = await getRuns([1, 2, 3, 4, 5].map((id) => canvas(id, 4000)));
    expect(atBudget.canvases.reduce((sum, c) => sum + c.runs.length, 0)).toBe(20_000);
    await expect(getRuns([1, 2, 3, 4, 5].map((id) => canvas(id, id === 5 ? 4001 : 4000)))).rejects.toThrow(
      'gdocs-too-large',
    );

    const long = 'x'.repeat(10_000);
    expect((await getRuns([canvas(1, 200, long)])).canvases[0]!.runs).toHaveLength(200);
    await expect(getRuns([canvas(1, 200, long), canvas(2, 1, 'y')])).rejects.toThrow('gdocs-too-large');
  });

  it('a reply that is not a runs snapshot rejects gdocs-bad-response', async () => {
    const replies = [
      '"runs"',
      '[]',
      '{"generation":"1","canvases":[]}',
      '{"generation":1e999,"canvases":[]}',
      '{"generation":1,"canvases":{}}',
      '{"canvases":[]}',
    ];
    for (const reply of replies) {
      const { bridge } = scriptedBridge(({ reqId }) => runsReply(reqId, reply));
      await expect(bridge.getRuns(), reply).rejects.toThrow('gdocs-bad-response');
    }
  });

  it('onPaint delivers a generation once per frame after paints in the page world', async () => {
    const page = canvasPage();
    const seen: string[] = [];
    page.target.addEventListener(GDOCS_PAINT, (e) => seen.push((e as CustomEvent).detail as string));
    const bridge = createGdocsBridge(page.target);
    const generations: number[] = [];
    bridge.onPaint((generation) => generations.push(generation));
    startGdocsMain(page.win, page.target, { extensionId: OUR_ID, startRecorder: page.startRecorder });
    const ctx = fakeContext(page.proto);

    ctx.fillText(HELLO, 101, 184.7);
    ctx.fillText(HELLO, 101, 204.7);
    await vi.advanceTimersByTimeAsync(20); // one animation frame
    ctx.fillText(HELLO, 101, 224.7);
    await vi.advanceTimersByTimeAsync(20);

    expect(generations).toHaveLength(2);
    expect(generations[1]!).toBeGreaterThan(generations[0]!);
    expect(generations[1]).toBe((await bridge.getRuns()).generation);
    expect(seen.map((detail) => JSON.parse(detail))).toEqual(generations.map((generation) => ({ generation })));
  });

  it('onPaint ignores malformed paint events and stops on unsubscribe or dispose', () => {
    const target = new EventTarget();
    const bridge = createGdocsBridge(target);
    const first: number[] = [];
    const second: number[] = [];
    const off = bridge.onPaint((generation) => first.push(generation));
    bridge.onPaint((generation) => second.push(generation));
    const paint = (detail: unknown) => target.dispatchEvent(new CustomEvent(GDOCS_PAINT, { detail }));

    paint(encode({ generation: 4 }));
    paint('{"generation":"5"}');
    paint('{"generation":1e999}');
    paint({ generation: 6 });
    paint('{}');
    off();
    paint(encode({ generation: 7 }));
    bridge.dispose();
    paint(encode({ generation: 8 }));

    expect(first).toEqual([4]);
    expect(second).toEqual([4, 7]);
    expect(bridge.onPaint(() => {})).toBeTypeOf('function');
  });

  it('getRuns after dispose rejects without sending anything', async () => {
    const { bridge, ops } = scriptedBridge(() => null);
    bridge.dispose();

    await expect(bridge.getRuns()).rejects.toThrow('gdocs-disposed');
    expect(ops).toEqual([]);
  });
});
