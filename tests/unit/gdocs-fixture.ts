// The live Docs fixtures, shared by the geometry and adapter tests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The rect structure at 100% zoom, without its text-event iframe (happy-dom can't load iframes). */
export const fixtureHtml = readFileSync(resolve('tests/fixtures/gdocs/page-100.html'), 'utf8').replace(
  /<iframe[^>]*><\/iframe>/,
  '',
);

/** getText() of the test doc: 423 characters, with Docs' control characters. */
export const fixtureText: string = JSON.parse(readFileSync(resolve('tests/fixtures/gdocs/text-100.json'), 'utf8')).text;

/** happy-dom has no layout: the box is the rect's own x/y/width/height moved by its page transform. */
export function boxFromAttributes(el: Element) {
  const m = /matrix\(([^)]*)\)/.exec(el.getAttribute('transform') ?? '');
  const [, , , , tx = 0, ty = 0] = m ? m[1]!.split(',').map(Number) : [];
  const num = (name: string) => Number(el.getAttribute(name) ?? 0);
  return { x: tx + num('x'), y: ty + num('y'), width: num('width'), height: num('height') };
}

/** A measure proportional to length, so prefix widths split a run evenly by UTF-16 unit. */
export const perChar = (text: string) => text.length;
