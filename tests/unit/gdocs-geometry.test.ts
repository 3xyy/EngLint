import { describe, expect, it } from 'vitest';
import {
  LOOKAHEAD,
  locateRuns,
  offsetToRects,
  readRectRuns,
  runsConsistent,
  type RectRun,
} from '../../src/content/gdocs/geometry';
import { boxFromAttributes, fixtureHtml, fixtureText, perChar } from './gdocs-fixture';

// ---- synthetic runs: a fake measure of 10 px per character ----

const tenPx = (text: string) => text.length * 10;
const run = (text: string, x: number, y: number, extra: Partial<RectRun> = {}): RectRun => ({
  text,
  x,
  y,
  width: text.length * 10,
  height: 20,
  font: '400 14.6667px "Arial"',
  ...extra,
});
const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

describe('offsetToRects (synthetic)', () => {
  it('single run word rect', () => {
    const text = 'I has a cat\n';
    const rects = offsetToRects(text, [run('I has a cat', 100, 50)], 2, 5, tenPx);
    expect(rects.map(box)).toEqual([{ x: 120, y: 50, width: 30, height: 20 }]);
  });

  it('span across two runs → 2 rects', () => {
    // One paragraph wrapped over two lines: the label of the first line ends before the wrap space.
    const text = 'The quick brown fox jumps\n';
    const runs = [run('The quick brown', 100, 50), run('fox jumps', 100, 70)];
    const start = text.indexOf('brown');
    const end = text.indexOf('fox') + 3;
    const rects = offsetToRects(text, runs, start, end, tenPx);
    expect(rects.map(box)).toEqual([
      { x: 200, y: 50, width: 50, height: 20 },
      { x: 100, y: 70, width: 30, height: 20 },
    ]);
  });

  it('zoom 1.5 scales x', () => {
    const text = 'I has a cat\n';
    // At 150% zoom the rect's box is 1.5 times the measured width; measure stays at 100%.
    const zoomed = run('I has a cat', 100, 50, { width: 165, height: 30 });
    const rects = offsetToRects(text, [zoomed], 2, 5, tenPx);
    expect(rects.map(box)).toEqual([{ x: 130, y: 50, width: 45, height: 30 }]);
  });

  it('off-screen → []', () => {
    const text = 'First line here\nSecond line here\nThird line here\n';
    // Only the second line is rendered (visible).
    const runs = [run('Second line here', 100, 50)];
    expect(offsetToRects(text, runs, 0, 5, tenPx)).toEqual([]);
    expect(offsetToRects(text, runs, text.indexOf('Third'), text.indexOf('Third') + 5, tenPx)).toEqual([]);
    expect(offsetToRects(text, runs, text.indexOf('line', 16), text.indexOf('line', 16) + 4, tenPx)).toHaveLength(1);
  });

  it('NBSP in run matches space in text', () => {
    const text = 'I has a cat\n';
    const rects = offsetToRects(text, [run('I\u00a0has a cat', 100, 50)], 2, 5, tenPx);
    expect(rects.map(box)).toEqual([{ x: 120, y: 50, width: 30, height: 20 }]);
  });

  it('NBSP in text matches space in run', () => {
    const text = 'I\u00a0has a cat\n';
    const rects = offsetToRects(text, [run('I has a cat', 100, 50)], 2, 5, tenPx);
    expect(rects.map(box)).toEqual([{ x: 120, y: 50, width: 30, height: 20 }]);
  });

  it('an empty range gives no rect', () => {
    const text = 'I has a cat\n';
    expect(offsetToRects(text, [run('I has a cat', 100, 50)], 3, 3, tenPx)).toEqual([]);
  });

  it('a measure of 0 falls back to an even split of the run width', () => {
    const text = 'abcd\n';
    const rects = offsetToRects(text, [run('abcd', 100, 50, { width: 40 })], 1, 3, () => 0);
    expect(rects.map(box)).toEqual([{ x: 110, y: 50, width: 20, height: 20 }]);
  });
});

