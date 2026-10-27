import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createFieldLayer } from '../../src/content/overlay/field-layer';
import { mountOverlay } from '../../src/content/overlay/mount';
import { SelectionButton } from '../../src/content/overlay/SelectionButton';
import { ToolsPopover } from '../../src/content/overlay/ToolsPopover';
import type { ToolsHandlers, ToolsView } from '../../src/content/tools/tools-controller';

// I3: a page script shares the DOM with the content script. It must not be able to reach into the overlay
// (the root is closed outside the e2e build), and a synthetic click or key it dispatches (isTrusted false)
// must not send anything even where it could reach (the e2e build's open root).

const shadowRootUi = vi.hoisted(() => ({ options: [] as { name: string; mode?: ShadowRootMode }[] }));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  createShadowRootUi: vi.fn(async (_ctx: unknown, options: { name: string; mode?: ShadowRootMode }) => {
    shadowRootUi.options.push(options);
    const shadowHost = document.createElement(options.name);
    const shadow = shadowHost.attachShadow({ mode: options.mode ?? 'open' });
    return { shadow, shadowHost, uiContainer: document.createElement('div'), mount() {}, remove() {} };
  }),
}));

/** A click or key the user made: the browser sets isTrusted; happy-dom never does, so the test does. */
function asUser<E extends Event>(e: E): E {
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
}
const userClick = (el: Element) => el.dispatchEvent(asUser(new MouseEvent('click', { bubbles: true, cancelable: true })));
const scriptClick = (el: HTMLElement) => el.click(); // what a page script can do: isTrusted false
const enter = (el: Element, user: boolean) => {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  el.dispatchEvent(user ? asUser(e) : e);
};

function handlers(): { [K in keyof ToolsHandlers]: ReturnType<typeof vi.fn> } {
  return { pick: vi.fn(), apply: vi.fn(), copy: vi.fn(async () => true), showVariants: vi.fn(), retry: vi.fn(), ask: vi.fn(), close: vi.fn() };
}
const ANCHOR = new DOMRect(10, 10, 40, 16);
const popover = (view: ToolsView, h = handlers()) => {
  const { container } = render(<ToolsPopover anchor={ANCHOR} view={view} handlers={h as unknown as ToolsHandlers} />);
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)!;
  return { container, h, button };
};
const sentNothing = (h: ReturnType<typeof handlers>) => {
  expect(h.pick).not.toHaveBeenCalled();
  expect(h.apply).not.toHaveBeenCalled();
  expect(h.showVariants).not.toHaveBeenCalled();
  expect(h.retry).not.toHaveBeenCalled();
  expect(h.ask).not.toHaveBeenCalled();
  expect(h.copy).not.toHaveBeenCalled();
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('the overlay root', () => {
  it('is closed outside the e2e build, as the field layers are: the page gets null for its shadowRoot', async () => {
    const listen = vi.fn();
    const ctx = {
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
      requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16),
      onInvalidated: vi.fn(),
      addEventListener: listen,
    } as unknown as ContentScriptContext;
    await mountOverlay(ctx);
    expect(shadowRootUi.options.at(-1)).toMatchObject({ name: 'englint-overlay', mode: 'closed' });
    expect(createFieldLayer('').host.shadowRoot).toBeNull();
  });
});

