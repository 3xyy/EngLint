import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Diff } from '../../src/content/overlay/ToolsPopover';

// I1 (live finding L-diff): wordDiff puts a removed part right before its added one with no space at the
// joint, so "waited for" then "dragged" read as "waited fordragged". Both stylesheets that draw the Diff
// (the popover's and the side panel's) put a gap there: a margin, so a copy of the text gains no space.

let sheet: HTMLStyleElement | null = null;
afterEach(() => {
  cleanup();
  sheet?.remove();
  sheet = null;
});

describe.each([
  ['the popover', 'src/content/overlay/overlay.css', 'englint-tools'],
  ['the side panel', 'src/entrypoints/sidepanel/panel.css', 'tools'],
])('%s', (_where, css, className) => {
  it('an added part right after a removed one starts with a gap; one after unchanged text does not', () => {
    sheet = document.createElement('style');
    sheet.textContent = readFileSync(css, 'utf8');
    document.head.append(sheet);
    const { container } = render(
      <div className={className}>
        <Diff from="I waited for the bus." to="I dragged the bus home." />
      </div>,
    );
    const [joined, alone] = Array.from(container.querySelectorAll('ins'));
    expect(joined!.previousElementSibling?.localName).toBe('del'); // "waited for" | "dragged"
    expect(alone!.previousElementSibling?.localName).toBe('span'); // "bus" | " home"
    expect(parseFloat(getComputedStyle(joined!).marginInlineStart)).toBeGreaterThan(0);
    expect(getComputedStyle(alone!).marginInlineStart).toBe('');
    expect(container.textContent).toBe('I waited fordragged the bus home.'); // the gap is no character
  });
});