describe('locateRuns: bounded walk and anchors', () => {
  it('a run found only beyond the lookahead, with no chain after it, is skipped', () => {
    const filler = 'x'.repeat(LOOKAHEAD + 10);
    const text = `Alpha line of text\nBeta line of text\n${filler} Gamma\n`;
    // "Gamma" exists only beyond the lookahead, and "Beta…" doesn't follow it there: skipped.
    const runs = [run('Alpha line of text', 0, 0), run('Gamma', 0, 20), run('Beta line of text', 0, 40)];
    expect(locateRuns(text, runs)).toEqual([{ start: 0, end: 18 }, null, { start: 19, end: 36 }]);
  });

  it('a stray run whose text occurs later does not derail the next runs', () => {
    const text = `Title line\nMiddle words here\n${'y'.repeat(LOOKAHEAD + 10)}\nMilk\n`;
    // A rect whose label is not at the cursor but occurs far later ("Milk"), then the real lines.
    const runs = [run('Milk', 0, 0), run('Title line', 0, 20), run('Middle words here', 0, 40)];
    expect(locateRuns(text, runs)).toEqual([null, { start: 0, end: 10 }, { start: 11, end: 28 }]);
  });

  it('the first run is placed where the runs after it follow, not at an earlier occurrence', () => {
    const text = `\u0003Milk and eggs\n${'z'.repeat(LOOKAHEAD + 10)}\nMilk\nBread\nEggs\n`;
    // A scrolled view: only the list at the end is rendered.
    const runs = [run('Milk', 0, 0), run('Bread', 0, 20), run('Eggs', 0, 40)];
    const milk = text.lastIndexOf('Milk');
    expect(locateRuns(text, runs)).toEqual([
      { start: milk, end: milk + 4 },
      { start: milk + 5, end: milk + 10 },
      { start: milk + 11, end: milk + 15 },
    ]);
  });

  it('one-character table cells in a scrolled view map to the table, not into "2012"', () => {
    const prose = 'In 2012 we had 3 dogs and 4 cats, and by 2015 we had 5 more.\n';
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.\n'.repeat(20);
    const table = '\n\n\n\n1\n\n2\n\n\n3\n\n4\n\n\n'; // \u0010\u0012\u001c1\n\u001c2\n\u0012\u001c3\n\u001c4\n\u0011\n, mapped
    const text = prose + filler + table;
    const cell = (c: string) => {
      const start = text.indexOf(`\n${c}\n`, prose.length + filler.length) + 1;
      return { start, end: start + 1 };
    };
    expect(locateRuns(text, ['1', '2', '3', '4'].map((c) => run(c, 0, 0)))).toEqual(['1', '2', '3', '4'].map(cell));
  });

  it('after a stale line, a short line contained in it maps to its own line', () => {
    const text =
      'First line of the paragraph here.\nWe went to the park. Yes. Then we went home again and slept a lot\nYes.\nNext paragraph is here and long enough.\n';
    const runs = [
      'First line of the paragraph here.',
      'We went to the prk. Yes. Then we went home again and slept a lot', // painted before the last edit
      'Yes.',
      'Next paragraph is here and long enough.',
    ].map((l) => run(l, 0, 0));
    const yes = text.indexOf('\nYes.\n') + 1;
    expect(locateRuns(text, runs)).toEqual([
      { start: 0, end: 33 },
      null,
      { start: yes, end: yes + 4 },
      { start: yes + 5, end: yes + 44 },
    ]);
  });

  it('within the lookahead, a match at word boundaries wins over one inside a word', () => {
    const text = 'First line long enough to anchor.\nconcatenate\ncat\n';
    const located = locateRuns(text, [run('First line long enough to anchor.', 0, 0), run('cat', 0, 20)]);
    expect(located[1]).toEqual({ start: text.lastIndexOf('cat'), end: text.lastIndexOf('cat') + 3 });
  });

  it('an unaligned match is used when nothing aligned exists (a line wrapped inside a long word)', () => {
    const text = 'Visit https://example.com/averyveryverylongpath/index.html today\n';
    const runs = [run('Visit https://example.com/averyvery', 0, 0), run('verylongpath/index.html today', 0, 20)];
    expect(locateRuns(text, runs)).toEqual([
      { start: 0, end: 35 },
      { start: 35, end: 64 },
    ]);
  });

  it('a long label is evidence for itself: a long first line followed by one short line anchors', () => {
    const text = `${'w'.repeat(LOOKAHEAD + 10)}\nA long first line of the essay is right here.\nYes.\n`;
    const start = text.indexOf('A long');
    expect(locateRuns(text, [run('A long first line of the essay is right here.', 0, 0), run('Yes.', 0, 20)])).toEqual([
      { start, end: start + 45 },
      { start: start + 46, end: start + 50 },
    ]);
  });

  it('a stale label a few characters longer than its line does not hide the next line', () => {
    // The user deleted "big " after the paint: the label is 4 characters longer than the line now.
    const text = 'First line of the paragraph here.\nWe went to the park then home.\nNext line here.\n';
    const runs = ['First line of the paragraph here.', 'We went to the big park then home.', 'Next line here.'].map((l) => run(l, 0, 0));
    const next = text.indexOf('Next');
    expect(locateRuns(text, runs)).toEqual([{ start: 0, end: 33 }, null, { start: next, end: next + 15 }]);
  });

  it('an untrusted aligned occurrence is not traded for an unaligned one', () => {
    // "cat" is a word at the start, and also inside "Bobcat" further on, where the next run follows it.
    const text = `A cat sat.\n${'f'.repeat(LOOKAHEAD + 10)}\nBobcat\nruns fast every day and more\n`;
    const located = locateRuns(text, [run('cat', 0, 0), run('runs fast every day and more', 0, 20)]);
    const runs = text.indexOf('runs');
    expect(located).toEqual([null, { start: runs, end: runs + 28 }]);
  });

  it('once anchored, a hit right at the cursor wins even unaligned (a line wrapped after a hyphen)', () => {
    const text = '\nThis idea is now so well-known.\nIt was known. Everyone agreed.\n';
    const runs = ['This idea is now so well-', 'known.', 'It was known. Everyone agreed.'].map((l) => run(l, 0, 0));
    expect(locateRuns(text, runs)).toEqual([
      { start: 1, end: 26 },
      { start: 26, end: 32 },
      { start: 33, end: 63 },
    ]);
    expect(runsConsistent(text, runs)).toBe(true);
  });

  it('only whitespace and control characters count as adjacent; across real text, aligned still wins', () => {
    // The cursor is after "First line…"; "cat" first occurs inside "concatenate" past real text, then as its own line.
    const text = 'First line long enough to anchor.\n\u0012\u001c concatenate\ncat\n';
    const located = locateRuns(text, [run('First line long enough to anchor.', 0, 0), run('cat', 0, 20)]);
    expect(located[1]).toEqual({ start: text.lastIndexOf('cat'), end: text.lastIndexOf('cat') + 3 });
  });

  it.each([
    ['Hi', 'Hello'],
    ['My Essay', 'Draft 1'],
    ['Teh cat', 'sat'],
  ])('a two-line doc under 16 characters (%s / %s) maps when the first line is unique', (first, second) => {
    const text = `\n${first}\n${second}\n`;
    const runs = [run(first, 0, 0), run(second, 0, 20)];
    expect(locateRuns(text, runs)).toEqual([
      { start: 1, end: 1 + first.length },
      { start: 2 + first.length, end: 2 + first.length + second.length },
    ]);
    expect(runsConsistent(text, runs)).toBe(true);
  });

  it('a repeated short pair is not placed on its first copy (the small-doc rule needs a unique first line)', () => {
    const pair = '\nHi\nHello\n';
    const text = `${pair}${'p'.repeat(LOOKAHEAD + 10)}${pair}`;
    expect(locateRuns(text, [run('Hi', 0, 0), run('Hello', 0, 20)])).toEqual([null, null]);
  });

  it('a short unique first line still needs every checked run after it to follow', () => {
    const text = `\nHi\n${'h'.repeat(LOOKAHEAD + 10)}\nHello\n`;
    expect(locateRuns(text, [run('Hi', 0, 0), run('Hello', 0, 20)])).toEqual([null, { start: text.indexOf('Hello'), end: text.indexOf('Hello') + 5 }]);
  });

  it('a single painted run is placed only when its text is unique', () => {
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.\n'.repeat(20);
    const repeated = `\nPersonal Statement\n\n\nPersonal Statement\n${filler}`;
    expect(locateRuns(repeated, [run('Personal Statement', 0, 0)])).toEqual([null]);
    const unique = `\nPersonal Statement\n${filler}`;
    expect(locateRuns(unique, [run('Personal Statement', 0, 0)])).toEqual([{ start: 1, end: 19 }]);
  });

  it('a lone run with nothing after it must occur once', () => {
    const text = 'Milk\nEggs\nMilk\n';
    expect(locateRuns(text, [run('Milk', 0, 0)])).toEqual([null]);
    expect(locateRuns(text, [run('Eggs', 0, 0)])).toEqual([{ start: 5, end: 9 }]);
  });

  it('short runs without enough evidence stay unplaced rather than land in prose', () => {
    const text = `We had 3 dogs and 4 cats.\n${'q'.repeat(LOOKAHEAD + 10)}\n\n3\n\n4\n\n`;
    // One confirming run and 2 characters: too little to trust either "3".
    expect(locateRuns(text, [run('3', 0, 0), run('4', 0, 20)])).toEqual([null, null]);
  });

  it('a "●" run that gets through is a miss that does not derail later runs', () => {
    const runs = fixtureRuns();
    const withBullets = [...runs.slice(0, 8), run('●', 0, 0), ...runs.slice(8)];
    const located = locateRuns(fixtureText, withBullets);
    expect(located[8]).toBeNull();
    expect(located.filter((span) => span === null)).toHaveLength(1);
    expect(located[9]).toEqual(at('Bread and buter'));
  });
});

