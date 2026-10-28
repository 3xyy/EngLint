import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UNDERLINE_PX, Underlines } from '../../src/content/overlay/Underlines';
import type { LocatedIssue } from '../../src/core/types';

const issue = (id: string, o: Partial<LocatedIssue>): LocatedIssue =>
  ({ id, original: 'x', replacement: 'y', before: '', reason: 'r', start: 0, end: 1, paragraphHash: 'h', model: { original: 'x', replacement: 'y' }, ...o }) as LocatedIssue;

const ISSUES = [
  issue('err', { severity: 'error', category: 'grammar', kind: 'subject_verb_agreement' }),
  issue('cla', { severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase' }),
  issue('eng', { severity: 'suggestion', category: 'engagement', kind: 'repeated_word' }),
  issue('del', { severity: 'suggestion', category: 'delivery', kind: 'inclusive_language' }),
  issue('gen', { severity: 'suggestion', category: 'delivery', kind: 'generic_phrasing' }),
  // A known kind decides its family whatever the category; an unknown kind under an error category is clarity.
  issue('known', { severity: 'suggestion', category: 'clarity', kind: 'overused_word' }),
  issue('odd', { severity: 'suggestion', category: 'grammar', kind: 'made_up' }),
];
const rect = new DOMRect(0, 0, 20, 16);

afterEach(cleanup);

function draw(active: string[] = []) {
  const { container } = render(
    <Underlines items={ISSUES.map((i) => ({ issue: i, rects: [rect] }))} active={new Set(active)} fading={new Set()} drawing={new Set()} />,
  );
  return container;
}

describe('Underlines: one style per suggestion family', () => {
  it('each suggestion carries its family class; an error carries none', () => {
    const classes = [...draw().querySelectorAll('.englint-underline')].map((el) => el.className);
    expect(classes).toEqual([
      'englint-underline error',
      'englint-underline suggestion fam-clarity',
      'englint-underline suggestion fam-engagement',
      'englint-underline suggestion fam-delivery',
      'englint-underline suggestion fam-generic',
      'englint-underline suggestion fam-engagement',
      'englint-underline suggestion fam-clarity',
    ]);
  });

  it('each suggestion is named for its family', () => {
    const labels = [...draw().querySelectorAll('.englint-underline.suggestion')].map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Clarity suggestion',
      'Engagement suggestion',
      'Delivery suggestion',
      'Generic phrasing',
      'Engagement suggestion',
      'Clarity suggestion',
    ]);
  });

  it("an active suggestion's tint carries its family too, so the tint is in the family's colour", () => {
    const tints = [...draw(['eng', 'gen', 'err']).querySelectorAll('.englint-tint')].map((el) => el.className);
    expect(tints).toEqual(['englint-tint error', 'englint-tint suggestion fam-engagement', 'englint-tint suggestion fam-generic']);
  });
});

describe('Underlines: the line says what kind of issue it is', () => {
  const NOTE = issue('note', { severity: 'suggestion', category: 'engagement', kind: 'vague_word', replacement: null });
  const items = [...ISSUES, NOTE].map((i) => ({ issue: i, rects: [rect] }));
  const drawAll = (active: string[] = []) =>
    render(<Underlines items={items} active={new Set(active)} fading={new Set()} drawing={new Set()} />).container;

  it('errors solid in the Correctness colour, suggestions dotted and comment-only notes dashed in their family\u2019s', () => {
    const lines = [...drawAll().querySelectorAll<HTMLElement>('.englint-underline')].map((el) => [el.dataset.family, el.dataset.line]);
    expect(lines).toEqual([
      ['correctness', 'solid'],
      ['clarity', 'dotted'],
      ['engagement', 'dotted'],
      ['delivery', 'dotted'],
      ['generic', 'dotted'],
      ['engagement', 'dotted'],
      ['clarity', 'dotted'],
      ['engagement', 'dashed'],
    ]);
  });

  it('a tint carries its family too', () => {
    const tints = [...drawAll(['err', 'gen', 'note']).querySelectorAll<HTMLElement>('.englint-tint')].map((el) => el.dataset.family);
    expect(tints).toEqual(['correctness', 'generic', 'engagement']);
  });

  it('a 2 px strip along the bottom of its text', () => {
    const sheet = document.createElement('style');
    sheet.textContent = readFileSync('src/content/overlay/overlay.css', 'utf8');
    document.head.append(sheet);
    try {
      const u = draw().querySelector<HTMLElement>('.englint-underline')!;
      expect(UNDERLINE_PX).toBe(2);
      expect([u.style.top, getComputedStyle(u).height]).toEqual([`${rect.bottom - 2}px`, '2px']);
    } finally {
      sheet.remove();
    }
  });
});
