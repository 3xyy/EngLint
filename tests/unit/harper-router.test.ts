import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  closeWhenLocalChecksOff,
  createCloseOffscreen,
  createEnsureOffscreen,
  createHarperRouter,
  HARPER_RETRY_MS,
  HARPER_TIMEOUT_MS,
  HARPER_TIMEOUTS_BEFORE_CLOSE,
  type OffscreenApi,
} from '../../src/background/harper';
import type { SourcedIssue } from '../../src/core/sources';
import { createOffscreenListener, handleOffscreenMessage } from '../../src/offscreen/harper-host';
import {
  HARPER_OFFSCREEN,
  type HarperCheckRequest,
  type HarperLintMessage,
  type HarperLintReply,
} from '../../src/shared/messages';
import { dialectItem, dictionaryItem, disabledSitesItem, localChecksItem } from '../../src/shared/settings';

const ORIGIN = 'chrome-extension://pfkhcgfebppldojflbbnoffdphlcnhjk/';
const CONTENT = { tab: { id: 7, url: 'https://example.com/post' }, url: 'https://example.com/post' };
const PANEL = { url: `${ORIGIN}sidepanel.html` };
const WORKER = { url: `${ORIGIN}background.js` };

const ISSUE: SourcedIssue = {
  original: 'a',
  replacement: 'an',
  before: 'This is',
  category: 'grammar',
  severity: 'error',
  kind: 'article',
  reason: 'r',
  source: 'harper',
  ruleId: 'harper:AnA',
  at: 8,
  suggestionCount: 1,
};
const REQ: HarperCheckRequest = { host: 'example.com', mode: 'standard', paragraphs: [{ hash: 'h1', text: 'This is a apple.' }] };
const OK: HarperLintReply = { ok: true, results: { h1: [ISSUE] } };
const EMPTY = { status: 'ok', results: {}, dismissed: [] };

