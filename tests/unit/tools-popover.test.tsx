import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolsPopover } from '../../src/content/overlay/ToolsPopover';
import type { ToolsHandlers, ToolsView } from '../../src/content/tools/tools-controller';
import { countWords } from '../../src/core/doc-stats';
import type { WordLimitCut } from '../../src/core/word-limit';

const handlers = {
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
} as unknown as ToolsHandlers;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A click the user made: the browser sets isTrusted; happy-dom never does, so the test does. */
const userClick = (el: Element) =>
  act(() => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    Object.defineProperty(e, 'isTrusted', { value: true });
    el.dispatchEvent(e);
  });
/** The results under the header, in order. */
const body = (c: HTMLElement) => c.querySelector('.englint-tools-body')!;

describe('ToolsPopover placement', () => {
  it('stays inside the viewport when its anchor moves to where it fits on neither side', () => {
    const height = Math.round(window.innerHeight / 2) + 50;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 300);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, height));
    const view = { phase: 'loading', label: 'Rewriting…' } as const;
    const { container, rerender } = render(<ToolsPopover anchor={new DOMRect(10, 5, 40, 16)} view={view} handlers={handlers} />);
    const el = container.querySelector<HTMLElement>('.englint-tools')!;

    rerender(<ToolsPopover anchor={new DOMRect(10, window.innerHeight / 2, 40, 16)} view={view} handlers={handlers} />);
    expect(parseFloat(el.style.top)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(el.style.top) + height).toBeLessThanOrEqual(window.innerHeight - 8);
  });

  it('flips above, clear of its anchor, when it grows past the room below', () => {
    const size = { height: 100 };
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 300);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => size.height);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, size.height));
    const anchor = new DOMRect(10, window.innerHeight - 250, 40, 16);
    const { container, rerender } = render(<ToolsPopover anchor={anchor} view={{ phase: 'loading', label: 'Rewriting…' }} handlers={handlers} />);
    const el = container.querySelector<HTMLElement>('.englint-tools')!;
    expect(el.dataset.side).toBe('below');

    size.height = 300; // results arrive: it no longer fits below the text
    rerender(<ToolsPopover anchor={anchor} view={{ phase: 'variants', variants: ['a', 'b', 'c'], original: 'x' }} handlers={handlers} />);
    expect(el.dataset.side).toBe('above');
    expect(parseFloat(el.style.top) + 300).toBeLessThanOrEqual(anchor.top);
  });
});

describe('ToolsPopover: its first view is the selection bar, focused', () => {
  const at = new DOMRect(10, 200, 40, 16);
  const labels = (c: HTMLElement) => [...c.querySelectorAll('[data-bar-item]')].map((b) => b.textContent);

  it('the shortcut\'s view: the bar for the mode, focused on Improve, with no results card', () => {
    const { container } = render(<ToolsPopover anchor={at} view={{ phase: 'menu', mode: 'standard' }} handlers={handlers} />);
    expect(container.querySelector('.englint-tools')).toBeNull();
    expect(labels(container)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'More']);
    expect(document.activeElement!.textContent).toBe('Improve');
    cleanup();
    const word = render(<ToolsPopover anchor={at} view={{ phase: 'menu', mode: 'essay', singleWord: true }} handlers={handlers} />);
    expect(labels(word.container)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'Synonyms', 'More']);
  });

  it('for a selection over 2,000 characters, the bar offers only Fit a word limit, focused on Shorten, and says why', () => {
    const { container } = render(<ToolsPopover anchor={at} view={{ phase: 'menu', mode: 'standard', tooLong: 'rewrites' }} handlers={handlers} />);
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-bar-item]')].filter((b) => !b.disabled).map((b) => b.textContent)).toEqual(['Shorten']);
    expect(document.activeElement!.textContent).toBe('Shorten');
    expect(container.querySelector('.englint-bar-hint')!.textContent).toBe('Only Fit a word limit works on selections this long.');
  });

  it('a pick on it goes to the controller', () => {
    const h = { ...handlers, pick: vi.fn() } as ToolsHandlers;
    const { container } = render(<ToolsPopover anchor={at} view={{ phase: 'menu', mode: 'standard' }} handlers={h} />);
    userClick([...container.querySelectorAll('[data-bar-item]')].find((b) => b.textContent === 'Improve')!);
    expect(h.pick).toHaveBeenCalledWith({ kind: 'preset', presetId: 'rewrite' });
  });

  it("focus 'custom' (\"Ask anything…\" from the right-click menu): the box is open and focused, and Enter sends the instruction", () => {
    const h = { ...handlers, pick: vi.fn() } as ToolsHandlers;
    const { container } = render(<ToolsPopover anchor={at} view={{ phase: 'menu', mode: 'standard', focus: 'custom' }} handlers={h} />);
    const input = container.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'make it vivid' } });
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'isTrusted', { value: true });
    act(() => void input.dispatchEvent(e));
    expect(h.pick).toHaveBeenCalledWith({ kind: 'custom', instruction: 'make it vivid' });
  });
});

