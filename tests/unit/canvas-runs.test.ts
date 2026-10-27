import { describe, expect, it } from 'vitest';
import type { CanvasPaint, CanvasRun } from '../../src/content/gdocs/canvas-recorder';
import { linesFromCanvas, placeLines } from '../../src/content/gdocs/canvas-runs';
import { offsetToRects, rectsOnRuns, type Box, type RectRun } from '../../src/content/gdocs/geometry';

const LINE_FONT = '400 14.6667px "Arial"'; // an SVG rect's data-font-css
const REGULAR = '14.6667px Arial'; // a canvas font, as the context's getter spells it
const BOLD = 'bold 14.6667px Arial';

/** 10 px a character; in bold, letters are 14 px and spaces stay 10, so a width shows which font measured it. */
const measure = (text: string, font: string) =>
  [...text].reduce((width, c) => width + (font.startsWith('bold') && c !== ' ' ? 14 : 10), 0);

/** An SVG line rect in viewport px. */
const line = (text: string, x: number, y: number, width = measure(text, REGULAR), height = 20): RectRun => ({
  text,
  x,
  y,
  width,
  height,
  font: LINE_FONT,
});
/** A canvas run in canvas-local px; `y` is its baseline. */
const drawn = (text: string, x: number, y: number, font = REGULAR, width = measure(text, font)): CanvasRun => ({
  text,
  font,
  x,
  y,
  width,
});
const paint = (id: string, ...runs: CanvasRun[]): CanvasPaint => ({ id, runs, selection: [] });
/** Canvas rects by id; by default canvas '1' sits at the viewport origin, so canvas px are viewport px. */
const canvases =
  (rects: Record<string, Box> = { '1': { x: 0, y: 0, width: 816, height: 1056 } }) =>
  (id: string) =>
    rects[id] ?? null;
const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
/** The run a line keeps when it falls back: its SVG rect. */
const kept = (r: RectRun) => r;
/** A canvas run placed on a line: canvas x, width and font, the line's top and height. */
const placed = (text: string, x: number, svg: RectRun, font = REGULAR, width = measure(text, font)): RectRun => ({
  text,
  x,
  y: svg.y,
  width,
  height: svg.height,
  font,
});