describe('readRectRuns: structure', () => {
  const flatBox = (el: Element) => {
    const x = Number(el.getAttribute('x') ?? 0);
    const y = Number(el.getAttribute('y') ?? 0);
    return { x, y, width: Number(el.getAttribute('width') ?? 0), height: Number(el.getAttribute('height') ?? 0) };
  };
  const labelsOf = (html: string, boxOf = flatBox) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return readRectRuns(host, boxOf).map((r) => r.text);
  };
  const para = (...rects: string[]) => `<g data-section-type="body" role="paragraph">${rects.join('')}</g>`;
  const rect = (label: string, x: number, y: number, width = 10) =>
    `<rect aria-label="${label}" x="${x}" y="${y}" width="${width}" height="18"></rect>`;

  it('leaves out a list marker: the first rect of its paragraph, a marker glyph, a text rect to its right', () => {
    expect(
      labelsOf(
        `<svg>${para(rect('●', 24, 0, 9), rect('Apples', 48, 0, 60))}${para(rect('1.', 24, 20, 12), rect('Mix the flour', 48, 20, 90))}` +
          `${para(rect('iv.', 24, 40, 14), rect('Rest', 48, 40, 30))}${para(rect('100.', 24, 60, 26), rect('Last step', 56, 60, 60))}</svg>`,
      ),
    ).toEqual(['Apples', 'Mix the flour', 'Rest', 'Last step']);
  });

  it('keeps short lines that only look like markers', () => {
    expect(
      labelsOf(
        // A wrapped paragraph's last line, a one-line paragraph, and a first line with the next line below it.
        `<svg>${para(rect('He said it was fine, and so did', 0, 0, 200), rect('it.', 0, 20, 14))}${para(rect('OK.', 0, 40, 20))}` +
          `${para(rect('No.', 0, 60, 20), rect('Then the second line', 0, 80, 120))}${para(rect('—', 0, 100, 10))}` +
          // A bold first word drawn as its own rect, with the rest of the line to its right.
          `${para(rect('Bold', 0, 120, 30), rect('rest of the line', 34, 120, 90))}</svg>`,
      ),
    ).toEqual(['He said it was fine, and so did', 'it.', 'OK.', 'No.', 'Then the second line', '—', 'Bold', 'rest of the line']);
  });

  it('a glyph that is not the first rect of its paragraph is kept (a line drawn as several rects)', () => {
    expect(labelsOf(`<svg>${para(rect('Score', 0, 0, 40), rect('-', 44, 0, 6), rect('ten', 54, 0, 30))}</svg>`)).toEqual([
      'Score',
      '-',
      'ten',
    ]);
  });

  it('a marker-like first rect with text to its right but on another line is kept', () => {
    expect(labelsOf(`<svg>${para(rect('a.', 0, 0, 12), rect('below', 40, 30, 40))}</svg>`)).toEqual(['a.', 'below']);
  });

  it('a nested svg is read once, as its own tile', () => {
    expect(labelsOf(`<svg>${para(rect('Outer line', 0, 0))}<svg>${para(rect('Inner line', 0, 20))}</svg></svg>`)).toEqual([
      'Outer line',
      'Inner line',
    ]);
  });

  it('tiles are read top to bottom, rects in DOM order within a tile', () => {
    const html =
      `<svg data-top="789">${para(rect('Page two first', 0, 0))}${para(rect('Page two second', 0, 20))}</svg>` +
      `<svg data-top="-250">${para(rect('Page one first', 0, 0))}${para(rect('Page one second', 0, 20))}</svg>`;
    const boxOf = (el: Element) =>
      el.tagName.toLowerCase() === 'svg' ? { x: 0, y: Number(el.getAttribute('data-top')), width: 816, height: 1056 } : flatBox(el);
    expect(labelsOf(html, boxOf)).toEqual(['Page one first', 'Page one second', 'Page two first', 'Page two second']);
  });
});