describe('ToolsPopover results', () => {
  const at = new DOMRect(10, 5, 40, 16);
  const variants: ToolsView = { phase: 'variants', variants: ['I have a cat', 'I own a cat'], original: 'I has a cat' };

  it('the header names the action, and Close closes it (focus back to the field)', () => {
    const h = { ...handlers, close: vi.fn() } as ToolsHandlers;
    const { container } = render(<ToolsPopover anchor={at} view={variants} handlers={h} title="Tone · Formal" />);
    const head = container.querySelector('.englint-tools-head')!;
    expect(head.querySelector('.englint-tools-title')!.textContent).toBe('Tone · Formal');
    expect(container.querySelector('.englint-tools')!.getAttribute('aria-label')).toBe('EngLint: Tone · Formal');
    const close = head.querySelector<HTMLButtonElement>('button')!;
    expect(close.getAttribute('aria-label')).toBe('Close');
    userClick(close);
    expect(h.close).toHaveBeenCalledWith();
  });

  it('with no action yet (a selection over the limit), the header reads EngLint', () => {
    const { container } = render(<ToolsPopover anchor={at} view={{ phase: 'error', text: 'Select up to about 2,000 characters.' }} handlers={handlers} />);
    expect(container.querySelector('.englint-tools-title')!.textContent).toBe('EngLint');
  });

  it('each version is a card: its diff applies it, and a small Copy icon copies it (then shows a check)', async () => {
    const h = { ...handlers, apply: vi.fn(), copy: vi.fn(async () => true) } as unknown as ToolsHandlers;
    const { container } = render(<ToolsPopover anchor={at} view={variants} handlers={h} title="Improve" />);
    const cards = [...container.querySelectorAll('.englint-tools-card')];
    expect(cards).toHaveLength(2);
    const [row, copy] = [...cards[1]!.querySelectorAll('button')];
    expect(row!.getAttribute('aria-label')).toBe('Use version 2');
    expect(row!.querySelector('ins')!.textContent).toBe('own');
    expect(copy!.getAttribute('aria-label')).toBe('Copy version 2');
    expect(copy!.className).toContain('el-icon-btn');
    userClick(row!);
    expect(h.apply).toHaveBeenCalledWith('I own a cat');
    const before = copy!.innerHTML;
    await act(async () => userClick(copy!));
    expect(h.copy).toHaveBeenCalledWith('I own a cat');
    expect(copy!.innerHTML).not.toBe(before); // the check
    expect(cards[1]!.querySelector('.englint-sr-only')!.textContent).toBe('Copied.');
  });

  it('the arrows skip Close and the Copy icons: they move from version to version, and on to the follow-up box', () => {
    const { container } = render(<ToolsPopover anchor={at} view={variants} handlers={handlers} title="Improve" />);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.englint-tools-row')];
    expect(document.activeElement).toBe(rows[0]); // not Close
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Ask a follow-up');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[0]);
  });

  it('the critique is one line above its light fix', () => {
    const { container } = render(<ToolsPopover anchor={at} view={{ phase: 'critique', weakness: 'The verb does not agree with "I".', lightFix: 'I have a cat', original: 'I has a cat' }} handlers={handlers} title="Improve" />);
    const first = body(container).firstElementChild!;
    expect(first.className).toBe('englint-tools-weakness');
    expect(first.textContent).toBe('The verb does not agree with "I".');
    expect(first.nextElementSibling!.className).toBe('englint-tools-card');
  });
});