describe('a page script clicking in the popover sends nothing; the same click by the user does', () => {
  it('the menu: the presets and Synonyms', () => {
    const { h, button } = popover({ phase: 'menu', mode: 'standard' });
    for (const name of ['Rewrite', 'Shorter', 'Clearer', 'More formal', 'Synonyms']) scriptClick(button(name));
    sentNothing(h);
    userClick(button('More formal'));
    userClick(button('Synonyms'));
    expect(h.pick.mock.calls).toEqual([[{ kind: 'preset', presetId: 'formal' }], [{ kind: 'synonyms' }]]);
  });

  it('the custom instruction: a scripted Enter sends nothing', () => {
    const { container, h } = popover({ phase: 'menu', mode: 'standard', focus: 'custom' });
    const input = container.querySelector('input')!;
    enter(input, false);
    sentNothing(h);
    enter(input, true);
    expect(h.pick).toHaveBeenCalledTimes(1); // blank: the controller drops it, but the user's key gets through
  });

  it('the critique: the light fix and Show 3 rewrites', () => {
    const { h, button } = popover({ phase: 'critique', weakness: 'w', lightFix: 'I have a cat.', original: 'I has a cat.' });
    scriptClick(button('Use this version'));
    scriptClick(button('Show 3 rewrites'));
    sentNothing(h);
    userClick(button('Use this version'));
    userClick(button('Show 3 rewrites'));
    expect(h.apply.mock.calls).toEqual([['I have a cat.']]);
    expect(h.showVariants).toHaveBeenCalledTimes(1);
  });

  it('the versions and the synonym options', () => {
    const versions = popover({ phase: 'variants', variants: ['a', 'b', 'c'], original: 'x' });
    scriptClick(versions.button('Use version 2'));
    sentNothing(versions.h);
    userClick(versions.button('Use version 2'));
    expect(versions.h.apply.mock.calls).toEqual([['b']]);
    cleanup();

    const words = popover({ phase: 'synonyms', options: [{ text: 'glad', nuance: 'n' }] });
    const option = words.container.querySelector<HTMLButtonElement>('.englint-tools-option')!;
    scriptClick(option);
    sentNothing(words.h);
    userClick(option);
    expect(words.h.apply.mock.calls).toEqual([['glad']]);
  });

  it('Sound like me: its version, and Copy when the version changes a claim (it then reads Copied)', async () => {
    const shown = popover({ phase: 'voice', tells: ['a staged contrast'], final: 'I have a cat.', original: 'I has a cat.', canApply: true });
    scriptClick(shown.button('Use this version'));
    sentNothing(shown.h);
    userClick(shown.button('Use this version'));
    expect(shown.h.apply.mock.calls).toEqual([['I have a cat.']]);
    cleanup();

    const facts = popover({ phase: 'voice', tells: [], final: 'I have 2 cats.', original: 'I has a cat.', canApply: false });
    const copy = facts.button('Copy this version');
    scriptClick(copy);
    sentNothing(facts.h);
    await act(async () => {
      userClick(copy);
    });
    expect(facts.h.copy.mock.calls).toEqual([['I have 2 cats.']]);
    expect(facts.h.apply).not.toHaveBeenCalled();
    const status = facts.container.querySelector('.englint-sr-only[role="status"]')!;
    expect(copy.textContent).toBe('Copied');
    expect(status.textContent).toBe('Copied.');
    facts.h.copy.mockResolvedValueOnce(false);
    await act(async () => {
      userClick(copy);
    });
    expect(copy.textContent).toBe("Couldn't copy");
    expect(status.textContent).toBe("Couldn't copy.");
  });

  it("the follow-up box: a scripted Enter asks nothing; the user's Enter asks what was typed", () => {
    const { container, h } = popover({ phase: 'variants', variants: ['a', 'b', 'c'], original: 'x' });
    const box = container.querySelector<HTMLInputElement>('input[aria-label="Ask a follow-up"]')!;
    fireEvent.change(box, { target: { value: 'less formal' } });
    enter(box, false);
    sentNothing(h);
    enter(box, true);
    expect(h.ask.mock.calls).toEqual([['less formal']]);
  });

  it("an answer's versions", () => {
    const { h, button } = popover({ phase: 'answer', message: 'm', variants: ['a', 'b'], original: 'x' });
    scriptClick(button('Use version 2'));
    sentNothing(h);
    userClick(button('Use version 2'));
    expect(h.apply.mock.calls).toEqual([['b']]);
  });

  it('Retry', () => {
    const { h, button } = popover({ phase: 'error', text: 'busy', retry: true });
    scriptClick(button('Retry'));
    sentNothing(h);
    userClick(button('Retry'));
    expect(h.retry).toHaveBeenCalledTimes(1);
  });

  it('the selection button', () => {
    const onClick = vi.fn();
    const { container } = render(<SelectionButton at={ANCHOR} onClick={onClick} />);
    const button = container.querySelector('button')!;
    scriptClick(button);
    expect(onClick).not.toHaveBeenCalled();
    userClick(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
