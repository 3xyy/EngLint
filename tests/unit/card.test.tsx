import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardAction } from '../../src/content/card-actions';
import { Card, type CardProps, OfferChip, UndoChip } from '../../src/content/overlay/Card';
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

const CONTEXT = { before: 'We all knew that last week I ', after: ' a cat called Ink and a dog called Rex.' };

/** `context` null: the card without the field's text. */
function renderCard(i: LocatedIssue, secondary?: CardProps['secondary'], context: CardProps['context'] | null = CONTEXT) {
  const handlers = { onAccept: vi.fn(), onRewrite: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() };
  const { container } = render(<Card issue={i} context={context ?? undefined} anchor={new DOMRect(10, 10, 30, 20)} secondary={secondary} {...handlers} />);
  return { container, card: container.querySelector<HTMLElement>('.englint-card')!, ...handlers };
}

const NOTE = issue({ original: 'very unique', replacement: null, category: 'clarity', severity: 'suggestion', kind: 'redundancy', reason: 'Unique already means one of a kind.' });
const names = (els: Iterable<Element>) => [...els].map((b) => b.getAttribute('aria-label') ?? b.textContent);
/** The "⋯" button, and the menu's items once it is open. */
const more = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
const items = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
/** A pointer click (detail 1): the menu opens without taking focus from the field. */
const pointerClick = (el: Element) => fireEvent.click(el, { detail: 1 });

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
  it('shows the type of change, the change in its context, the reason, then Accept and Dismiss', () => {
    const { card, onAccept, onDismiss } = renderCard(issue());
    expect(card.querySelector('.el-type-text')!.textContent).toBe('Correctness · Fix subject-verb agreement');
    expect(card.querySelector('.el-dot.el-fam-correctness')).not.toBeNull();
    const preview = card.querySelector('.englint-card-preview')!;
    // Six words of context each side, cut with "…".
    expect(preview.textContent).toBe('…all knew that last week I hashave a cat called Ink and a…');
    expect(preview.querySelector('del')!.textContent).toBe('has');
    expect(preview.querySelector('ins')!.textContent).toBe('have');
    expect(card.querySelector('.englint-card-reason')!.textContent).toBe('Use "have" with "I".');
    expect(names(card.querySelectorAll('.englint-card-actions button'))).toEqual(["Accept: replace 'has' with 'have'", 'Dismiss']);
    expect([...card.querySelectorAll('.englint-card-actions button')].map((b) => b.textContent)).toEqual(['Accept', 'Dismiss']);
    expect(card.querySelector('.englint-card-accept')!.classList.contains('el-btn-primary')).toBe(true);
    expect(card.querySelector('.englint-card-dismiss')!.classList.contains('el-btn-ghost')).toBe(true);

    fireEvent.click(card.querySelector('.englint-card-accept')!);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('without the field\u2019s text the preview is the change alone', () => {
    const { card } = renderCard(issue(), undefined, null);
    expect(card.querySelector('.englint-card-preview')!.textContent).toBe('hashave');
  });

  it('a deletion strikes the original and inserts nothing; Accept names the deletion', () => {
    const { card, onAccept } = renderCard(issue({ original: 'very ', replacement: '', category: 'clarity', severity: 'suggestion', kind: 'redundancy' }));
    expect(card.querySelector('.englint-card-preview del')!.textContent).toBe('very ');
    expect(card.querySelector('.englint-card-preview ins')).toBeNull();
    const accept = card.querySelector<HTMLButtonElement>('.englint-card-accept')!;
    expect(accept.getAttribute('aria-label')).toBe("Accept: delete 'very '");
    fireEvent.click(accept);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('a comment-only note: its words marked in the family\u2019s colour, and "Rewrite sentence" as the primary in place of Accept', () => {
    const { card, onAccept, onRewrite } = renderCard(NOTE);
    expect(card.querySelector('.el-type-text')!.textContent).toBe('Clarity · Remove the redundancy');
    expect(card.querySelector('.englint-card-preview mark')!.textContent).toBe('very unique');
    expect(card.querySelector('.englint-card-preview del, .englint-card-preview ins, .englint-card-accept')).toBeNull();
    expect(card.classList.contains('el-fam-clarity')).toBe(true); // the mark's dotted underline is drawn in --el-fam
    const rewrite = card.querySelector<HTMLButtonElement>('.englint-card-actions .englint-card-rewrite')!;
    expect(rewrite.textContent).toBe('Rewrite sentence');
    expect(rewrite.classList.contains('el-btn-primary')).toBe(true);
    fireEvent.click(rewrite);
    expect(onRewrite).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('Enter accepts (a note\u2019s Enter rewrites); Escape closes', () => {
    const { card, onAccept, onClose, onDismiss } = renderCard(issue());
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onAccept).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card.querySelector('.englint-card-reason')!, { key: 'Enter' });
    expect(onAccept).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    cleanup();

    const note = renderCard(NOTE);
    fireEvent.keyDown(note.card, { key: 'Enter' });
    expect(note.onRewrite).toHaveBeenCalledTimes(1);
    expect(note.onAccept).not.toHaveBeenCalled();
  });

  it('Enter on another button is that button\u2019s own: it accepts nothing', () => {
    const { card, onAccept } = renderCard(issue(), { label: 'Stop suggesting x', onClick: vi.fn() });
    for (const b of [card.querySelector('.englint-card-dismiss')!, more(card)!]) fireEvent.keyDown(b, { key: 'Enter' });
    fireEvent.click(more(card)!);
    for (const item of items(card)) fireEvent.keyDown(item, { key: 'Enter' });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('Dismiss dismisses', () => {
    const { card, onDismiss } = renderCard(issue());
    fireEvent.click(card.querySelector('.englint-card-dismiss')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('nothing on it takes focus from the field on mouse down: its buttons, its menu, its text', () => {
    const { card } = renderCard(issue(), { label: 'Stop suggesting x', onClick: vi.fn() });
    pointerClick(more(card)!);
    const targets = [...card.querySelectorAll('button'), card, card.querySelector('.englint-card-reason')!, card.querySelector('.englint-card-preview')!];
    expect(items(card)).toHaveLength(2);
    // fireEvent returns false when a handler called preventDefault.
    for (const el of targets) expect([el.className, fireEvent.mouseDown(el)]).toEqual([el.className, false]);
  });

  it('is 340 px wide, and its reason is clamped to two lines', () => {
    sheet = document.createElement('style');
    sheet.textContent = readFileSync('src/content/overlay/overlay.css', 'utf8');
    document.head.append(sheet);
    const { card } = renderCard(issue());
    expect(getComputedStyle(card).width).toBe('340px');
    expect(getComputedStyle(card.querySelector('.englint-card-reason')!).getPropertyValue('line-clamp')).toBe('2'); // the e2e checks Chromium's clamp
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

  describe('the "⋯" menu', () => {
    const PASSIVE = issue({ original: 'was written', replacement: 'wrote', category: 'clarity', severity: 'suggestion', kind: 'passive_voice' });
    const KUBERNETES = issue({ original: 'Kubernetes', replacement: 'Kubernetis', category: 'spelling', severity: 'error', kind: 'spelling' });

    it('holds "Stop suggesting passive voice" and "Rewrite sentence" for a passive_voice suggestion, closed until "⋯" is pressed', () => {
      const { card, onClick, onDismiss } = renderWithAction(PASSIVE);
      const button = more(card)!;
      expect([button.getAttribute('aria-label'), button.getAttribute('aria-expanded')]).toEqual(['More actions', 'false']);
      expect(card.querySelector('[role="menu"]')).toBeNull();
      pointerClick(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(card.querySelector('[role="menu"]')!.id).toBe(button.getAttribute('aria-controls'));
      expect(names(items(card))).toEqual(['Stop suggesting passive voice', 'Rewrite sentence']);
      userClick(items(card)[0]!);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onDismiss).not.toHaveBeenCalled();
      pointerClick(button);
      expect(card.querySelector('[role="menu"]')).toBeNull(); // pressed again: closed
    });

    it('"Rewrite sentence" opens the tools on the sentence', () => {
      const { card, onRewrite } = renderWithAction(PASSIVE);
      pointerClick(more(card)!);
      fireEvent.click(items(card)[1]!);
      expect(onRewrite).toHaveBeenCalledTimes(1);
    });

    it('its setting action answers only the user’s own click: a page script’s click writes nothing', () => {
      const { card, onClick } = renderWithAction(PASSIVE);
      pointerClick(more(card)!);
      const item = items(card)[0]!;
      item.click(); // what a page script can do: isTrusted false
      fireEvent.click(item);
      expect(onClick).not.toHaveBeenCalled();
      userClick(item);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('pressing it says which side of its text the card is on, so the undo chip can take the same place', () => {
      const onClick = vi.fn();
      const handlers = { onAccept: vi.fn(), onRewrite: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() };
      // No room below the text: the card is above it.
      const { container } = render(
        <Card issue={PASSIVE} anchor={new DOMRect(10, window.innerHeight - 20, 30, 20)} secondary={{ label: 'Stop suggesting passive voice', onClick }} {...handlers} />,
      );
      const card = container.querySelector<HTMLElement>('.englint-card')!;
      expect(card.dataset.side).toBe('above');
      pointerClick(more(card)!);
      userClick(items(card)[0]!);
      expect(onClick).toHaveBeenCalledWith('above');
    });

    it('"Add “Kubernetes” to dictionary" for a spelling error on Kubernetes', () => {
      const { card } = renderWithAction(KUBERNETES);
      pointerClick(more(card)!);
      expect(names(items(card))).toEqual(['Add “Kubernetes” to dictionary', 'Rewrite sentence']);
    });

    it('only "Rewrite sentence" for a grammar error', () => {
      const { card } = renderWithAction(issue());
      pointerClick(more(card)!);
      expect(names(items(card))).toEqual(['Rewrite sentence']);
    });

    it('a note rewrites from its primary, so its menu holds only the setting action, and there is no "⋯" when there is none', () => {
      const { card } = renderWithAction(NOTE);
      pointerClick(more(card)!);
      expect(names(items(card))).toEqual(['Stop suggesting redundant words']);
      cleanup();
      expect(more(renderCard(NOTE).card)).toBeNull();
    });

    it('from the keyboard: opening focuses the first item; the arrows, Home and End move and wrap; Escape closes it (not the card) and focuses "⋯"', () => {
      const { card, onClose } = renderWithAction(PASSIVE);
      const button = more(card)!;
      button.focus();
      fireEvent.click(button); // a key's click: detail 0
      const [stop, rewrite] = items(card);
      expect(document.activeElement).toBe(stop);
      expect(items(card).map((i) => i.tabIndex)).toEqual([-1, -1]);
      const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });
      key('ArrowDown');
      expect(document.activeElement).toBe(rewrite);
      key('ArrowDown');
      expect(document.activeElement).toBe(stop);
      key('ArrowUp');
      expect(document.activeElement).toBe(rewrite);
      key('Home');
      expect(document.activeElement).toBe(stop);
      key('End');
      expect(document.activeElement).toBe(rewrite);
      key('Escape');
      expect(card.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('ArrowDown or ArrowUp on "⋯" opens it at the first or the last item; a pointer\u2019s open leaves focus where it was', () => {
      const { card } = renderWithAction(PASSIVE);
      const button = more(card)!;
      button.focus();
      fireEvent.keyDown(button, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items(card)[1]);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      fireEvent.keyDown(button, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items(card)[0]);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      (document.activeElement as HTMLElement).blur();
      pointerClick(button);
      expect(items(card)).toHaveLength(2);
      expect(document.activeElement).toBe(document.body);
    });

    it('Tab out of it closes it', () => {
      const { card } = renderWithAction(PASSIVE);
      fireEvent.click(more(card)!);
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      expect(card.querySelector('[role="menu"]')).toBeNull();
    });
  });
});

describe('the undo and offer chips', () => {
  const at = new DOMRect(10, 10, 30, 20);
  const look = (chip: Element) => [...chip.querySelectorAll('button')].map((b) => [b.textContent, b.className]);

  it('the undo chip: its words, then Undo as a small text button in the accent colour', () => {
    const chip = render(<UndoChip anchor={at} text="Stopped suggesting passive voice." onUndo={vi.fn()} />).container.querySelector('.englint-undo')!;
    expect(chip.textContent).toBe('Stopped suggesting passive voice.Undo');
    expect(look(chip)).toEqual([['Undo', 'el-btn el-btn-ghost el-btn-sm englint-undo-button englint-undo-accent']]);
  });

  it('the offer chip: its question, then the yes button as the small primary and "Not now" as a small text button', () => {
    const chip = render(<OfferChip anchor={at} question="Stop suggesting passive voice in essays?" yes="Stop" onYes={vi.fn()} onNo={vi.fn()} />).container.querySelector(
      '.englint-undo.englint-offer',
    )!;
    expect(chip.textContent).toBe('Stop suggesting passive voice in essays?StopNot now');
    expect(look(chip)).toEqual([
      ['Stop', 'el-btn el-btn-primary el-btn-sm englint-undo-button'],
      ['Not now', 'el-btn el-btn-ghost el-btn-sm englint-undo-button'],
    ]);
  });
});
