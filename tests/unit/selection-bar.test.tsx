import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { barPosition, SelectionBar, type SelectionBarProps } from '../../src/content/overlay/SelectionBar';

// The selection bar: what it offers for a phrase or one word, its menus, the keyboard, and where it sits.

/** A click or key the user made: the browser sets isTrusted; happy-dom never does, so the test does. */
function asUser<E extends Event>(e: E): E {
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
}
const userClick = (el: Element) => act(() => void el.dispatchEvent(asUser(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))));
const userKey = (el: Element, key: string) => act(() => void el.dispatchEvent(asUser(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))));
const key = (key: string) => fireEvent.keyDown(document.activeElement!, { key });

const AT = new DOMRect(100, 200, 120, 18);
function bar(props: Partial<SelectionBarProps> = {}) {
  const onPick = vi.fn();
  const view = render(<SelectionBar at={AT} mode="standard" onPick={onPick} {...props} />);
  const root = view.container.querySelector<HTMLElement>('.englint-bar')!;
  const top = () => [...root.querySelectorAll<HTMLButtonElement>('[data-bar-item]')];
  const named = (name: string) => top().find((b) => b.textContent === name)!;
  const items = () => [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  return { ...view, root, onPick, top, named, items };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('the selection bar', () => {
  it('a phrase gets Improve, Shorten ▾, Tone ▾, My voice and More ▾, in a toolbar named EngLint', () => {
    const b = bar();
    expect(b.root.getAttribute('role')).toBe('toolbar');
    expect(b.root.getAttribute('aria-label')).toBe('EngLint');
    expect(b.top().map((x) => x.textContent)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'More']);
    expect(b.top().map((x) => x.getAttribute('aria-haspopup'))).toEqual([null, 'menu', 'menu', null, 'menu']);
    expect(b.items()).toHaveLength(0); // no menu open
  });

  it('Improve and My voice pick their presets at once', () => {
    const b = bar();
    userClick(b.named('Improve'));
    userClick(b.named('My voice'));
    expect(b.onPick.mock.calls).toEqual([[{ kind: 'preset', presetId: 'rewrite' }], [{ kind: 'preset', presetId: 'voice' }]]);
  });

  it('Tone opens its 4 items; one picks its preset and closes the menu', () => {
    const b = bar();
    const tone = b.named('Tone');
    userClick(tone);
    expect(tone.getAttribute('aria-expanded')).toBe('true');
    const menu = b.root.querySelector('[role="menu"]')!;
    expect(tone.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.getAttribute('aria-label')).toBe('Tone');
    expect(b.items().map((i) => i.textContent)).toEqual(['Formal', 'Confident', 'Friendly', 'Casual']);
    userClick(b.items()[2]!);
    expect(b.onPick.mock.calls).toEqual([[{ kind: 'preset', presetId: 'friendlier' }]]);
    expect(b.items()).toHaveLength(0);
    expect(tone.getAttribute('aria-expanded')).toBe('false');
  });

  it('one menu at a time: opening Shorten closes Tone; a second click closes it', () => {
    const b = bar();
    userClick(b.named('Tone'));
    userClick(b.named('Shorten'));
    expect(b.items().map((i) => i.textContent)).toEqual(['Shorter', 'Fit a word limit…']);
    userClick(b.named('Shorten'));
    expect(b.items()).toHaveLength(0);
  });

  it('Shorten holds Shorter and "Fit a word limit…", which opens the word-limit tool; one word has Shorter alone', () => {
    const b = bar();
    userClick(b.named('Shorten'));
    const [shorter, limit] = b.items();
    expect(limit!.disabled).toBe(false);
    userClick(limit!);
    expect(b.onPick.mock.calls).toEqual([[{ kind: 'wordLimit' }]]);
    userClick(b.named('Shorten'));
    userClick(b.items()[0]!);
    expect(b.onPick.mock.calls[1]).toEqual([{ kind: 'preset', presetId: 'shorter' }]);
    expect(shorter!.textContent).toBe('Shorter');
    cleanup();
    const word = bar({ singleWord: true });
    userClick(word.named('Shorten'));
    expect(word.items().map((i) => i.textContent)).toEqual(['Shorter']);
  });

  it('More holds Expand, Synonyms and "Ask anything…"; an Essay page has no Expand', () => {
    const b = bar();
    userClick(b.named('More'));
    expect(b.items().map((i) => i.textContent)).toEqual(['Expand', 'Synonyms', 'Ask anything…']);
    userClick(b.items()[1]!);
    expect(b.onPick.mock.calls).toEqual([[{ kind: 'synonyms' }]]);
    cleanup();
    const essay = bar({ mode: 'essay' });
    userClick(essay.named('More'));
    expect(essay.items().map((i) => i.textContent)).toEqual(['Synonyms', 'Ask anything…']);
  });

  it('a single word shows Synonyms as its own button, and More drops it', () => {
    const b = bar({ singleWord: true });
    expect(b.top().map((x) => x.textContent)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'Synonyms', 'More']);
    userClick(b.named('Synonyms'));
    expect(b.onPick.mock.calls).toEqual([[{ kind: 'synonyms' }]]);
    userClick(b.named('More'));
    expect(b.items().map((i) => i.textContent)).toEqual(['Expand', 'Ask anything…']);
  });

  it('beside a selection it takes no focus, and pressing it keeps the field\'s focus (mousedown prevented)', () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    const b = bar();
    expect(document.activeElement).toBe(field);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    b.named('Tone').dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('beside a selection, "Ask anything…" asks for the box (custom-prompt): the popover opens it', () => {
    const b = bar();
    userClick(b.named('More'));
    userClick(b.items().at(-1)!);
    expect(b.onPick.mock.calls).toEqual([['custom-prompt']]);
    expect(b.root.querySelector('input')).toBeNull();
  });

  it('a page script clicking it picks nothing', () => {
    const b = bar();
    b.named('Improve').click();
    b.named('Tone').click();
    expect(b.items()).toHaveLength(0);
    expect(b.onPick).not.toHaveBeenCalled();
  });
});

describe('the selection bar from the keyboard (the popover\'s bar)', () => {
  it('takes focus on Improve; left and right arrows move along it and wrap; Home and End jump', () => {
    const b = bar({ focus: 'first', onAsk: vi.fn() });
    expect(document.activeElement).toBe(b.named('Improve'));
    key('ArrowRight');
    expect(document.activeElement).toBe(b.named('Shorten'));
    key('ArrowRight');
    key('ArrowRight');
    expect(document.activeElement).toBe(b.named('My voice'));
    key('ArrowRight');
    expect(document.activeElement).toBe(b.named('More'));
    key('ArrowRight');
    expect(document.activeElement).toBe(b.named('Improve'));
    key('ArrowLeft');
    expect(document.activeElement).toBe(b.named('More'));
    key('Home');
    expect(document.activeElement).toBe(b.named('Improve'));
    key('End');
    expect(document.activeElement).toBe(b.named('More'));
  });

  it('down opens a menu on its first item, up on its last; arrows move and wrap; Escape closes it and refocuses its button', () => {
    const b = bar({ focus: 'first', onAsk: vi.fn() });
    b.named('Tone').focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(b.items()[0]);
    key('ArrowDown');
    expect(document.activeElement).toBe(b.items()[1]);
    key('ArrowUp');
    key('ArrowUp');
    expect(document.activeElement).toBe(b.items()[3]); // wrapped
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    act(() => void document.activeElement!.dispatchEvent(esc));
    document.removeEventListener('keydown', reached);
    expect(b.items()).toHaveLength(0);
    expect(document.activeElement).toBe(b.named('Tone'));
    expect(reached).not.toHaveBeenCalled(); // the bar stays: the overlay never hears this Escape
    key('ArrowUp');
    expect(document.activeElement!.textContent).toBe('Casual');
  });

  it('Enter on a ▾ button opens its menu on the first item; Enter there picks it', () => {
    const b = bar({ focus: 'first', onAsk: vi.fn() });
    const tone = b.named('Tone');
    tone.focus();
    act(() => void tone.dispatchEvent(asUser(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })))); // a key's click
    expect(document.activeElement).toBe(b.items()[0]);
    userClick(document.activeElement!);
    expect(b.onPick.mock.calls).toEqual([[{ kind: 'preset', presetId: 'formal' }]]);
  });

  it('in a menu, the arrows reach "Fit a word limit…" and wrap; left and right close it and move along the bar', () => {
    const b = bar({ focus: 'first', onAsk: vi.fn() });
    b.named('Shorten').focus();
    key('ArrowDown');
    expect(document.activeElement!.textContent).toBe('Shorter');
    key('ArrowDown');
    expect(document.activeElement!.textContent).toBe('Fit a word limit…');
    key('ArrowDown');
    expect(document.activeElement!.textContent).toBe('Shorter'); // wrapped
    key('ArrowRight');
    expect(b.items()).toHaveLength(0);
    expect(document.activeElement).toBe(b.named('Tone'));
  });

  it('"Ask anything…" opens the box in the bar, focused; Enter sends what was typed', () => {
    const onAsk = vi.fn();
    const b = bar({ focus: 'first', onAsk });
    userClick(b.named('More'));
    userClick(b.items().at(-1)!);
    const input = b.root.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe('Tell EngLint what to do');
    expect(b.onPick).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'make it vivid' } });
    userKey(input, 'Enter');
    expect(onAsk.mock.calls).toEqual([['make it vivid']]);
  });

  it("focus 'custom' opens with the box focused; its button sends too, and is off while the box is blank", () => {
    const onAsk = vi.fn();
    const b = bar({ focus: 'custom', onAsk });
    const input = b.root.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    const send = b.root.querySelector<HTMLButtonElement>('.el-btn')!;
    expect(send.textContent).toBe('Rewrite');
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'shorter, please' } });
    expect(send.disabled).toBe(false);
    userClick(send);
    expect(onAsk.mock.calls).toEqual([['shorter, please']]);
  });
});

