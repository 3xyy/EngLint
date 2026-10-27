import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

// The side panel's stylesheet on the Review tab's lists.

let sheet: HTMLStyleElement | null = null;
afterEach(() => {
  cleanup();
  sheet?.remove();
  sheet = null;
});

describe('the Deep check lists in a review result', () => {
  it('are unindented card stacks, not the indented bullets of the other result lists', () => {
    sheet = document.createElement('style');
    sheet.textContent = readFileSync('src/entrypoints/sidepanel/panel.css', 'utf8');
    document.head.append(sheet);
    const { container } = render(
      <div className="review-result">
        <ul className="deep-issues">
          <li className="deep-issue">An issue</li>
        </ul>
        <ul className="deep-notes">
          <li>A note</li>
        </ul>
        <ul className="plain">
          <li>A reader's question</li>
        </ul>
      </div>,
    );
    for (const list of ['.deep-issues', '.deep-notes']) {
      const style = getComputedStyle(container.querySelector(list)!);
      expect(style.paddingLeft).toBe('0px');
      expect(style.listStyle).toBe('none');
    }
    expect(getComputedStyle(container.querySelector('.plain')!).paddingLeft).toBe('18px');
  });
});
