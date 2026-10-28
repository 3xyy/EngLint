import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as icons from '../../src/shared/ui/icons';

afterEach(cleanup);

describe('icons', () => {
  const all = Object.entries(icons);

  it('has the set the UI needs', () => {
    expect(all.map(([name]) => name).sort()).toEqual([
      'ArrowLeftRightIcon', 'CheckIcon', 'ChevronDownIcon', 'CopyIcon', 'DotsIcon', 'SparkleIcon', 'TargetIcon', 'XIcon',
    ]);
  });

  it.each(all)('%s is a 16px inline SVG in the current colour, hidden from assistive tech', (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg')!;
    expect([svg.getAttribute('width'), svg.getAttribute('height'), svg.getAttribute('viewBox')]).toEqual(['16', '16', '0 0 16 16']);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.children.length).toBeGreaterThan(0);
    const paints = [svg, ...Array.from(svg.querySelectorAll('*'))].flatMap((el) => [el.getAttribute('stroke'), el.getAttribute('fill')]);
    expect(paints.filter((p) => p !== null && p !== 'none' && p !== 'currentColor')).toEqual([]);
    expect(paints).toContain('currentColor');
  });

  it('takes a size', () => {
    const { container } = render(<icons.CheckIcon size={20} />);
    const svg = container.querySelector('svg')!;
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['20', '20']);
  });
});
