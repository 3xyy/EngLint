import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { Card } from '../../src/content/overlay/Card';
import { mountOverlay, type OverlayHandle } from '../../src/content/overlay/mount';
import type { LocatedIssue } from '../../src/core/types';

// The overlay's undo chip (OverlayHandle.showUndo), on the real overlay: the shadow-root UI is stubbed to
// mount its React root into an open shadow root the test can read.

const ui = vi.hoisted(() => ({ shadow: null as ShadowRoot | null }));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  createShadowRootUi: vi.fn(async (_ctx: unknown, options: { name: string; onMount(c: HTMLElement): unknown; onRemove?(r: unknown): void }) => {
    const shadowHost = document.createElement(options.name);
    document.documentElement.append(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const uiContainer = document.createElement('div');
    shadow.append(uiContainer);
    ui.shadow = shadow;
    let mounted: unknown;
    return {
      shadow,
      shadowHost,
      uiContainer,
      mount: () => void (mounted = options.onMount(uiContainer)),
      remove: () => options.onRemove?.(mounted),
    };
  }),
}));

const listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];
const ctx = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16),
  onInvalidated: () => {},
  addEventListener: (target: EventTarget, type: string, cb: EventListener, opts?: AddEventListenerOptions) => {
    listeners.push([target, type, cb, opts]);
    target.addEventListener(type, cb, opts);
  },
} as unknown as ContentScriptContext;

const ANCHOR = new DOMRect(10, 10, 30, 20);
const chip = () => ui.shadow!.querySelector<HTMLElement>('.englint-undo');
const undoButton = () => chip()!.querySelector<HTMLButtonElement>('button')!;

let overlay: OverlayHandle;
async function show(text: string, onUndo = vi.fn(), fieldId = 'f1') {
  await act(async () => overlay.showUndo(fieldId, ANCHOR, text, onUndo));
  return onUndo;
}
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** An event the user made: the browser sets isTrusted; happy-dom never does, so the test does. */
function trusted<E extends Event>(e: E): E {
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
}
const user = (target: EventTarget, e: Event) => act(async () => void target.dispatchEvent(trusted(e)));
const script = (target: EventTarget, e: Event) => act(async () => void target.dispatchEvent(e));

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  await act(async () => {
    overlay = await mountOverlay(ctx);
  });
});

afterEach(() => {
  for (const [target, type, cb, opts] of listeners.splice(0)) target.removeEventListener(type, cb, opts);
  cleanup();
  vi.useRealTimers();
  document.documentElement.querySelectorAll('englint-overlay').forEach((el) => el.remove());
});

