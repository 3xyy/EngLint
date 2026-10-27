import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardAction } from '../../src/content/card-actions';
import { Card, type CardProps } from '../../src/content/overlay/Card';
import type { LocatedIssue } from '../../src/core/types';

const issue = (o: Partial<LocatedIssue> = {}): LocatedIssue => ({
  original: 'has',
  replacement: 'have',
  before: 'I',
  category: 'grammar',
  severity: 'error',
  kind: 'subject_verb_agreement',
  reason: 'Use "have" with "I".',
  model: { original: 'has', replacement: 'have' },
  id: 'h:2:subject_verb_agreement',
  paragraphHash: 'h',
  start: 2,
  end: 5,
  ...o,
});

function renderCard(i: LocatedIssue, secondary?: CardProps['secondary']) {
  const handlers = { onAccept: vi.fn(), onRewrite: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() };
  const { container } = render(<Card issue={i} anchor={new DOMRect(10, 10, 30, 20)} secondary={secondary} {...handlers} />);
  return { container, ...handlers };
}

/** The card as the overlay shows it: with the action cardAction offers for the issue in Standard, if any. */
function renderWithAction(i: LocatedIssue) {
  const action = cardAction(i, 'standard');
  const onClick = vi.fn();
  return { ...renderCard(i, action ? { label: action.label, onClick } : undefined), onClick };
}

/** A click the user made: the browser sets isTrusted; happy-dom never does, so the test does. */
const userClick = (el: Element) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
};

let sheet: HTMLStyleElement | null = null;
afterEach(() => {
  cleanup();
  sheet?.remove();
  sheet = null;
});