describe('linesFromCanvas', () => {
  it('a justified line painted word by word becomes one run per word, at the canvas x positions', () => {
    const text = 'Alpha beta gamma\n';
    // The rect spans the justified width (300 px); the words alone are 160 px wide.
    const svg = line('Alpha beta gamma', 100, 50, 300);
    const rects = canvases({ '1': { x: 40, y: 30, width: 816, height: 1056 } });
    const paints = [paint('1', drawn('Alpha', 60, 35), drawn('beta', 185, 35), drawn('gamma', 310, 35))];

    const runs = linesFromCanvas(paints, rects, [svg], text);
    expect(runs).toEqual([placed('Alpha', 100, svg), placed('beta', 225, svg), placed('gamma', 350, svg)]);
    // "beta" is underlined where it was painted; the rect alone stretches it to 212.5.
    const { spans } = placeLines(paints, rects, [svg], text);
    expect(rectsOnRuns(runs, spans, 6, 10, measure).map(box)).toEqual([{ x: 225, y: 50, width: 40, height: 20 }]);
    expect(offsetToRects(text, [svg], 6, 10, measure)[0]!.x).toBeCloseTo(212.5, 6);
  });

  it("a line painted as a bold run and a regular run keeps each run's font, so offsets are measured in it", () => {
    const text = 'I has a cat\n';
    const svg = line('I has a cat', 100, 50, 126); // one rect, one font, for the whole line
    const paints = [paint('1', drawn('I has', 100, 65, BOLD), drawn(' a cat', 166, 65))];

    const runs = linesFromCanvas(paints, canvases(), [svg], text);
    expect(runs.map((r) => r.font)).toEqual([BOLD, REGULAR]);
    const { spans } = placeLines(paints, canvases(), [svg], text);
    expect(rectsOnRuns(runs, spans, 2, 5, measure).map(box)).toEqual([{ x: 124, y: 50, width: 42, height: 20 }]);
    expect(rectsOnRuns(runs, spans, 8, 11, measure).map(box)).toEqual([{ x: 196, y: 50, width: 30, height: 20 }]);
  });

  it('a line whose canvas runs do not match the text keeps its SVG rect, and the next line still uses its canvas runs', () => {
    const text = 'First line here\nSecond line here\n';
    const first = line('First line here', 100, 50);
    const second = line('Second line here', 100, 70, 200);
    const paints = [
      paint('1', drawn('Second', 100, 85), drawn('line', 200, 85), drawn('First lime here', 100, 65), drawn('here', 260, 85)),
    ];
    expect(linesFromCanvas(paints, canvases(), [first, second], text)).toEqual([
      kept(first),
      placed('Second', 100, second),
      placed('line', 200, second),
      placed('here', 260, second),
    ]);
  });

  it("a canvas that can't be found drops its runs: those lines keep their SVG rects", () => {
    const text = 'First line here\nSecond line here\n';
    const first = line('First line here', 100, 50);
    const second = line('Second line here', 100, 70);
    const paints = [paint('1', drawn('First line here', 101, 65)), paint('2', drawn('Second line here', 101, 85))];
    const rects = canvases({ '1': { x: 0, y: 0, width: 816, height: 1056 } }); // canvas 2 is gone
    expect(linesFromCanvas(paints, rects, [first, second], text)).toEqual([placed('First line here', 101, first), kept(second)]);
  });

  it('at 150% the runs arrive scaled with the canvas rect: x and width come out 1.5 times, converted once', () => {
    // The page at 100%: the line at (60, 20) in the canvas, 300 px justified, its words at 0, 125 and 250 px in.
    // At 150% the canvas rect is 1.5 times its 100% size, and the recorder reports runs in that rect's px.
    const text = 'Alpha beta gamma\n';
    const rect = { x: 40, y: 80, width: 1224, height: 1584 };
    const svg = line('Alpha beta gamma', 40 + 60 * 1.5, 80 + 20 * 1.5, 300 * 1.5, 20 * 1.5);
    const baseline = (20 + 15) * 1.5;
    const paints = [
      paint(
        '1',
        drawn('Alpha', 60 * 1.5, baseline, REGULAR, 50 * 1.5),
        drawn('beta', 185 * 1.5, baseline, REGULAR, 40 * 1.5),
        drawn('gamma', 310 * 1.5, baseline, REGULAR, 50 * 1.5),
      ),
    ];
    const rects = canvases({ '1': rect });

    const runs = linesFromCanvas(paints, rects, [svg], text);
    expect(runs).toEqual([
      placed('Alpha', 130, svg, REGULAR, 75),
      placed('beta', 317.5, svg, REGULAR, 60),
      placed('gamma', 505, svg, REGULAR, 75),
    ]);
    // "eta" in "beta": offsets measured at 100% scale by the run's own width.
    const { spans } = placeLines(paints, rects, [svg], text);
    expect(rectsOnRuns(runs, spans, 7, 10, measure).map(box)).toEqual([{ x: 332.5, y: 110, width: 45, height: 30 }]);
  });

  it('a leftover run whose baseline is in no line box is dropped', () => {
    const text = 'Alpha beta\n';
    const svg = line('Alpha beta', 100, 50, 120);
    const paints = [paint('1', drawn('Alpha', 100, 65), drawn('Removed line', 100, 205), drawn('beta', 180, 65))];
    expect(linesFromCanvas(paints, canvases(), [svg], text)).toEqual([placed('Alpha', 100, svg), placed('beta', 180, svg)]);
  });

  it("a list bullet painted left of its line's rect is not part of the line", () => {
    const text = 'Shopping list:\nApples and oranges\n';
    const heading = line('Shopping list:', 100, 30);
    const item = line('Apples and oranges', 148, 50);
    const paints = [paint('1', drawn('●', 124, 65, REGULAR, 9), drawn('Apples and oranges', 148.5, 65, REGULAR, 182))];
    expect(linesFromCanvas(paints, canvases(), [heading, item], text)).toEqual([
      kept(heading),
      placed('Apples and oranges', 148.5, item, REGULAR, 182),
    ]);
  });

  it('two table cells on one row each take the run painted over them', () => {
    const text = 'Name\nNote\n';
    const name = line('Name', 100, 50);
    const note = line('Note', 300, 50);
    const paints = [paint('1', drawn('Note', 302, 65), drawn('Name', 101, 65))];
    expect(linesFromCanvas(paints, canvases(), [name, note], text)).toEqual([placed('Name', 101, name), placed('Note', 302, note)]);
  });

  it('a run painted past the right end of its line rect still belongs to that line', () => {
    const text = 'I has a cat\n';
    const svg = line('I has a cat', 100, 50, 60); // narrower than the paint
    const paints = [paint('1', drawn('I has', 100, 65, BOLD), drawn(' a cat', 166, 65))];
    expect(linesFromCanvas(paints, canvases(), [svg], text)).toEqual([
      placed('I has', 100, svg, BOLD),
      placed(' a cat', 166, svg),
    ]);
  });

  it('runs come out in x order; the same run on two canvases counts once; blank runs are dropped', () => {
    const text = 'Alpha beta gamma\n';
    const svg = line('Alpha beta gamma', 100, 50, 300);
    const rects = canvases({
      '1': { x: 0, y: 0, width: 816, height: 1056 },
      '2': { x: 0, y: 60, width: 816, height: 1056 }, // the next tile, overlapping this line
    });
    const paints = [
      paint('1', drawn('gamma', 350, 65), drawn(' ', 330, 65), drawn('Alpha', 100, 65), drawn('beta', 225, 65)),
      paint('2', drawn('beta', 225.2, 5), drawn('gamma', 350, 5)),
    ];
    expect(linesFromCanvas(paints, rects, [svg], text)).toEqual([
      placed('Alpha', 100, svg),
      placed('beta', 225, svg),
      placed('gamma', 350, svg),
    ]);
  });

  it('with no paints, the SVG rects and their spans are returned as they are', () => {
    const text = 'Alpha beta\n';
    const svg = line('Alpha beta', 100, 50);
    expect(placeLines([], canvases(), [svg], text)).toEqual({ runs: [svg], spans: [{ start: 0, end: 10 }] });
  });
});