describe('the undo chip', () => {
  it('shows its words and Undo where the card was; Undo undoes once and closes it, keeping focus in the field', async () => {
    const onUndo = await show('Stopped suggesting passive voice.');
    expect(chip()!.textContent).toBe('Stopped suggesting passive voice.Undo');
    expect(undoButton().textContent).toBe('Undo');

    const card = render(
      <Card issue={{ original: 'x', replacement: 'y' } as LocatedIssue} anchor={ANCHOR} onAccept={() => {}} onRewrite={() => {}} onDismiss={() => {}} onClose={() => {}} />,
    ).container.querySelector<HTMLElement>('.englint-card')!;
    expect([chip()!.style.left, chip()!.style.top]).toEqual([card.style.left, card.style.top]);

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await user(undoButton(), down);
    expect(down.defaultPrevented).toBe(true);
    await user(undoButton(), new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(chip()).toBeNull();
  });

  it('takes the side the card was on: above its text when the card was above, though the chip alone fits below', async () => {
    const text = new DOMRect(10, 300, 30, 20);
    await act(async () => overlay.showUndo('f1', text, 'Stopped suggesting passive voice.', vi.fn(), 'above'));
    expect(chip()!.dataset.side).toBe('above');
    expect(parseFloat(chip()!.style.top)).toBeLessThan(text.top);
  });

  it('closes by itself after 5 s, and Undo is gone with it', async () => {
    const onUndo = await show('Added “Kubernetes” to your dictionary.');
    await wait(4_990);
    expect(chip()).not.toBeNull();
    await wait(20);
    expect(chip()).toBeNull();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('one chip at a time: a new one replaces the old, and the old one’s timer does not cut the new one short', async () => {
    const first = await show('Stopped suggesting passive voice.');
    await wait(3_000);
    const second = await show('Stopped suggesting hedging.');
    expect(ui.shadow!.querySelectorAll('.englint-undo')).toHaveLength(1);
    expect(chip()!.textContent).toBe('Stopped suggesting hedging.Undo');
    await wait(2_500); // past the first one's 5 s
    expect(chip()).not.toBeNull();
    await user(undoButton(), new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('Esc closes it', async () => {
    const onUndo = await show('Stopped suggesting passive voice.');
    await user(document, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(chip()).not.toBeNull();
    await user(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(chip()).toBeNull();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('a click elsewhere closes it; a click on the chip outside Undo does not', async () => {
    const onUndo = await show('Stopped suggesting passive voice.');
    await user(chip()!, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(chip()).not.toBeNull();
    await user(document.body, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(chip()).toBeNull();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('a click elsewhere in the overlay closes it too', async () => {
    await show('Stopped suggesting passive voice.');
    await user(ui.shadow!.querySelector('.englint-notice')!, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(chip()).toBeNull();
  });

  it('Undo answers only the user’s own click: a page script’s click does nothing', async () => {
    const onUndo = await show('Stopped suggesting passive voice.');
    await script(undoButton(), new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onUndo).not.toHaveBeenCalled();
    expect(chip()).not.toBeNull();
    await user(undoButton(), new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('closeUndo() closes it (Esc typed where the overlay cannot see it: Docs); close() is the card’s and leaves it', async () => {
    const onUndo = await show('Stopped suggesting passive voice.');
    await act(async () => overlay.close());
    expect(chip()).not.toBeNull();
    await act(async () => overlay.closeUndo());
    expect(chip()).toBeNull();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('goes when its field is cleared (the field left), not when another field is', async () => {
    await show('Stopped suggesting passive voice.', vi.fn(), 'f1');
    await act(async () => overlay.clear('f2'));
    expect(chip()).not.toBeNull();
    await act(async () => overlay.clear('f1'));
    expect(chip()).toBeNull();
  });
});

describe('the offer chip', () => {
  const offerButtons = () => [...chip()!.querySelectorAll<HTMLButtonElement>('button')];
  async function offer(onYes = vi.fn(), onNo = vi.fn(), fieldId = 'f1') {
    await act(async () => overlay.showOffer(fieldId, ANCHOR, 'Stop suggesting passive voice in essays?', 'Stop', onYes, onNo));
    return { onYes, onNo };
  }
  const press = (button: HTMLButtonElement) => user(button, new MouseEvent('click', { bubbles: true, cancelable: true }));

  it('asks its question with the yes button and Not now, where the card was', async () => {
    await offer();
    expect(chip()!.textContent).toBe('Stop suggesting passive voice in essays?StopNot now');
    expect(offerButtons().map((b) => b.textContent)).toEqual(['Stop', 'Not now']);
    const card = render(
      <Card issue={{ original: 'x', replacement: 'y' } as LocatedIssue} anchor={ANCHOR} onAccept={() => {}} onRewrite={() => {}} onDismiss={() => {}} onClose={() => {}} />,
    ).container.querySelector<HTMLElement>('.englint-card')!;
    expect([chip()!.style.left, chip()!.style.top]).toEqual([card.style.left, card.style.top]);
  });

  it('Stop answers yes once and closes it; Not now answers no once and closes it; the buttons keep focus in the field', async () => {
    const first = await offer();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await user(offerButtons()[0]!, down);
    expect(down.defaultPrevented).toBe(true);
    await press(offerButtons()[0]!);
    expect([first.onYes.mock.calls.length, first.onNo.mock.calls.length]).toEqual([1, 0]);
    expect(chip()).toBeNull();

    const second = await offer();
    await press(offerButtons()[1]!);
    expect([second.onYes.mock.calls.length, second.onNo.mock.calls.length]).toEqual([0, 1]);
    expect(chip()).toBeNull();
  });

  it('answers only the user’s own click: a page script’s click does nothing', async () => {
    const { onYes, onNo } = await offer();
    await script(offerButtons()[0]!, new MouseEvent('click', { bubbles: true, cancelable: true }));
    await script(offerButtons()[1]!, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect([onYes, onNo].map((f) => f.mock.calls.length)).toEqual([0, 0]);
    expect(chip()).not.toBeNull();
  });

  it('closes by itself after 5 s, and on Esc, without answering either way', async () => {
    const { onYes, onNo } = await offer();
    await wait(4_990);
    expect(chip()).not.toBeNull();
    await wait(20);
    expect(chip()).toBeNull();
    await offer(onYes, onNo);
    await user(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(chip()).toBeNull();
    expect([onYes, onNo].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });

  it('is reachable by keyboard: both buttons take focus, in order', async () => {
    await offer();
    const [yes, no] = offerButtons();
    yes!.focus();
    expect(ui.shadow!.activeElement).toBe(yes);
    no!.focus();
    expect(ui.shadow!.activeElement).toBe(no);
    expect(yes!.compareDocumentPosition(no!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a second offer replaces the first, and the first one’s timer does not cut it short', async () => {
    const first = await offer();
    await wait(3_000);
    const second = await offer();
    await wait(2_500);
    expect(ui.shadow!.querySelectorAll('.englint-undo')).toHaveLength(1);
    await press(offerButtons()[0]!);
    expect([first.onYes.mock.calls.length, second.onYes.mock.calls.length]).toEqual([0, 1]);
  });

  it('a new chip replaces it (one at a time), and clearing its field closes it', async () => {
    await offer();
    await show('Stopped suggesting passive voice.');
    expect(ui.shadow!.querySelectorAll('.englint-undo')).toHaveLength(1);
    expect(chip()!.textContent).toBe('Stopped suggesting passive voice.Undo');
    await offer();
    await act(async () => overlay.clear('f1'));
    expect(chip()).toBeNull();
  });
});