/** A promise with its settle functions, for answers that arrive later. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let clock = 1_000_000;
function setup(
  o: {
    ensure?: () => Promise<void>;
    send?: (m: HarperLintMessage) => Promise<unknown>;
    dismissedFor?: (hashes: string[]) => Promise<string[]>;
    close?: () => Promise<void>;
  } = {},
) {
  const ensureOffscreen = vi.fn(o.ensure ?? (async () => {}));
  const sendToOffscreen = vi.fn(o.send ?? (async () => OK));
  const dismissedFor = vi.fn(o.dismissedFor ?? (async () => []));
  const closeOffscreen = vi.fn(o.close ?? (async () => {}));
  const router = createHarperRouter({
    ensureOffscreen,
    sendToOffscreen,
    dismissedFor,
    closeOffscreen,
    now: () => clock,
    extensionOrigin: ORIGIN,
  });
  return { router, ensureOffscreen, sendToOffscreen, dismissedFor, closeOffscreen };
}
const ANSWERED = { status: 'ok', results: { h1: [ISSUE] }, dismissed: [] };

beforeEach(() => {
  fakeBrowser.reset();
  clock = 1_000_000;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('harperCheck routing', () => {
  it('sends the paragraphs, mode, dialect and dictionary to the offscreen document, addressed to it, and returns its issues', async () => {
    await dialectItem.setValue('en-GB');
    await dictionaryItem.setValue(['englint']);
    const { router, sendToOffscreen } = setup();
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
    expect(sendToOffscreen).toHaveBeenCalledWith({
      target: HARPER_OFFSCREEN,
      mode: 'standard',
      dialect: 'en-GB',
      words: ['englint'],
      paragraphs: REQ.paragraphs,
    });
    expect(HARPER_OFFSCREEN).toBe('harper-offscreen');
  });

  it('starts the offscreen document once for two concurrent first checks', async () => {
    const start = deferred<void>();
    const { router, ensureOffscreen, sendToOffscreen } = setup({ ensure: () => start.promise });
    const both = Promise.all([router.check(REQ, CONTENT), router.check(REQ, PANEL)]);
    start.resolve();
    expect(await both).toEqual([
      { status: 'ok', results: { h1: [ISSUE] }, dismissed: [] },
      { status: 'ok', results: { h1: [ISSUE] }, dismissed: [] },
    ]);
    await router.check(REQ, CONTENT);
    expect(ensureOffscreen).toHaveBeenCalledOnce();
    expect(sendToOffscreen).toHaveBeenCalledTimes(3);
  });

  it('gives empty results when the document fails to start, and waits a minute before trying again', async () => {
    const { router, ensureOffscreen, sendToOffscreen } = setup({ ensure: async () => Promise.reject(new Error('no offscreen')) });
    expect(await router.check(REQ, CONTENT)).toEqual(EMPTY);
    clock += HARPER_RETRY_MS - 1;
    expect(await router.check(REQ, CONTENT)).toEqual(EMPTY);
    expect(ensureOffscreen).toHaveBeenCalledOnce();
    clock += 1;
    expect(await router.check(REQ, CONTENT)).toEqual(EMPTY);
    expect(ensureOffscreen).toHaveBeenCalledTimes(2);
    expect(sendToOffscreen).not.toHaveBeenCalled();
    expect(HARPER_RETRY_MS).toBe(60_000);
  });

  it('backs off the same way when the checker in the document fails to set up', async () => {
    const send = vi.fn(async (): Promise<HarperLintReply> => ({ ok: false }));
    const { router, sendToOffscreen } = setup({ send });
    expect(await router.check(REQ, CONTENT)).toEqual(EMPTY);
    clock += HARPER_RETRY_MS - 1;
    expect(await router.check(REQ, CONTENT)).toEqual(EMPTY);
    expect(sendToOffscreen).toHaveBeenCalledOnce();
    clock += 1;
    send.mockResolvedValueOnce(OK);
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
  });

  it('gives empty results for an answer later than 4000 ms, and the next check tries again on the same document', async () => {
    vi.useFakeTimers();
    const late = deferred<HarperLintReply>();
    const { router, ensureOffscreen, sendToOffscreen } = setup({ send: () => late.promise });
    const first = router.check(REQ, CONTENT);
    await vi.advanceTimersByTimeAsync(HARPER_TIMEOUT_MS - 1);
    let settled = false;
    void first.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual(EMPTY);
    late.resolve(OK);
    sendToOffscreen.mockResolvedValueOnce(OK);
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
    expect(sendToOffscreen).toHaveBeenCalledTimes(2);
    expect(ensureOffscreen).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(HARPER_TIMEOUT_MS).toBe(4000);
  });

  it('counts a start that takes longer than 4000 ms against the same deadline', async () => {
    vi.useFakeTimers();
    const { router, sendToOffscreen } = setup({ ensure: () => new Promise(() => {}) });
    const first = router.check(REQ, CONTENT);
    await vi.advanceTimersByTimeAsync(HARPER_TIMEOUT_MS);
    expect(await first).toEqual(EMPTY);
    expect(sendToOffscreen).not.toHaveBeenCalled();
  });

  it('counts a start still pending at the deadline as failed: empty results at once for a minute, then it starts again', async () => {
    vi.useFakeTimers();
    const hung = deferred<void>();
    const ensure = vi.fn<() => Promise<void>>().mockReturnValueOnce(hung.promise).mockResolvedValue(undefined);
    const { router, ensureOffscreen, sendToOffscreen } = setup({ ensure });
    const first = router.check(REQ, CONTENT);
    await vi.advanceTimersByTimeAsync(HARPER_TIMEOUT_MS);
    expect(await first).toEqual(EMPTY);

    clock += HARPER_RETRY_MS - 1;
    let settled = false;
    const second = router.check(REQ, CONTENT).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(0); // no time passes: the answer can't be waiting on a deadline
    expect(settled).toBe(true);
    expect(await second).toEqual(EMPTY);
    expect(ensureOffscreen).toHaveBeenCalledOnce();

    clock += 1;
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
    expect(ensureOffscreen).toHaveBeenCalledTimes(2);
    // The dropped start failing late neither drops the newer one nor starts another backoff.
    hung.reject(new Error('create failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
    expect(ensureOffscreen).toHaveBeenCalledTimes(2);
    expect(sendToOffscreen).toHaveBeenCalledTimes(2);
  });

  it('closes the document after two checks in a row it started get no answer in time; empty results at once for a minute, then a new one', async () => {
    vi.useFakeTimers();
    const send = vi.fn((): Promise<unknown> => new Promise(() => {})); // a checker stuck on a lint that never ends
    const { router, ensureOffscreen, sendToOffscreen, closeOffscreen } = setup({ send });
    const first = router.check(REQ, CONTENT);
    await vi.advanceTimersByTimeAsync(HARPER_TIMEOUT_MS);
    expect(await first).toEqual(EMPTY);
    expect(closeOffscreen).not.toHaveBeenCalled();
    const second = router.check(REQ, CONTENT);
    await vi.advanceTimersByTimeAsync(HARPER_TIMEOUT_MS);
    expect(await second).toEqual(EMPTY);
    expect(closeOffscreen).toHaveBeenCalledOnce();

    clock += HARPER_RETRY_MS - 1;
    let settled = false;
    const third = router.check(REQ, CONTENT).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(0); // no time passes: the answer can't be waiting on a deadline
    expect(settled).toBe(true);
    expect(await third).toEqual(EMPTY);
    expect(sendToOffscreen).toHaveBeenCalledTimes(2);

    clock += 1;
    send.mockResolvedValueOnce(OK);
    expect(await router.check(REQ, CONTENT)).toEqual(ANSWERED);
    expect(ensureOffscreen).toHaveBeenCalledTimes(2);
    expect(closeOffscreen).toHaveBeenCalledOnce();
    expect(HARPER_TIMEOUTS_BEFORE_CLOSE).toBe(2);
  });

  it('keeps the document when an answer in time comes between two late ones', async () => {
    vi.useFakeTimers();
    const send = vi.fn((): Promise<unknown> => new Promise(() => {}));
    const { router, sendToOffscreen, closeOffscreen } = setup({ send });
    const late = async () => {
      const check = router.check(REQ, CONTENT);
      await vi.advanceTimersByTimeAsync(HARPER_TIMEOUT_MS);
      expect(await check).toEqual(EMPTY);
    };
    await late();
    send.mockResolvedValueOnce(OK);
    expect(await router.check(REQ, CONTENT)).toEqual(ANSWERED);
    await late();
    expect(closeOffscreen).not.toHaveBeenCalled();
    send.mockResolvedValueOnce(OK);
    expect(await router.check(REQ, CONTENT)).toEqual(ANSWERED);
    expect(sendToOffscreen).toHaveBeenCalledTimes(4);
  });

  it('close() closes the document and the next check starts one again; a failed close never rejects', async () => {
    const { router, ensureOffscreen, closeOffscreen } = setup({ close: async () => Promise.reject(new Error('No current offscreen document')) });
    expect(await router.check(REQ, CONTENT)).toEqual(ANSWERED);
    await expect(router.close()).resolves.toBeUndefined();
    expect(closeOffscreen).toHaveBeenCalledOnce();
    expect(await router.check(REQ, CONTENT)).toEqual(ANSWERED);
    expect(ensureOffscreen).toHaveBeenCalledTimes(2);
  });

  it('turning "Instant local checks" off closes the document; turning it on closes nothing', async () => {
    const close = vi.fn(async () => {});
    const unwatch = closeWhenLocalChecksOff({ close });
    await localChecksItem.setValue(false);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await localChecksItem.setValue(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(close).toHaveBeenCalledOnce();
    unwatch();
  });

  it('never rejects: a storage failure or a malformed request gives empty results', async () => {
    const { router, ensureOffscreen, sendToOffscreen } = setup();
    vi.spyOn(disabledSitesItem, 'getValue').mockRejectedValueOnce(new Error('storage'));
    await expect(router.check(REQ, CONTENT)).resolves.toEqual(EMPTY);
    vi.spyOn(dialectItem, 'getValue').mockRejectedValueOnce(new Error('storage'));
    await expect(router.check(REQ, CONTENT)).resolves.toEqual(EMPTY);
    for (const bad of [
      null,
      { host: 'example.com', mode: 'standard' },
      { ...REQ, paragraphs: 'This is a apple.' },
      { ...REQ, paragraphs: [{ hash: 'h1' }] },
      { ...REQ, paragraphs: [null] },
    ]) {
      await expect(router.check(bad as unknown as HarperCheckRequest, CONTENT), JSON.stringify(bad)).resolves.toEqual(EMPTY);
    }
    expect(ensureOffscreen).not.toHaveBeenCalled();
    expect(sendToOffscreen).not.toHaveBeenCalled();
  });

  it('gives empty results without throwing when the start or the message fails, and starts again after a failed message', async () => {
    const failing = setup({ ensure: async () => Promise.reject(new Error('create failed')) });
    await expect(failing.router.check(REQ, CONTENT)).resolves.toEqual(EMPTY);

    const send = vi.fn(async (): Promise<unknown> => Promise.reject(new Error('Receiving end does not exist.')));
    const lost = setup({ send });
    expect(await lost.router.check(REQ, CONTENT)).toEqual(EMPTY);
    send.mockResolvedValueOnce(undefined); // no listener answered
    expect(await lost.router.check(REQ, CONTENT)).toEqual(EMPTY);
    send.mockResolvedValueOnce(OK);
    expect(await lost.router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
    expect(lost.ensureOffscreen).toHaveBeenCalledTimes(3);
  });

  it('answers off_site for a switched-off site or top-level site, and sends nothing', async () => {
    const { router, ensureOffscreen, sendToOffscreen } = setup();
    await disabledSitesItem.setValue(['example.com']);
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'off_site', results: {}, dismissed: [] });
    const frame = { ...REQ, host: 'widget.example.net' };
    expect(await router.check(frame, CONTENT)).toEqual({ status: 'off_site', results: {}, dismissed: [] });
    expect(ensureOffscreen).not.toHaveBeenCalled();
    expect(sendToOffscreen).not.toHaveBeenCalled();
  });

  it('gives empty results to a sender that is neither a content script in a tab nor an extension page', async () => {
    const { router, ensureOffscreen, sendToOffscreen } = setup();
    expect(await router.check(REQ, { url: 'https://example.com/' })).toEqual(EMPTY);
    expect(await router.check(REQ, {})).toEqual(EMPTY);
    expect(await router.check(REQ, { url: 'chrome-extension://another-extension/page.html' })).toEqual(EMPTY);
    expect(ensureOffscreen).not.toHaveBeenCalled();
    expect(sendToOffscreen).not.toHaveBeenCalled();
    expect(await router.check(REQ, PANEL)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
  });

  it('returns the dismissal keys stored for the requested paragraphs with the issues; a failed read gives none', async () => {
    const { router, dismissedFor } = setup({ dismissedFor: async (hashes) => hashes.map((h) => `${h}|a|article`) });
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: ['h1|a|article'] });
    expect(dismissedFor).toHaveBeenCalledWith(['h1']);
    dismissedFor.mockRejectedValueOnce(new Error('idb'));
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
  });

  it('with "Instant local checks" off, gives empty results and starts nothing', async () => {
    await localChecksItem.setValue(false);
    const { router, ensureOffscreen, sendToOffscreen } = setup();
    expect(await router.check(REQ, CONTENT)).toEqual(EMPTY);
    expect(ensureOffscreen).not.toHaveBeenCalled();
    expect(sendToOffscreen).not.toHaveBeenCalled();
    await localChecksItem.setValue(true);
    expect(await router.check(REQ, CONTENT)).toEqual({ status: 'ok', results: { h1: [ISSUE] }, dismissed: [] });
  });

  it('starts nothing for a request with no paragraphs', async () => {
    const { router, ensureOffscreen } = setup();
    expect(await router.check({ ...REQ, paragraphs: [] }, CONTENT)).toEqual(EMPTY);
    expect(ensureOffscreen).not.toHaveBeenCalled();
  });
});

describe('ensureOffscreen', () => {
  const api = (o: Partial<OffscreenApi> = {}): OffscreenApi => ({
    hasDocument: vi.fn(async () => false),
    createDocument: vi.fn(async () => {}),
    closeDocument: vi.fn(async () => {}),
    ...o,
  });

  it('creates the linter document for its workers when there is none', async () => {
    const offscreen = api();
    await createEnsureOffscreen(offscreen)();
    expect(offscreen.createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: "Runs EngLint's local grammar checker so it starts once instead of after every service-worker restart.",
    });
  });

  it('keeps a document an earlier service worker left', async () => {
    const offscreen = api({ hasDocument: vi.fn(async () => true) });
    await createEnsureOffscreen(offscreen)();
    expect(offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('counts "Only a single offscreen document may be created" as a document already there', async () => {
    const offscreen = api({ createDocument: vi.fn(async () => Promise.reject(new Error('Only a single offscreen document may be created.'))) });
    await expect(createEnsureOffscreen(offscreen)()).resolves.toBeUndefined();
  });

  it('fails without the offscreen API, or when creating fails for another reason', async () => {
    await expect(createEnsureOffscreen(undefined)()).rejects.toThrow();
    const offscreen = api({ createDocument: vi.fn(async () => Promise.reject(new Error('Permission denied'))) });
    await expect(createEnsureOffscreen(offscreen)()).rejects.toThrow('Permission denied');
  });

  it('closeOffscreen closes the document when there is one, and does nothing when there is none or no API', async () => {
    const open = api({ hasDocument: vi.fn(async () => true) });
    await createCloseOffscreen(open)();
    expect(open.closeDocument).toHaveBeenCalledOnce();
    const none = api();
    await createCloseOffscreen(none)();
    expect(none.closeDocument).not.toHaveBeenCalled();
    await expect(createCloseOffscreen(undefined)()).resolves.toBeUndefined();
  });
});

describe('the offscreen listener', () => {
  const lint = vi.fn(async (): Promise<HarperLintReply> => OK);
  const message: HarperLintMessage = { target: HARPER_OFFSCREEN, mode: 'standard', dialect: 'en-US', words: [], paragraphs: REQ.paragraphs };
  beforeEach(() => lint.mockClear());

  it('answers a message addressed to it from the service worker or an extension page', async () => {
    expect(await handleOffscreenMessage(message, WORKER, { extensionOrigin: ORIGIN, lint })).toEqual(OK);
    expect(await handleOffscreenMessage(message, PANEL, { extensionOrigin: ORIGIN, lint })).toEqual(OK);
    expect(lint).toHaveBeenCalledWith(message);
  });

  it('ignores anything not addressed to it, and anything from a content script', () => {
    const deps = { extensionOrigin: ORIGIN, lint };
    // What content scripts and pages send through @webext-core/messaging reaches it too.
    expect(handleOffscreenMessage({ id: 1, type: 'harperCheck', data: REQ, timestamp: 1 }, CONTENT, deps)).toBeUndefined();
    expect(handleOffscreenMessage({ ...message, target: 'something-else' }, WORKER, deps)).toBeUndefined();
    expect(handleOffscreenMessage(undefined, WORKER, deps)).toBeUndefined();
    expect(handleOffscreenMessage('harper-offscreen', WORKER, deps)).toBeUndefined();
    expect(handleOffscreenMessage(message, CONTENT, deps)).toBeUndefined();
    expect(lint).not.toHaveBeenCalled();
  });

  it('answers through sendResponse and keeps the channel open only for its own messages', async () => {
    const listener = createOffscreenListener({ extensionOrigin: ORIGIN, lint });
    const sendResponse = vi.fn();
    expect(listener(message, WORKER, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(OK));
    expect(listener({ id: 1, type: 'check', data: REQ, timestamp: 1 }, CONTENT, sendResponse)).toBe(false);
  });

  it('never throws into the sender: a checker that throws leaves the message, one that rejects answers ok: false', async () => {
    const sendResponse = vi.fn();
    const throwing = createOffscreenListener({
      extensionOrigin: ORIGIN,
      lint: () => {
        throw new Error('boom');
      },
    });
    expect(throwing(message, WORKER, sendResponse)).toBe(false);
    const rejecting = createOffscreenListener({ extensionOrigin: ORIGIN, lint: async () => Promise.reject(new Error('boom')) });
    expect(rejecting(message, WORKER, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false }));
    expect(sendResponse).toHaveBeenCalledOnce();
  });
});
