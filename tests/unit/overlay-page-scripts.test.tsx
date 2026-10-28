import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createFieldLayer } from '../../src/content/overlay/field-layer';
import { mountOverlay } from '../../src/content/overlay/mount';
import { SelectionBar } from '../../src/content/overlay/SelectionBar';
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
  return {
    pick: vi.fn(),
    apply: vi.fn(),
    copy: vi.fn(async () => true),
    showVariants: vi.fn(),
    retry: vi.fn(),
    ask: vi.fn(),
    findCuts: vi.fn(),
    moreCuts: vi.fn(),
    applySelected: vi.fn(),
    close: vi.fn(),
  };
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
  expect(h.findCuts).not.toHaveBeenCalled();
  expect(h.moreCuts).not.toHaveBeenCalled();
  expect(h.applySelected).not.toHaveBeenCalled();
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
  it('the bar: its buttons and a menu\'s items', () => {
    const { h, button } = popover({ phase: 'menu', mode: 'standard', singleWord: true });
    for (const name of ['Improve', 'Shorten', 'Tone', 'My voice', 'Synonyms', 'More']) scriptClick(button(name));
    sentNothing(h);
    act(() => void userClick(button('Tone')));
    scriptClick(button('Formal'));
    sentNothing(h);
    act(() => void userClick(button('Formal')));
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

  it('the word-limit picker: a chip, Find cuts and a scripted Enter in the Target box', () => {
    const { container, h, button } = popover({ phase: 'wordLimitPick', words: 312 });
    const target = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    scriptClick(button('250'));
    expect(target.value).toBe('265'); // the chip did nothing
    scriptClick(button('Find cuts'));
    enter(target, false);
    sentNothing(h);
    act(() => void userClick(button('250')));
    act(() => void userClick(button('Find cuts')));
    enter(target, true);
    expect(h.findCuts.mock.calls).toEqual([[250], [250]]);
  });

  it('the cuts: a checkbox, Apply selected, Use full version and Find more cuts', () => {
    const original = 'It was really very good.';
    const cut = { start: 7, end: 13, original: 'really', replacement: '', why: 'filler', saves: 1, changesFacts: false };
    const { container, h, button } = popover({ phase: 'wordLimit', original, words: 5, target: 4, cuts: [cut], selected: [false], version: 'It was very good.', versionChangesFacts: false, more: true });
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    scriptClick(box);
    expect(box.checked).toBe(false);
    act(() => void userClick(box)); // picked, so Apply selected is on for the script's click below
    expect(box.checked).toBe(true);
    expect(button('Apply selected').disabled).toBe(false);
    for (const name of ['Apply selected', 'Use full version (4 words)', 'Find more cuts']) scriptClick(button(name));
    sentNothing(h);
    for (const name of ['Apply selected', 'Use full version (4 words)', 'Find more cuts']) act(() => void userClick(button(name)));
    expect([h.applySelected.mock.calls, h.apply.mock.calls, h.moreCuts.mock.calls]).toEqual([[[[true]]], [['It was very good.']], [[[true]]]]);
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

  it('the bar beside a selection', () => {
    const onPick = vi.fn();
    const { container } = render(<SelectionBar at={ANCHOR} mode="standard" onPick={onPick} />);
    const button = container.querySelector('button')!;
    scriptClick(button);
    expect(onPick).not.toHaveBeenCalled();
    userClick(button);
    expect(onPick.mock.calls).toEqual([[{ kind: 'preset', presetId: 'rewrite' }]]);
  });

  it("the results' Close and a version's Copy icon", async () => {
    const { h, button } = popover({ phase: 'variants', variants: ['a', 'b', 'c'], original: 'x' });
    scriptClick(button('Close'));
    scriptClick(button('Copy version 1'));
    expect(h.close).not.toHaveBeenCalled();
    sentNothing(h);
    await act(async () => void userClick(button('Copy version 1')));
    userClick(button('Close'));
    expect(h.copy.mock.calls).toEqual([['a']]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
});
