// Google Docs line geometry from what Docs painted. The canvas text runs (canvas-recorder.ts, read over the bridge)
// refine the SVG line rects (geometry.ts): a line's runs carry their own x, width and font, where its SVG rect has one
// label and one font for the whole line, so justified spacing, bold and mixed fonts are placed as painted. Each
// line keeps its SVG rect's top and height.
//
// The canvas only refines a line the SVG rects already found in the text. Its runs, in x order, must spell out that
// line's located text, with nothing between them but spaces or tabs. A line whose runs don't (a run missing, a
// leftover from an earlier paint, text Docs draws some other way) keeps its SVG rect and span: each line falls back
// on its own. Placing runs inside their line's span, rather than walking them through locateRuns, matters for word
// runs (justified lines): a short word is found in many places, and on its own it can anchor on the wrong ones.
import { plainSpaces } from '../adapters/text-map';
import type { CanvasPaint } from './canvas-recorder';
import { locatePlainRuns, type Box, type RectRun, type RunSpan } from './geometry';

/** Runs in reading order with their places in the text, ready for rectsOnRuns. */
export interface PlacedLines {
  runs: RectRun[];
  spans: (RunSpan | null)[];
}

/** What may sit between a line's runs, and between its runs and its label's ends. */
const GAP = /[ \t]/;
const ONLY_GAPS = /^[ \t]*$/;
/** A run that paints nothing visible adds no geometry. */
const BLANK = /^[\s\u0000-\u001f]*$/;
/** The same text this close on one line is one run seen twice: a line drawn on two overlapping tiles. */
const SAME_RUN_PX = 0.5;

/**
 * The SVG line a canvas run belongs to, or -1: of the lines whose vertical span holds its baseline, the one it
 * overlaps most horizontally. Overlapping none, it joins a sole such line only if it starts within or right of it
 * (painted past the rect's end); a bullet or list number painted left of the text rect is not part of the line.
 */
function lineOf(svgRuns: RectRun[], baseline: number, left: number, right: number): number {
  let best = -1;
  let bestOverlap = 0;
  let candidates = 0;
  let sole = -1;
  svgRuns.forEach((line, i) => {
    if (!(baseline >= line.y && baseline < line.y + line.height)) return;
    candidates++;
    sole = i;
    const overlap = Math.min(right, line.x + line.width) - Math.max(left, line.x);
    if (overlap > bestOverlap) {
      best = i;
      bestOverlap = overlap;
    }
  });
  if (best !== -1) return best;
  return candidates === 1 && left >= svgRuns[sole]!.x ? sole : -1;
}

/**
 * Each SVG line's canvas runs in viewport px, in x order: x from the canvas's current box plus the run's x, width
 * and font as painted, top and height from the line. A canvas with no box drops its runs, and so does a canvas
 * that shows nothing (no size).
 */
function canvasRunsByLine(paints: CanvasPaint[], canvasRect: (id: string) => Box | null, svgRuns: RectRun[]): RectRun[][] {
  const byLine: RectRun[][] = svgRuns.map(() => []);
  for (const paint of paints) {
    const rect = canvasRect(paint.id);
    if (!rect || !(rect.width > 0 && rect.height > 0)) continue;
    for (const run of paint.runs) {
      if (BLANK.test(run.text)) continue;
      const x = rect.x + run.x;
      const line = lineOf(svgRuns, rect.y + run.y, x, x + run.width);
      if (line === -1) continue;
      const svg = svgRuns[line]!;
      const onLine = byLine[line]!;
      if (onLine.some((r) => r.text === run.text && Math.abs(r.x - x) <= SAME_RUN_PX)) continue;
      onLine.push({ text: run.text, x, y: svg.y, width: run.width, height: svg.height, font: run.font });
    }
  }
  for (const onLine of byLine) onLine.sort((a, b) => a.x - b.x);
  return byLine;
}

/**
 * Where a line's runs (x order) sit inside its label's span of `text`, or null unless they spell it out: each run
 * starts where the one before it ended, past spaces or tabs only. The first may take in spaces just before the label
 * (labels leave out leading spaces); the last ends where the label does, give or take spaces or tabs.
 */
function placeOnSpan(text: string, span: RunSpan, runs: RectRun[]): RunSpan[] | null {
  let from = span.start;
  while (from > 0 && GAP.test(text[from - 1]!)) from--;
  let until = span.end;
  while (until < text.length && GAP.test(text[until]!)) until++;
  const out: RunSpan[] = [];
  let cursor = from;
  for (const run of runs) {
    const label = plainSpaces(run.text);
    let at = cursor;
    while (!text.startsWith(label, at)) {
      if (!GAP.test(text[at] ?? '')) return null;
      at++;
    }
    cursor = at + label.length;
    if (cursor > until) return null;
    out.push({ start: at, end: cursor });
  }
  return cursor >= span.end || ONLY_GAPS.test(text.slice(cursor, span.end)) ? out : null;
}

/**
 * The runs to measure on, in reading order, with their spans in `fullText`. Every SVG line the SVG rects locate,
 * whose canvas runs (`paints`, boxes from `canvasRect`) spell out its text, is replaced by those runs; every other
 * line keeps its SVG run and the span locateRuns gives it. With no paints this is exactly the SVG path.
 */
export function placeLines(
  paints: CanvasPaint[],
  canvasRect: (id: string) => Box | null,
  svgRuns: RectRun[],
  fullText: string,
): PlacedLines {
  const text = plainSpaces(fullText); // once per measure: locating and placing both read it
  const svgSpans = locatePlainRuns(text, svgRuns);
  if (paints.length === 0 || svgRuns.length === 0) return { runs: svgRuns, spans: svgSpans };
  const byLine = canvasRunsByLine(paints, canvasRect, svgRuns);
  const runs: RectRun[] = [];
  const spans: (RunSpan | null)[] = [];
  svgRuns.forEach((svg, i) => {
    const span = svgSpans[i] ?? null;
    const drawn = byLine[i]!;
    const placed = span && drawn.length > 0 ? placeOnSpan(text, span, drawn) : null;
    if (placed) {
      runs.push(...drawn);
      spans.push(...placed);
    } else {
      runs.push(svg);
      spans.push(span);
    }
  });
  return { runs, spans };
}

/** The runs to measure on, in reading order (see placeLines, which also gives their spans). */
export function linesFromCanvas(
  paints: CanvasPaint[],
  canvasRect: (id: string) => Box | null,
  svgRuns: RectRun[],
  fullText: string,
): RectRun[] {
  return placeLines(paints, canvasRect, svgRuns, fullText).runs;
}