describe('Card', () => {
  it('card shows only the fix and a Dismiss bar', () => {
    const { container, onAccept, onDismiss } = renderCard(issue());
    const card = container.querySelector('.englint-card')!;
    expect(card.textContent).toBe('haveDismiss');
    expect(card.querySelector('s, .englint-card-category, .englint-card-dot, .englint-card-reason, .englint-card-original')).toBeNull();
    const fix = card.querySelector<HTMLButtonElement>('button.englint-card-fix')!;
    expect(fix.textContent).toBe('have');
    const bar = card.lastElementChild!;
    expect(bar.className).toBe('englint-card-bar');
    expect(bar.firstElementChild!.matches('button.englint-card-dismiss')).toBe(true);
    expect(bar.firstElementChild!.textContent).toBe('Dismiss');

    fireEvent.click(fix);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('the fix button names the original and the replacement', () => {
    const { container } = renderCard(issue());
    expect(container.querySelector('button.englint-card-fix')!.getAttribute('aria-label')).toBe("Replace 'has' with 'have'");
  });

  it('a deletion makes the struck-through original the fix button', () => {
    const { container, onAccept } = renderCard(issue({ original: 'very ', replacement: '', category: 'clarity', severity: 'suggestion' }));
    expect(container.querySelector('.englint-card-original')).toBeNull();
    const fix = container.querySelector<HTMLButtonElement>('button.englint-card-fix')!;
    expect(fix.classList.contains('delete')).toBe(true);
    expect(fix.getAttribute('aria-label')).toBe("Delete 'very '");
    expect(fix.querySelector('s')!.textContent).toBe('very ');
    expect(container.querySelectorAll('s')).toHaveLength(1);
    fireEvent.click(fix);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('a comment-only issue shows one "Rewrite this sentence" button and the Dismiss bar, and no fix button', () => {
    const { container, onAccept, onRewrite } = renderCard(
      issue({ original: 'very unique', replacement: null, category: 'clarity', severity: 'suggestion', kind: 'vague' }),
    );
    const card = container.querySelector('.englint-card')!;
    expect(card.textContent).toBe('Rewrite this sentenceDismiss');
    expect(card.querySelector('button.englint-card-fix')).toBeNull();
    expect(card.querySelectorAll('button')).toHaveLength(2);
    const rewrite = card.querySelector<HTMLButtonElement>('button.englint-card-rewrite')!;
    expect(rewrite.textContent).toBe('Rewrite this sentence');
    fireEvent.click(rewrite);
    expect(onRewrite).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(fireEvent.mouseDown(rewrite)).toBe(false); // keeps focus in the field
  });

  it('Dismiss dismisses; Escape closes', () => {
    const { container, onDismiss, onClose } = renderCard(issue());
    fireEvent.click(container.querySelector('.englint-card-dismiss')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(container.querySelector('.englint-card')!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('buttons never take focus from the field on mouse down', () => {
    const { container } = renderCard(issue());
    for (const button of container.querySelectorAll('button')) {
      // fireEvent returns false when the handler called preventDefault.
      expect(fireEvent.mouseDown(button)).toBe(false);
    }
  });

  it('says which side of its text it opened on, so the enter animation grows from there', () => {
    const handlers = { onAccept: vi.fn(), onRewrite: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() };
    const below = render(<Card issue={issue()} anchor={new DOMRect(10, 10, 30, 20)} {...handlers} />);
    expect(below.container.querySelector<HTMLElement>('.englint-card')!.dataset.side).toBe('below');
    cleanup();
    // No room below the text, near the viewport's bottom edge: the card goes above it.
    const above = render(<Card issue={issue()} anchor={new DOMRect(10, window.innerHeight - 20, 30, 20)} {...handlers} />);
    const el = above.container.querySelector<HTMLElement>('.englint-card')!;
    expect(el.dataset.side).toBe('above');
    expect(parseFloat(el.style.top)).toBeLessThan(window.innerHeight - 20);
  });

  describe('placement: one side per open', () => {
    /**
     * Makes every element report `size`: its laid-out box (offsetWidth/offsetHeight) and its client rect,
     * which the enter animation's scale(0.98) makes smaller on the first frames (`rectHeight`).
     */
    function stubSize(size: { height: number; rectHeight?: number }) {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 300);
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => size.height);
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, size.rectHeight ?? size.height));
    }
    afterEach(() => vi.restoreAllMocks());
    const handlers = () => ({ onAccept: vi.fn(), onRewrite: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() });

    it('keeps the side it opened on while open: a later render that measures it taller does not flip it, and only moves it to stay inside the viewport', () => {
      const size = { height: 100 };
      stubSize(size);
      // Room for 106 px below the text.
      const anchor = new DOMRect(10, window.innerHeight - 140, 30, 20);
      const { container, rerender } = render(<Card issue={issue()} anchor={anchor} {...handlers()} />);
      const el = container.querySelector<HTMLElement>('.englint-card')!;
      expect(el.dataset.side).toBe('below');
      const top = el.style.top;

      size.height = 120; // the pointer moves, the overlay renders again, and the card measures taller
      rerender(<Card issue={issue()} anchor={anchor} {...handlers()} />);
      expect(el.dataset.side).toBe('below');
      expect(parseFloat(el.style.top)).toBe(Math.min(parseFloat(top), window.innerHeight - 120 - 8));
    });

    it('keeps its side and stays inside the viewport when its anchor moves to the viewport\u2019s bottom edge', () => {
      stubSize({ height: 100 });
      const first = new DOMRect(10, 100, 30, 20);
      const { container, rerender } = render(<Card issue={issue()} anchor={first} {...handlers()} />);
      const el = container.querySelector<HTMLElement>('.englint-card')!;
      expect(el.dataset.side).toBe('below');

      // The anchor's bottom is 10 px above the viewport's: below it there is no room for the card.
      rerender(<Card issue={issue()} anchor={new DOMRect(10, window.innerHeight - 30, 30, 20)} {...handlers()} />);
      expect(el.dataset.side).toBe('below');
      expect(parseFloat(el.style.top)).toBeGreaterThanOrEqual(8);
      expect(parseFloat(el.style.top) + 100).toBeLessThanOrEqual(window.innerHeight - 8);
    });

    it('places from its laid-out size: on the enter animation\u2019s first frame (scale 0.98) a card 1 px too tall for below still goes above', () => {
      stubSize({ height: 115, rectHeight: 112.7 });
      // Room for 114 px below the text: 112.7 would fit, 115 doesn't.
      const anchor = new DOMRect(10, window.innerHeight - 148, 30, 20);
      const el = render(<Card issue={issue()} anchor={anchor} {...handlers()} />).container.querySelector<HTMLElement>('.englint-card')!;
      expect(el.dataset.side).toBe('above');
      expect(parseFloat(el.style.top)).toBeCloseTo(anchor.top - 6 - 115);
    });
  });

  describe('the action beside Dismiss', () => {
    const PASSIVE = issue({ original: 'was written', replacement: 'wrote', category: 'clarity', severity: 'suggestion', kind: 'passive_voice' });
    const KUBERNETES = issue({ original: 'Kubernetes', replacement: 'Kubernetis', category: 'spelling', severity: 'error', kind: 'spelling' });
    const barButtons = (container: HTMLElement) =>
      [...container.querySelectorAll('.englint-card-bar button')].map((b) => b.textContent);

    it('"Stop suggesting passive voice" for a passive_voice suggestion, after Dismiss', () => {
      const { container, onClick, onDismiss } = renderWithAction(PASSIVE);
      expect(barButtons(container)).toEqual(['Dismiss', 'Stop suggesting passive voice']);
      const button = container.querySelector<HTMLButtonElement>('button.englint-card-secondary')!;
      expect(fireEvent.mouseDown(button)).toBe(false); // keeps focus in the field
      userClick(button);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('it answers only the user’s own click: a page script’s click writes nothing', () => {
      const { container, onClick } = renderWithAction(PASSIVE);
      const button = container.querySelector<HTMLButtonElement>('button.englint-card-secondary')!;
      button.click(); // what a page script can do: isTrusted false
      fireEvent.click(button);
      expect(onClick).not.toHaveBeenCalled();
      userClick(button);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('pressing it says which side of its text the card is on, so the undo chip can take the same place', () => {
      const onClick = vi.fn();
      const handlers = { onAccept: vi.fn(), onRewrite: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() };
      // No room below the text: the card is above it.
      const { container } = render(
        <Card issue={PASSIVE} anchor={new DOMRect(10, window.innerHeight - 20, 30, 20)} secondary={{ label: 'Stop suggesting passive voice', onClick }} {...handlers} />,
      );
      expect(container.querySelector<HTMLElement>('.englint-card')!.dataset.side).toBe('above');
      userClick(container.querySelector('button.englint-card-secondary')!);
      expect(onClick).toHaveBeenCalledWith('above');
    });

    it('"Add to dictionary" for a spelling error on Kubernetes', () => {
      const { container } = renderWithAction(KUBERNETES);
      expect(barButtons(container)).toEqual(['Dismiss', 'Add to dictionary']);
    });

    it('neither for a grammar error', () => {
      const { container } = renderWithAction(issue());
      expect(barButtons(container)).toEqual(['Dismiss']);
      expect(container.querySelector('.englint-card-secondary')).toBeNull();
    });

    it('each button in the bottom row is no wider than its label: width auto, and it neither grows nor shrinks', () => {
      sheet = document.createElement('style');
      sheet.textContent = readFileSync('src/content/overlay/overlay.css', 'utf8');
      document.head.append(sheet);
      const { container } = renderWithAction(PASSIVE);
      for (const sel of ['.englint-card-dismiss', '.englint-card-secondary']) {
        const cs = getComputedStyle(container.querySelector(sel)!);
        expect([sel, cs.width, cs.flexGrow, cs.flexShrink, cs.flexBasis]).toEqual([sel, 'auto', '0', '0', 'auto']);
      }
    });
  });
});