describe('barPosition', () => {
  const VIEW = { width: 1000, height: 800 };
  const SIZE = { width: 380, height: 36 };

  it('over 2,000 characters only Fit a word limit takes the selection: the rest are off, and a line under the bar says so', () => {
    const b = bar({ tooLong: 'rewrites' });
    expect(b.top().map((x) => [x.textContent, x.disabled])).toEqual([['Improve', true], ['Shorten', false], ['Tone', true], ['My voice', true], ['More', true]]);
    const hint = b.root.querySelector('.englint-bar-hint')!;
    expect(hint.textContent).toBe('Only Fit a word limit works on selections this long.');
    expect(b.root.getAttribute('aria-describedby')).toBe(hint.id);
    userClick(b.named('Improve'));
    expect(b.onPick).not.toHaveBeenCalled();
    userClick(b.named('Shorten'));
    expect(b.items().map((i) => [i.textContent, i.disabled])).toEqual([['Shorter', true], ['Fit a word limit…', false]]);
    userClick(b.items()[0]!);
    userClick(b.items()[1]!);
    expect(b.onPick.mock.calls).toEqual([[{ kind: 'wordLimit' }]]);
  });

  it('over 5,000 characters nothing takes it: every action is off, and the line gives Fit a word limit\'s limit', () => {
    const b = bar({ tooLong: 'all' });
    expect(b.top().every((x) => x.disabled)).toBe(true);
    expect(b.root.querySelector('.englint-bar-hint')!.textContent).toBe('Select up to about 5,000 characters to fit a word limit.');
  });

  it('the keyboard skips what is off: the focused bar starts on Shorten, whose menu opens on Fit a word limit', () => {
    const b = bar({ tooLong: 'rewrites', focus: 'first' });
    expect(document.activeElement).toBe(b.named('Shorten'));
    key('ArrowRight'); // the only one on: it stays
    expect(document.activeElement).toBe(b.named('Shorten'));
    key('End');
    expect(document.activeElement).toBe(b.named('Shorten'));
    key('ArrowDown');
    expect(document.activeElement!.textContent).toBe('Fit a word limit…');
  });

  it('a selection the tools all take has no line under the bar', () => {
    const b = bar();
    expect(b.root.querySelector('.englint-bar-hint')).toBeNull();
    expect(b.root.hasAttribute('aria-describedby')).toBe(false);
    expect(b.top().some((x) => x.disabled)).toBe(false);
  });

  it('sits just above the selection, from its left edge', () => {
    expect(barPosition(new DOMRect(100, 200, 120, 18), SIZE, VIEW)).toEqual({ left: 100, top: 200 - 6 - 36, side: 'above' });
  });

  it('a selection that wraps: above its first line, from the box\'s left', () => {
    expect(barPosition(new DOMRect(40, 300, 600, 54), SIZE, VIEW)).toEqual({ left: 40, top: 258, side: 'above' });
  });

  it('kept inside the viewport on the right and the left', () => {
    expect(barPosition(new DOMRect(900, 200, 50, 18), SIZE, VIEW).left).toBe(1000 - 380 - 8);
    expect(barPosition(new DOMRect(-20, 200, 50, 18), SIZE, VIEW).left).toBe(8);
  });

  it('below the selection when there is no room above', () => {
    expect(barPosition(new DOMRect(100, 20, 120, 18), SIZE, VIEW)).toEqual({ left: 100, top: 44, side: 'below' });
  });
});