describe('placeLines: canvas runs are placed inside the text their SVG line was found at', () => {
  it('a run that starts with the space the SVG label leaves out is placed at that space', () => {
    const text = 'Intro\n This line\n';
    const intro = line('Intro', 100, 30);
    const svg = line('This line', 110, 50);
    const paints = [paint('1', drawn(' This line', 100, 65))];
    const { runs, spans } = placeLines(paints, canvases(), [intro, svg], text);
    expect(runs).toEqual([kept(intro), placed(' This line', 100, svg)]);
    expect(spans).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 16 },
    ]);
    expect(rectsOnRuns(runs, spans, 7, 11, measure).map(box)).toEqual([{ x: 110, y: 50, width: 40, height: 20 }]);
  });

  it('reads NBSP in the text as a space, both to locate the SVG lines and to place the runs', () => {
    const text = 'Alpha\u00a0beta\nGamma delta\n';
    const first = line('Alpha beta', 100, 30);
    const second = line('Gamma delta', 100, 50);
    const paints = [paint('1', drawn('Alpha', 100, 45), drawn('beta', 160, 45), drawn('Gamma delta', 100, 65))];
    const { runs, spans } = placeLines(paints, canvases(), [first, second], text);
    expect(runs).toEqual([placed('Alpha', 100, first), placed('beta', 160, first), placed('Gamma delta', 100, second)]);
    expect(spans).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 10 },
      { start: 11, end: 22 },
    ]);
  });

  it('a canvas line missing a word keeps its SVG rect', () => {
    const text = 'Alpha beta gamma\n';
    const svg = line('Alpha beta gamma', 100, 50, 300);
    const paints = [paint('1', drawn('Alpha', 100, 65), drawn('gamma', 350, 65))];
    expect(placeLines(paints, canvases(), [svg], text)).toEqual({ runs: [svg], spans: [{ start: 0, end: 16 }] });
  });

  it('a canvas line showing text past its SVG label keeps its SVG rect', () => {
    const text = 'Alpha beta gamma\n';
    const svg = line('Alpha beta', 100, 50, 200);
    const paints = [paint('1', drawn('Alpha', 100, 65), drawn('beta gamma', 160, 65))];
    expect(linesFromCanvas(paints, canvases(), [svg], text)).toEqual([kept(svg)]);
  });

  it('a line whose SVG label is not in the text gets no canvas runs, even though the painted words are', () => {
    const text = 'Alpha beta\n';
    const svg = line('Alpha betx', 100, 50);
    const paints = [paint('1', drawn('Alpha', 100, 65), drawn('beta', 160, 65))];
    expect(placeLines(paints, canvases(), [svg], text)).toEqual({ runs: [svg], spans: [null] });
  });

  it('a trailing space on either the label or the run still places the line', () => {
    const text = 'Alpha beta gamma delta zeta\n';
    const first = line('Alpha beta', 100, 50); // its run keeps the wrap space
    const second = line('gamma delta ', 100, 70); // its label does
    const third = line('zeta', 100, 90);
    const paints = [paint('1', drawn('Alpha beta ', 100, 65), drawn('gamma delta', 100, 85))];
    const { runs, spans } = placeLines(paints, canvases(), [first, second, third], text);
    expect(runs).toEqual([placed('Alpha beta ', 100, first), placed('gamma delta', 100, second), kept(third)]);
    expect(spans).toEqual([
      { start: 0, end: 11 },
      { start: 11, end: 22 },
      { start: 23, end: 27 },
    ]);
  });

  it('runs that split a word between two fonts place back to back', () => {
    const text = 'bold\n';
    const svg = line('bold', 100, 50);
    const paints = [paint('1', drawn('bo', 100, 65, BOLD), drawn('ld', 128, 65))];
    const { runs, spans } = placeLines(paints, canvases(), [svg], text);
    expect(runs).toEqual([placed('bo', 100, svg, BOLD), placed('ld', 128, svg)]);
    expect(spans).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('a common word painted on the first line is placed on that line, not where it first occurs in the text', () => {
    // Word runs anchor weakly on their own: "of the" also occurs early in the text, followed by "and" within reach.
    const early = 'Most of the time we walk and talk. ';
    const text = `${early}${'Filler words keep this part of the document long. '.repeat(3)}\nof the sea and sky\n`;
    const lineStart = text.indexOf('of the sea');
    const svg = line('of the sea and sky', 100, 50, 300);
    const paints = [
      paint('1', drawn('of', 100, 65), drawn('the', 140, 65), drawn('sea', 190, 65), drawn('and', 240, 65), drawn('sky', 370, 65)),
    ];
    const { spans } = placeLines(paints, canvases(), [svg], text);
    expect(spans[0]).toEqual({ start: lineStart, end: lineStart + 2 });
    expect(spans.at(-1)).toEqual({ start: lineStart + 15, end: lineStart + 18 });
  });
});
