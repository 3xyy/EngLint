import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolsPopover } from '../../src/content/overlay/ToolsPopover';
import type { ToolsHandlers, ToolsView } from '../../src/content/tools/tools-controller';

const handlers = { pick: vi.fn(), apply: vi.fn(), copy: vi.fn(async () => true), showVariants: vi.fn(), retry: vi.fn(), ask: vi.fn(), close: vi.fn() } as unknown as ToolsHandlers;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ToolsPopover placement', () => {
  it('stays inside the viewport when its anchor moves to where it fits on neither side', () => {
    const height = Math.round(window.innerHeight / 2) + 50;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 300);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, height));
    const view = { phase: 'menu', mode: 'standard' } as const;
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
    const { container, rerender } = render(<ToolsPopover anchor={anchor} view={{ phase: 'menu', mode: 'standard' }} handlers={handlers} />);
    const el = container.querySelector<HTMLElement>('.englint-tools')!;
    expect(el.dataset.side).toBe('below');

    size.height = 300; // results arrive: it no longer fits below the text
    rerender(<ToolsPopover anchor={anchor} view={{ phase: 'menu', mode: 'standard' }} handlers={handlers} />);
    expect(el.dataset.side).toBe('above');
    expect(parseFloat(el.style.top) + 300).toBeLessThanOrEqual(anchor.top);
  });
});

describe('ToolsPopover menu', () => {
  const titles = (container: HTMLElement) => Array.from(container.querySelectorAll('.englint-tools-item')).map((b) => b.textContent);

  it('lists the presets for the mode: Expand on Standard, not on Essay; Sound like me in every mode', () => {
    const standard = render(<ToolsPopover anchor={new DOMRect(10, 5, 40, 16)} view={{ phase: 'menu', mode: 'standard' }} handlers={handlers} />);
    expect(titles(standard.container)).toEqual([
      'Rewrite', 'Shorter', 'Clearer', 'More formal', 'More confident', 'Friendlier', 'More casual', 'Simpler', 'Expand', 'Sound like me', 'Synonyms',
    ]);
    standard.unmount();
    const essay = render(<ToolsPopover anchor={new DOMRect(10, 5, 40, 16)} view={{ phase: 'menu', mode: 'essay' }} handlers={handlers} />);
    expect(titles(essay.container)).not.toContain('Expand');
    expect(titles(essay.container)).toContain('Simpler');
    expect(titles(essay.container)).toContain('Sound like me');
    essay.unmount();
    const casual = render(<ToolsPopover anchor={new DOMRect(10, 5, 40, 16)} view={{ phase: 'menu', mode: 'casual' }} handlers={handlers} />);
    expect(titles(casual.container)).toContain('Sound like me');
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
      expect(c.querySelector('.englint-tools')!.lastElementChild, view.phase).toBe(input); // after the results
      cleanup();
    }
    for (const view of [{ phase: 'menu', mode: 'standard' }, { phase: 'loading', label: 'l' }, { phase: 'error', text: 'e', retry: true }] as ToolsView[]) {
      expect(box(draw(view)), view.phase).toBeNull();
      cleanup();
    }
  });

  it('an answer shows its message, then each version as a diff row, then the box', () => {
    const c = draw({ phase: 'answer', message: 'Less formal now.', variants: ['I have a cat', 'I got a cat'], original: 'I has a cat' });
    const pop = c.querySelector('.englint-tools')!;
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

  it('names the generic patterns found above one diff that applies the version; no Copy, no note', () => {
    const c = draw({ phase: 'voice', tells: ['a staged contrast', 'an inflated claim'], final: 'It was a long trip.', original: ORIGINAL, canApply: true });
    const pop = c.querySelector('.englint-tools')!;
    expect(pop.firstElementChild!.className).toBe('englint-tools-tells');
    expect(pop.firstElementChild!.textContent).toBe('Generic patterns found: a staged contrast, an inflated claim');
    const rows = c.querySelectorAll<HTMLButtonElement>('.englint-tools-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tagName).toBe('BUTTON');
    expect(rows[0]!.getAttribute('aria-label')).toBe('Use this version');
    expect(rows[0]!.querySelectorAll('ins').length).toBeGreaterThan(0);
    expect(rows[0]!.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(c.querySelector('[aria-label="Copy this version"]')).toBeNull();
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
  const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent);

  it('its critique offers "Show the version", not "Show 3 rewrites"; a light fix that keeps the claims applies', () => {
    const c = draw({ phase: 'critique', weakness: 'It sounds staged.', lightFix: 'It was a long trip.', original: ORIGINAL, voice: true, canApply: true });
    expect(buttons(c)).toEqual(['Use this version', 'Show the version']);
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
    expect(buttons(c)).toEqual(['Use this version', 'Show 3 rewrites']);
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
    expect(buttons(c)).toEqual(['Use version 1', 'Copy version 2']);
    expect(c.querySelectorAll('.englint-tools-version')).toHaveLength(1);
    expect(c.querySelector('.englint-tools-version ins')!.textContent).toContain('3');
    expect(c.querySelectorAll('.englint-tools-note')).toHaveLength(1);
  });
});