// ---- the live fixtures ----

function fixtureRuns(): RectRun[] {
  const host = document.createElement('div');
  host.innerHTML = fixtureHtml;
  return readRectRuns(host, boxFromAttributes);
}

const at = (word: string, from = 0) => {
  const start = fixtureText.indexOf(word, from);
  if (start === -1) throw new Error(`"${word}" is not in the fixture text`);
  return { start, end: start + word.length };
};

describe('readRectRuns (fixture)', () => {
  it('parses runs in order with fonts', () => {
    const runs = fixtureRuns();
    expect(runs.map((r) => r.text)).toEqual([
      'Quarterly Notes',
      'I has a cat and she likes to sleep on the sofa.',
      'Their going to the store after lunch, and they will buy teh bread.',
      '👋 Hello everyone, we is meeting tomorow at noon.',
      'This line starts with one leading space and it contain a mistake.',
      'This paragraph is clean. It has no spelling or grammar problems at all.',
      'Shopping list:',
      'Apples and oranges', // the "●" marker rects are left out
      'Bread and buter',
      'Milk',
      'Name',
      'Note',
      'Alice',
      'Alice have two dogs.',
    ]);
    expect(runs[0]).toEqual({
      text: 'Quarterly Notes',
      x: 96,
      y: 122.08,
      width: 186.685,
      height: 32,
      font: '400 26.6667px "Arial"',
    });
    expect(runs[1]!.font).toBe('400 14.6667px "Arial"');
    expect(runs[4]!.x).toBeCloseTo(100.073, 3); // the leading-space line is indented by its trimmed space
  });

  it('uses getBoundingClientRect by default', () => {
    const host = document.createElement('div');
    host.innerHTML = '<svg><g data-section-type="body"><rect aria-label="Hi there" data-font-css="400 10px Arial"></rect></g></svg>';
    const rect = host.querySelector('rect')!;
    rect.getBoundingClientRect = () => new DOMRect(5, 6, 70, 8);
    expect(readRectRuns(host)).toEqual([{ text: 'Hi there', x: 5, y: 6, width: 70, height: 8, font: '400 10px Arial' }]);
  });

  it('skips empty labels and rects outside body sections', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<svg><g data-section-type="header"><rect aria-label="Page 1"></rect></g>' +
      '<g data-section-type="body"><rect aria-label=""></rect><rect aria-label="Body text"></rect></g>' +
      '<g><rect aria-label="No section"></rect></g></svg>';
    expect(readRectRuns(host, () => ({ x: 0, y: 0, width: 1, height: 1 })).map((r) => r.text)).toEqual([
      'Body text',
      'No section',
    ]);
  });
});