describe('ToolsPopover follow-ups', () => {
  const at = new DOMRect(10, 5, 40, 16);
  const draw = (view: ToolsView) => render(<ToolsPopover anchor={at} view={view} handlers={handlers} />).container;
  const box = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[placeholder="Ask a follow-up…"]');

  it('every result has an "Ask a follow-up…" box after it, up to 500 characters; the menu, loading and errors do not', () => {
    const results: ToolsView[] = [
      { phase: 'variants', variants: ['a', 'b', 'c'], original: 'x' },
      { phase: 'critique', weakness: 'w', lightFix: 'f', original: 'x' },
      { phase: 'synonyms', options: [{ text: 'big', nuance: 'n' }] },
      { phase: 'answer', message: 'm', variants: [], original: 'x' },
      { phase: 'voice', tells: ['a staged contrast'], final: 'y', original: 'x', canApply: true },
      { phase: 'voice', tells: [], final: 'y 2', original: 'x', canApply: false },
      { phase: 'voice', tells: [], final: 'x', original: 'x', canApply: false, unchanged: true },
      { phase: 'critique', weakness: 'w', lightFix: 'f 2', original: 'x', voice: true, canApply: false },
      { phase: 'answer', message: 'm', variants: ['y 2'], original: 'x', canApply: [false] },
    ];
    for (const view of results) {
      const c = draw(view);
      const input = box(c);
      expect(input, view.phase).not.toBeNull();
      expect(input!.maxLength, view.phase).toBe(500);
      expect(input!.getAttribute('aria-label'), view.phase).toBe('Ask a follow-up');
      expect(body(c).lastElementChild, view.phase).toBe(input); // after the results
      cleanup();
    }
    const limit = { phase: 'wordLimit', original: 'a b c', words: 3, target: 2, cuts: [], selected: [], version: 'a b', versionChangesFacts: false, more: true } as const;
    for (const view of [{ phase: 'menu', mode: 'standard' }, { phase: 'loading', label: 'l' }, { phase: 'error', text: 'e', retry: true }, { phase: 'wordLimitPick', words: 9 }, limit] as ToolsView[]) {
      expect(box(draw(view)), view.phase).toBeNull();
      cleanup();
    }
  });

  it('an answer shows its message, then each version as a diff row, then the box', () => {
    const c = draw({ phase: 'answer', message: 'Less formal now.', variants: ['I have a cat', 'I got a cat'], original: 'I has a cat' });
    const pop = body(c);
    expect(pop.firstElementChild!.className).toBe('englint-tools-message');
    expect(pop.firstElementChild!.textContent).toBe('Less formal now.');
    const rows = Array.from(c.querySelectorAll<HTMLButtonElement>('.englint-tools-row'));
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Use version 1', 'Use version 2']);
    expect(rows[1]!.querySelector('del')!.textContent).toBe('has');
    expect(rows[1]!.querySelector('ins')!.textContent).toBe('got');
    expect(box(c)).not.toBeNull();
  });

  it('once no more can be asked, the box reads "Start a new request for more." and takes no input', () => {
    const c = draw({ phase: 'answer', message: 'm', variants: ['v'], original: 'x', exhausted: true });
    expect(box(c)).toBeNull();
    const input = c.querySelector<HTMLInputElement>('.englint-tools-input')!;
    expect(input.placeholder).toBe('Start a new request for more.');
    expect(input.disabled).toBe(true);
  });

  it('the used-up box is skipped by the arrows: from the last version they wrap to the first', () => {
    const c = draw({ phase: 'answer', message: 'm', variants: ['a', 'b'], original: 'x', exhausted: true });
    const rows = Array.from(c.querySelectorAll<HTMLButtonElement>('.englint-tools-row'));
    expect(document.activeElement).toBe(rows[0]); // the first item takes focus
    rows[1]!.focus();
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[0]);
  });
});

