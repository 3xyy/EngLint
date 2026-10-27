import { describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { announcePage } from '../../src/content/page-announce';

/** A ContentScriptContext stand-in: its listeners and answers stop when `invalidate()` is called. */
function fakeCtx() {
  const abort = new AbortController();
  const onInvalid: (() => void)[] = [];
  const ctx = {
    addEventListener: (target: EventTarget, type: string, handler: (e: Event) => void) =>
      target.addEventListener(type, handler, { signal: abort.signal }),
    onInvalidated: (cb: () => void) => void onInvalid.push(cb),
  } as unknown as ContentScriptContext;
  return {
    ctx,
    invalidate() {
      abort.abort();
      onInvalid.forEach((cb) => cb());
    },
  };
}

function setup(prerendering = false) {
  const doc = Object.assign(new EventTarget(), { prerendering });
  const win = new EventTarget();
  const stopAnswer = vi.fn();
  const deps = { sendStarted: vi.fn(), answerPresent: vi.fn(() => stopAnswer) };
  const { ctx, invalidate } = fakeCtx();
  return { doc, win, deps, stopAnswer, invalidate, announce: () => announcePage(ctx, doc, win as Window, deps) };
}

const pageshow = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted });

describe('announcePage', () => {
  it('a shown page answers pagePresent and sends pageStarted at once', async () => {
    const { deps, announce } = setup();
    await announce();
    expect(deps.answerPresent).toHaveBeenCalledTimes(1);
    expect(deps.sendStarted).toHaveBeenCalledTimes(1);
  });

  it('a prerendered page says nothing, and answers nothing, until it is shown', async () => {
    const { doc, deps, announce } = setup(true);
    const announced = announce();
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.sendStarted).not.toHaveBeenCalled();
    expect(deps.answerPresent).not.toHaveBeenCalled();
    doc.prerendering = false;
    doc.dispatchEvent(new Event('prerenderingchange'));
    await announced;
    expect(deps.answerPresent).toHaveBeenCalledTimes(1);
    expect(deps.sendStarted).toHaveBeenCalledTimes(1);
  });

  it('a back/forward restore from the bfcache (pageshow, persisted) sends pageStarted again; a plain pageshow does not', async () => {
    const { win, deps, announce } = setup();
    await announce();
    win.dispatchEvent(pageshow(false));
    expect(deps.sendStarted).toHaveBeenCalledTimes(1);
    win.dispatchEvent(pageshow(true));
    expect(deps.sendStarted).toHaveBeenCalledTimes(2);
  });

  it('once the script is invalidated, the answer stops and a restore says nothing', async () => {
    const { win, deps, stopAnswer, invalidate, announce } = setup();
    await announce();
    invalidate();
    expect(stopAnswer).toHaveBeenCalled();
    win.dispatchEvent(pageshow(true));
    expect(deps.sendStarted).toHaveBeenCalledTimes(1);
  });
});