describe('runsConsistent (fixture)', () => {
  it('fixture true', () => {
    expect(runsConsistent(fixtureText, fixtureRuns())).toBe(true);
  });

  it('altered run false', () => {
    const runs = fixtureRuns();
    runs[8] = { ...runs[8]!, text: 'Bread and butter' };
    expect(runsConsistent(fixtureText, runs)).toBe(false);
  });

  it('altered short table cell false', () => {
    const runs = fixtureRuns();
    runs[11] = { ...runs[11]!, text: 'Notes' };
    expect(runsConsistent(fixtureText, runs)).toBe(false);
  });

  it('no runs is vacuously true', () => {
    expect(runsConsistent(fixtureText, [])).toBe(true);
  });

  it('scrolled view (first runs not rendered) true', () => {
    expect(runsConsistent(fixtureText, fixtureRuns().slice(7))).toBe(true);
  });
});

describe('offsetToRects (fixture)', () => {
  const rectFor = (runs: RectRun[], word: string, from = 0) => {
    const { start, end } = at(word, from);
    return offsetToRects(fixtureText, runs, start, end, perChar);
  };

  it('control characters keep offsets: "has" is at 19..22', () => {
    expect(at('has')).toEqual({ start: 19, end: 22 });
    const [r, ...rest] = rectFor(fixtureRuns(), 'has');
    expect(rest).toEqual([]);
    const label = 'I has a cat and she likes to sleep on the sofa.';
    const scale = 293.386 / label.length;
    expect(r!.x).toBeCloseTo(96 + 2 * scale, 6);
    expect(r!.width).toBeCloseTo(3 * scale, 6);
    expect(r!.y).toBeCloseTo(165.93033854166666 - 0.323, 6);
    expect(r!.height).toBe(17.6);
  });

  it('maps list items next to their "●" rects', () => {
    const runs = fixtureRuns();
    const [r] = rectFor(runs, 'buter');
    const label = 'Bread and buter';
    expect(r!.x).toBeCloseTo(96 + 48 + 10 * (105.14 / label.length), 6);
    expect(r!.y).toBeCloseTo(301.69547526041663 - 0.323, 6);
    // Milk, after the last bullet, maps to its own line.
    const [milk] = rectFor(runs, 'Milk');
    expect(milk!.x).toBe(144);
    expect(milk!.y).toBeCloseTo(321.09049479166663 - 0.323, 6);
  });

  it('maps the leading-space line from its trimmed label', () => {
    const [r] = rectFor(fixtureRuns(), 'contain');
    const label = 'This line starts with one leading space and it contain a mistake.';
    const scale = 409.885 / label.length;
    expect(r!.x).toBeCloseTo(96 + 4.0730133056640625 + label.indexOf('contain') * scale, 6);
    expect(r!.width).toBeCloseTo(7 * scale, 6);
  });

  it('maps table cells to their own rects', () => {
    const runs = fixtureRuns();
    const [r] = rectFor(runs, 'have', at('Alice').end);
    expect(r!.x).toBeCloseTo(415 + 6 * (134.46 / 'Alice have two dogs.'.length), 6);
    expect(r!.y).toBeCloseTo(399.74576822916663 - 0.323, 6);
    const [name] = rectFor(runs, 'Name');
    expect(name!.x).toBe(103);
    const [note] = rectFor(runs, 'Note\n');
    expect(note!.x).toBe(415);
  });

  it('a scrolled view whose first run starts deep in the text still maps', () => {
    // Only the runs from "Bread and buter" on are rendered: the first is far beyond the lookahead from 0.
    const runs = fixtureRuns().slice(8);
    expect(runs[0]!.text).toBe('Bread and buter');
    expect(at('Bread and buter').start).toBeGreaterThan(LOOKAHEAD);
    const [r] = rectFor(runs, 'buter');
    expect(r!.x).toBeCloseTo(96 + 48 + 10 * (105.14 / 'Bread and buter'.length), 6);
    expect(rectFor(runs, 'have', at('Alice').end)).toHaveLength(1);
    expect(rectFor(runs, 'has')).toEqual([]); // not rendered → no rect
  });

  it('a missing run longer than the lookahead does not lose the runs after it', () => {
    // Drop the two long lines between "we is" and "Shopping list:".
    const runs = fixtureRuns().filter((r) => !r.text.startsWith('This '));
    const [r] = rectFor(runs, 'Shopping');
    expect(r!.x).toBe(96);
    expect(r!.y).toBeCloseTo(262.90543619791663 - 0.323, 6);
    expect(rectFor(runs, 'contain')).toEqual([]);
  });

  it('a range spanning a paragraph break gives one rect per line', () => {
    const start = at('sofa').start;
    const end = at('Their').end;
    expect(offsetToRects(fixtureText, fixtureRuns(), start, end, perChar)).toHaveLength(2);
  });
});