describe('ToolsPopover Sound like me', () => {
  const at = new DOMRect(10, 5, 40, 16);
  const draw = (view: ToolsView) => render(<ToolsPopover anchor={at} view={view} handlers={handlers} />).container;
  const ORIGINAL = 'It was not just a trip, it was a journey.';

  it('names the generic patterns found above one diff that applies the version, with its Copy icon; no note', () => {
    const c = draw({ phase: 'voice', tells: ['a staged contrast', 'an inflated claim'], final: 'It was a long trip.', original: ORIGINAL, canApply: true });
    const pop = body(c);
    expect(pop.firstElementChild!.className).toBe('englint-tools-tells');
    expect(pop.firstElementChild!.textContent).toBe('Generic patterns found: a staged contrast, an inflated claim');
    const rows = c.querySelectorAll<HTMLButtonElement>('.englint-tools-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tagName).toBe('BUTTON');
    expect(rows[0]!.getAttribute('aria-label')).toBe('Use this version');
    expect(rows[0]!.querySelectorAll('ins').length).toBeGreaterThan(0);
    expect(rows[0]!.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(c.querySelector('[aria-label="Copy this version"]')!.className).toContain('englint-tools-copy');
    expect(c.querySelector('.englint-tools-copy-text')).toBeNull(); // no Copy button: the version applies
    expect(c.textContent).not.toContain('Check the facts');
    expect(c.querySelectorAll('.englint-tools-version')).toHaveLength(0);
  });

  it('with no tells it says so, and still shows the diff', () => {
    const c = draw({ phase: 'voice', tells: [], final: 'It was a long trip.', original: ORIGINAL, canApply: true });
    expect(c.querySelector('.englint-tools-tells')!.textContent).toBe('No generic patterns found.');
    expect(c.querySelectorAll('.englint-tools-row')).toHaveLength(1);
  });

  it('a version that changes a claim shows its diff with nothing to apply, the fact note and Copy', () => {
    const c = draw({ phase: 'voice', tells: ['an inflated claim'], final: 'It took 3 days.', original: ORIGINAL, canApply: false });
    expect(c.querySelectorAll('.englint-tools-row')).toHaveLength(0);
    expect(c.querySelector('[aria-label="Use this version"]')).toBeNull();
    const diff = c.querySelectorAll('.englint-tools-version');
    expect(diff).toHaveLength(1);
    expect(diff[0]!.tagName).not.toBe('BUTTON');
    expect(diff[0]!.querySelector('ins')!.textContent).toContain('3');
    expect(c.querySelector('.englint-tools-note')!.textContent).toBe('Check the facts: this version changes a number, name or quote.');
    const copy = c.querySelector<HTMLButtonElement>('[aria-label="Copy this version"]')!;
    expect(copy.textContent).toBe('Copy');
    expect(document.activeElement).toBe(copy); // the first item takes focus
  });
});

describe('ToolsPopover Sound like me: the claims gate everywhere it applies', () => {
  const at = new DOMRect(10, 5, 40, 16);
  const draw = (view: ToolsView) => render(<ToolsPopover anchor={at} view={view} handlers={handlers} />).container;
  const ORIGINAL = 'It was not just a trip, it was a journey.';
  /** The results' buttons (not the header's Close). */
  const buttons = (c: HTMLElement) => Array.from(body(c).querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent);

  it('its critique offers "Show the version", not "Show 3 rewrites"; a light fix that keeps the claims applies', () => {
    const c = draw({ phase: 'critique', weakness: 'It sounds staged.', lightFix: 'It was a long trip.', original: ORIGINAL, voice: true, canApply: true });
    expect(buttons(c)).toEqual(['Use this version', 'Copy this version', 'Show the version']);
    expect(c.textContent).not.toContain('Check the facts');
  });

  it('a light fix that changes a claim shows its diff with nothing to apply, the fact note and Copy', () => {
    const c = draw({ phase: 'critique', weakness: 'It sounds staged.', lightFix: 'It took 3 days.', original: ORIGINAL, voice: true, canApply: false });
    expect(buttons(c)).toEqual(['Copy this version', 'Show the version']);
    expect(c.querySelector('.englint-tools-version ins')!.textContent).toContain('3');
    expect(c.querySelector('.englint-tools-note')!.textContent).toBe('Check the facts: this version changes a number, name or quote.');
  });

  it('another preset\'s critique still offers "Show 3 rewrites"', () => {
    const c = draw({ phase: 'critique', weakness: 'w', lightFix: 'It took 3 days.', original: ORIGINAL });
    expect(buttons(c)).toEqual(['Use this version', 'Copy this version', 'Show 3 rewrites']);
  });

  it('the passage back as it was: it says so, with no diff, nothing to apply and no Copy', () => {
    const c = draw({ phase: 'voice', tells: [], final: ORIGINAL, original: ORIGINAL, canApply: false, unchanged: true });
    expect(c.querySelector('.englint-tools-tells')!.textContent).toBe('No generic patterns found. This already sounds like you.');
    expect(c.querySelectorAll('del, ins, .englint-tools-row, .englint-tools-version')).toHaveLength(0);
    expect(buttons(c)).toEqual([]);
    expect(c.querySelector('input[aria-label="Ask a follow-up"]')).not.toBeNull();
  });

  it('a follow-up answer after it: a version that keeps the claims applies; one that changes them shows the note and Copy', () => {
    const c = draw({ phase: 'answer', message: 'Shorter now.', variants: ['It was a trip.', 'It took 3 days.'], original: ORIGINAL, canApply: [true, false] });
    expect(buttons(c)).toEqual(['Use version 1', 'Copy version 1', 'Copy version 2']);
    expect(c.querySelectorAll('.englint-tools-version')).toHaveLength(1);
    expect(c.querySelector('.englint-tools-version ins')!.textContent).toContain('3');
    expect(c.querySelectorAll('.englint-tools-note')).toHaveLength(1);
  });
});

describe('ToolsPopover: fit a word limit', () => {
  const at = new DOMRect(10, 5, 40, 16);
  const fresh = () => ({ ...handlers, findCuts: vi.fn(), moreCuts: vi.fn(), applySelected: vi.fn(), apply: vi.fn() }) as unknown as ToolsHandlers & Record<'findCuts' | 'moreCuts' | 'applySelected' | 'apply', ReturnType<typeof vi.fn>>;
  const draw = (view: ToolsView, h = fresh()) => ({ h, c: render(<ToolsPopover anchor={at} view={view} handlers={h} title="Fit a word limit" />).container });
  const userKey = (el: Element, key: string) =>
    act(() => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'isTrusted', { value: true });
      el.dispatchEvent(e);
    });

  describe('the target picker', () => {
    const target = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="number"]')!;
    const find = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Find cuts')!;
    const chips = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('.el-wl-chip')];

    it('says how many words are selected and starts the Target at 85%, rounded to 5, focused', () => {
      const { c } = draw({ phase: 'wordLimitPick', words: 312 });
      expect(c.querySelector('.el-wl-count')!.textContent).toBe('312 words selected');
      const input = target(c);
      expect(input.value).toBe('265');
      expect(c.querySelector(`label[for="${input.id}"]`)!.textContent).toBe('Target');
      expect(document.activeElement).toBe(input);
    });
    it('offers the common limits below the words as chips; a chip sets the Target, and Find cuts sends it', () => {
      const { c, h } = draw({ phase: 'wordLimitPick', words: 312 });
      expect(chips(c).map((b) => b.textContent)).toEqual(['150', '250']);
      expect(c.querySelector('.el-wl-chips')!.getAttribute('aria-label')).toBe('Common limits');
      userClick(chips(c)[1]!);
      expect(target(c).value).toBe('250');
      expect(chips(c).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
      expect(h.findCuts).not.toHaveBeenCalled(); // a chip only sets it
      userClick(find(c));
      expect(h.findCuts.mock.calls).toEqual([[250]]);
      cleanup();
      expect(chips(draw({ phase: 'wordLimitPick', words: 120 }).c)).toEqual([]);
    });
    it('Enter in the Target box finds cuts; a target outside 1 to one under the words turns Find cuts off', () => {
      const { c, h } = draw({ phase: 'wordLimitPick', words: 312 });
      for (const v of ['312', '0', '12.5', '']) {
        fireEvent.change(target(c), { target: { value: v } });
        expect(find(c).disabled, v).toBe(true);
        userKey(target(c), 'Enter');
      }
      expect(h.findCuts).not.toHaveBeenCalled();
      fireEvent.change(target(c), { target: { value: '200' } });
      expect(find(c).disabled).toBe(false);
      userKey(target(c), 'Enter');
      expect(h.findCuts.mock.calls).toEqual([[200]]);
    });
    it('its arrow keys step the number: the popover does not take them to move focus', () => {
      const { c } = draw({ phase: 'wordLimitPick', words: 312 });
      const e = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      act(() => void target(c).dispatchEvent(e));
      expect(e.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(target(c));
    });
  });

  describe('the cuts', () => {
    const SEL = 'In order to win the final, we really practiced every single day after school.'; // 14 words
    const cutOf = (original: string, replacement: string, why: string, changesFacts = false): WordLimitCut => {
      const start = SEL.indexOf(original);
      return { start, end: start + original.length, original, replacement, why, saves: countWords(original) - countWords(replacement), changesFacts };
    };
    const CUTS = [cutOf('In order to', 'To', 'wordy opening'), cutOf('really', '', 'a filler word'), cutOf('after school', '', 'drops when you practiced', true)];
    const VIEW: ToolsView = { phase: 'wordLimit', original: SEL, words: 14, target: 11, cuts: CUTS, selected: [true, false, false], version: 'To win the final, we practiced daily.', versionChangesFacts: false, more: true };
    const boxes = (c: HTMLElement) => [...c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const counter = (c: HTMLElement) => c.querySelector('.el-wl-counter')!;
    const button = (c: HTMLElement, name: string | RegExp) => [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof name === 'string' ? b.textContent === name : name.test(b.textContent ?? '')));

    it('a header with the words and the target, the live counter, and each cut with a checkbox, its diff in context, its savings and why', () => {
      const { c } = draw(VIEW);
      expect(c.querySelector('.el-wl-head')!.textContent).toBe('14 → 11 words');
      expect(counter(c).textContent).toBe('Selected cuts: 12 words (1 to go)');
      expect(counter(c).getAttribute('role')).toBe('status');
      const rows = [...c.querySelectorAll('.el-wl-cut')];
      expect(rows).toHaveLength(3);
      expect(boxes(c).map((b) => b.checked)).toEqual([true, false, false]);
      expect(boxes(c).map((b) => b.getAttribute('aria-label'))).toEqual(['Replace “In order to” with “To”', 'Delete “really”', 'Delete “after school”']);
      expect(rows[1]!.querySelector('del')!.textContent).toBe('really');
      expect(rows[1]!.querySelector('ins')).toBeNull();
      expect(rows[1]!.querySelector('.el-diff')!.textContent).toBe('…the final, we really practiced every single…'); // three words each side
      expect(rows[0]!.querySelector('ins')!.textContent).toBe('To');
      expect([...rows].map((r) => r.querySelector('.el-wl-saves')!.textContent)).toEqual(['−2 words', '−1 word', '−2 words']);
      expect(rows[1]!.querySelector('.el-wl-why')!.textContent).toBe('a filler word');
    });
    it('a cut that changes a fact carries "Changes a fact" and starts unchecked', () => {
      const { c } = draw(VIEW);
      const rows = [...c.querySelectorAll('.el-wl-cut')];
      expect(rows.map((r) => r.querySelector('.el-wl-fact')?.textContent ?? null)).toEqual([null, null, 'Changes a fact']);
      expect(boxes(c)[2]!.checked).toBe(false);
    });
    it('checking a cut updates the counter, which turns green at or under the target; unchecking takes it back', () => {
      const { c } = draw(VIEW);
      expect(counter(c).classList.contains('el-wl-ok')).toBe(false);
      userClick(boxes(c)[1]!);
      expect(counter(c).textContent).toBe('Selected cuts: 11 words (at the limit)');
      expect(counter(c).classList.contains('el-wl-ok')).toBe(true);
      userClick(boxes(c)[2]!);
      expect(counter(c).textContent).toBe('Selected cuts: 9 words (2 under)');
      userClick(boxes(c)[1]!);
      userClick(boxes(c)[2]!);
      expect(counter(c).textContent).toBe('Selected cuts: 12 words (1 to go)');
      expect(counter(c).classList.contains('el-wl-ok')).toBe(false);
    });
    it('Apply selected sends the picks, and is off with none; Use full version (N words) applies the version; Find more cuts sends the picks', () => {
      const { c, h } = draw(VIEW);
      userClick(boxes(c)[1]!);
      userClick(button(c, 'Apply selected')!);
      expect(h.applySelected.mock.calls).toEqual([[[true, true, false]]]);
      userClick(button(c, 'Use full version (7 words)')!);
      expect(h.apply.mock.calls).toEqual([['To win the final, we practiced daily.']]);
      userClick(button(c, 'Find more cuts')!);
      expect(h.moreCuts.mock.calls).toEqual([[[true, true, false]]]);
      userClick(boxes(c)[0]!);
      userClick(boxes(c)[1]!);
      expect(button(c, 'Apply selected')!.disabled).toBe(true);
    });
    it('the full-version button counts the version\'s words itself, as the counter does (a hyphenated word is two)', () => {
      const { c } = draw({ ...VIEW, version: 'To win the hard-fought final, we practiced daily.' } as ToolsView);
      expect(button(c, /full version/)!.textContent).toBe('Use full version (9 words)');
    });
    it('a version that changes a fact has the fact note under the buttons, which describes Use full version; it still applies', () => {
      const { c, h } = draw({ ...VIEW, versionChangesFacts: true } as ToolsView);
      const note = c.querySelector('.el-wl-facts')!;
      expect(note.textContent).toBe('Check the facts: this version changes a number, name or quote.');
      const use = button(c, /full version/)!;
      expect(use.getAttribute('aria-describedby')).toBe(note.id);
      expect(use.disabled).toBe(false);
      userClick(use);
      expect(h.apply.mock.calls).toEqual([['To win the final, we practiced daily.']]);
      cleanup();
      const plain = draw({ ...VIEW, versionChangesFacts: false } as ToolsView).c;
      expect(plain.querySelector('.el-wl-facts')).toBeNull();
      expect(button(plain, /full version/)!.hasAttribute('aria-describedby')).toBe(false);
    });
    it('a failed search for more: its status under the cuts, as an alert, with the picks and the buttons kept', () => {
      const { c } = draw({ ...VIEW, error: 'Claude is busy right now. Try again in a moment.' } as ToolsView);
      const error = c.querySelector('.el-wl-error')!;
      expect(error.textContent).toBe('Claude is busy right now. Try again in a moment.');
      expect(error.getAttribute('role')).toBe('alert');
      expect(boxes(c).map((b) => b.checked)).toEqual([true, false, false]);
      expect(button(c, 'Find more cuts')).toBeDefined();
      expect(c.querySelector('.el-wl-note:not(.el-wl-error)')).toBeNull();
    });
    it('no version: no full-version button; none offered: no Find more cuts; none found: it says so', () => {
      const { c } = draw({ ...VIEW, version: null, more: false, noneNew: true } as ToolsView);
      expect(button(c, /full version/)).toBeUndefined();
      expect(button(c, 'Find more cuts')).toBeUndefined();
      expect(c.querySelector('.el-wl-note')!.textContent).toBe('No other cuts found.');
    });
    it('the first checkbox takes focus; the arrows move through the checkboxes, then the buttons', () => {
      const { c } = draw(VIEW);
      expect(document.activeElement).toBe(boxes(c)[0]);
      fireEvent.keyDown(boxes(c)[0]!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(boxes(c)[1]);
      fireEvent.keyDown(boxes(c)[1]!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(boxes(c)[2]);
      fireEvent.keyDown(boxes(c)[2]!, { key: 'ArrowDown' });
      expect(document.activeElement!.textContent).toBe('Apply selected');
    });
    it('more cuts from a search for more start from the view\'s picks: the writer\'s, and a new cut picked for them', () => {
      const h = fresh();
      const { rerender, container: c } = render(<ToolsPopover anchor={at} view={{ ...VIEW, cuts: CUTS.slice(0, 2), selected: [true, false] } as ToolsView} handlers={h} />);
      userClick(boxes(c)[1]!);
      rerender(<ToolsPopover anchor={at} view={{ ...VIEW, selected: [true, true, true] }} handlers={h} />);
      expect(boxes(c).map((b) => b.checked)).toEqual([true, true, true]);
      expect(counter(c).textContent).toBe('Selected cuts: 9 words (2 under)');
    });
  });
});
