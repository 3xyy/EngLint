// Google Docs geometry: Docs paints text on a canvas, and in annotated mode it adds one invisible
// <rect aria-label="line text"> per rendered line. Text offsets in getText() are
// mapped to screen rectangles by finding each line's label in the text and measuring the prefix.
import { plainSpaces } from '../adapters/text-map';

/** One rendered line (or table cell): its label, viewport box and canvas font. */
export interface RectRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A run's place in the text: [start, end). */
export interface RunSpan {
  start: number;
  end: number;
}

/** How far past the cursor a run's text may start: covers the gaps rects leave out (control chars, trimmed spaces). */
export const LOOKAHEAD = 64;
/** Runs after a candidate anchor that are walked to confirm it. */
const CHAIN = 3;
/** An anchor is trusted with this many confirming runs after it... */
const MIN_CONFIRMED_RUNS = 2;
/** ...or this many matched label characters (its own label and the confirming ones). */
const MIN_CONFIRMED_CHARS = 16;
/** After a miss the next search starts this much short of the missed label's length (a stale label may be longer). */
const MISS_SLACK = 8;

/** Whitespace, line breaks and Docs' control characters: what a label's text starts and ends next to. */
const BOUNDARY = /[\s\x00-\x1f]/;
/** Nothing but boundary characters: the gap between the cursor and a run's own text. */
const ONLY_BOUNDARIES = /^[\s\x00-\x1f]*$/;
/** A bullet glyph or a numbering label ("●", "1.", "a.", "iv.", "(3)"). */
const MARKER_GLYPH = /^(?:[^\p{L}\p{N}\s]|\(?(?:\d{1,3}|[a-z]{1,3}|[ivxlcdm]{1,8})[.)])$/iu;

/**
 * A list item's marker rect: the first rect of its paragraph, with a text rect to its right on the
 * same line, and a bullet or numbering glyph. Its text is not in getText().
 */
function isListMarker(el: Element, label: string, boxOf: (el: Element) => Box): boolean {
  if (!MARKER_GLYPH.test(label)) return false;
  const rects = Array.from(el.closest('g[role="paragraph"]')?.querySelectorAll('rect[aria-label]') ?? []);
  const at = rects.indexOf(el);
  if (at !== 0 || at + 1 >= rects.length) return false;
  const marker = boxOf(el);
  const next = boxOf(rects[at + 1]!);
  const sameLine = Math.abs(next.y - marker.y) < Math.max(1, marker.height / 2);
  return sameLine && next.x >= marker.x + marker.width - 0.5;
}

/**
 * The text rects in reading order, with their viewport boxes (`boxOf`, injectable because happy-dom has
 * no layout). Tile SVGs are sorted by their top (the rotating tile manager may reuse them out of order);
 * rects keep their DOM order within a tile. Left out: empty labels, list markers, and rects outside body
 * sections (headers, footers): recon found only body text in getText().
 */
export function readRectRuns(
  root: ParentNode,
  boxOf: (el: Element) => Box = (el) => el.getBoundingClientRect(),
): RectRun[] {
  const tiles = Array.from(root.querySelectorAll('svg'))
    .map((svg, order) => {
      const top = boxOf(svg).y;
      return { svg, order, top: Number.isFinite(top) ? top : 0 };
    })
    .sort((a, b) => a.top - b.top || a.order - b.order);
  const runs: RectRun[] = [];
  for (const { svg } of tiles) {
    for (const el of Array.from(svg.querySelectorAll('rect[aria-label]'))) {
      if (el.closest('svg') !== svg) continue; // a nested svg is its own tile
      const text = el.getAttribute('aria-label') ?? '';
      if (text === '') continue;
      const section = el.closest('[data-section-type]')?.getAttribute('data-section-type');
      if (section && section !== 'body') continue;
      if (isListMarker(el, text, boxOf)) continue;
      const { x, y, width, height } = boxOf(el);
      runs.push({ text, x, y, width, height, font: el.getAttribute('data-font-css') ?? '' });
    }
  }
  return runs;
}

/**
 * Where each run's text sits in `fullText` (NBSP ≡ space), or null for a run that isn't there.
 *
 * Runs are in reading order, so a cursor walks the text: each run is looked for within LOOKAHEAD
 * characters after the cursor: a match with only whitespace or control characters before it is taken as it
 * is; across real text, matches at word or line boundaries win, and an unaligned one is used only when no
 * aligned one exists. A run not found there is looked for further on as an anchor, trusted only on
 * evidence: the runs after it must follow it (at least half of the next CHAIN, and at least
 * MIN_CONFIRMED_RUNS of them or MIN_CONFIRMED_CHARS matched characters), or its text must occur once with
 * every checked run after it following; with no runs after it, its text must occur once. The first run found is always an anchor. Anchors make a scrolled view work (only
 * visible lines have rects, so the first one may be thousands of characters in) and get the walk past a
 * missing line. A miss moves the next search to cursor + its label length - MISS_SLACK, so a stale line's
 * text can't be matched by the runs after it.
 */
export function locateRuns(fullText: string, runs: RectRun[]): (RunSpan | null)[] {
  return locatePlainRuns(plainSpaces(fullText), runs);
}

/** locateRuns on text that has already been through plainSpaces, for a caller that needs that text too. */
export function locatePlainRuns(text: string, runs: RectRun[]): (RunSpan | null)[] {
  const labels = runs.map((r) => plainSpaces(r.text));

  const aligned = (at: number, length: number) =>
    (at === 0 || BOUNDARY.test(text[at - 1]!)) && (at + length === text.length || BOUNDARY.test(text[at + length]!));

  /** Starts of `label` in [from, to), aligned ones first, each group in text order. */
  const occurrences = (label: string, from: number, to = text.length): number[] => {
    const region = text.slice(from, Math.min(text.length, to - 1 + label.length));
    const hits: number[] = [];
    for (let i = region.indexOf(label); i !== -1; i = region.indexOf(label, i + 1)) hits.push(from + i);
    const good = hits.filter((at) => aligned(at, label.length));
    return [...good, ...hits.filter((at) => !aligned(at, label.length))];
  };

  /**
   * Where `label` continues the walk from `cursor`, within the lookahead: its first start when only whitespace or
   * control characters lie before it, aligned or not (a line's text right after the previous line, even mid-word
   * after a hyphen wrap); otherwise across real text the first aligned start, else the first unaligned one; else -1.
   */
  const near = (label: string, cursor: number): number => {
    const hits = occurrences(label, cursor, cursor + LOOKAHEAD + 1);
    if (hits.length === 0) return -1;
    const first = Math.min(...hits);
    return ONLY_BOUNDARIES.test(text.slice(cursor, first)) ? first : hits[0]!;
  };

  const missed = (cursor: number, label: string) => cursor + Math.max(0, label.length - MISS_SLACK);

  /** Walks the next CHAIN runs after run `i` from `cursor`, as the anchored walk would. */
  const chain = (i: number, cursor: number) => {
    let checked = 0;
    let found = 0;
    let chars = 0;
    for (let j = i + 1; j < runs.length && checked < CHAIN; j++) {
      const label = labels[j]!;
      checked++;
      const at = near(label, cursor);
      if (at === -1) {
        cursor = missed(cursor, label);
        continue;
      }
      found++;
      chars += label.length;
      cursor = at + label.length;
    }
    return { checked, found, chars };
  };

  /** The first start of run `i` from `cursor` on that the evidence supports, or -1. */
  const anchor = (i: number, label: string, cursor: number): number => {
    const candidates = occurrences(label, cursor);
    if (candidates.length === 0) return -1;
    const unique = candidates.length === 1;
    const firstAligned = aligned(candidates[0]!, label.length);
    for (const at of candidates) {
      if (firstAligned && !aligned(at, label.length)) break; // unaligned only when nothing aligned exists
      const { checked, found, chars } = chain(i, at + label.length);
      if (checked === 0) return unique ? at : -1; // nothing to confirm it: it must be unique
      if (unique && found === checked) return at; // a small doc: it occurs once and every run after it follows
      if (found < Math.ceil(checked / 2)) continue;
      if (found >= MIN_CONFIRMED_RUNS || label.length + chars >= MIN_CONFIRMED_CHARS) return at;
    }
    return -1;
  };

  let cursor = 0;
  let anchored = false; // the first run found must be an anchor too: a short label may also occur early on
  return runs.map((_, i) => {
    const label = labels[i]!;
    let at = anchored ? near(label, cursor) : -1;
    if (at === -1) at = anchor(i, label, cursor);
    if (at === -1) {
      cursor = missed(cursor, label);
      return null;
    }
    anchored = true;
    cursor = at + label.length;
    return { start: at, end: cursor };
  });
}

/** True when every run is found in the text. No runs is vacuously true: the caller decides what an empty paint means. */
export function runsConsistent(fullText: string, runs: RectRun[]): boolean {
  return locateRuns(fullText, runs).every((span) => span !== null);
}

/** The rects of [start, end) on runs already located by `locateRuns`. */
export function rectsOnRuns(
  runs: RectRun[],
  spans: (RunSpan | null)[],
  start: number,
  end: number,
  measure: (text: string, font: string) => number,
): DOMRect[] {
  const out: DOMRect[] = [];
  runs.forEach((run, i) => {
    const span = spans[i];
    if (!span) return;
    const a = Math.max(start, span.start) - span.start;
    const b = Math.min(end, span.end) - span.start;
    if (b <= a) return; // the range misses this run (or is empty)
    // The rect's own width against the measured width absorbs zoom and small font differences.
    const full = measure(run.text, run.font);
    const offset =
      full > 0
        ? (n: number) => measure(run.text.slice(0, n), run.font) * (run.width / full)
        : (n: number) => (run.width * n) / run.text.length;
    const x1 = run.x + offset(a);
    const x2 = run.x + offset(b);
    out.push(new DOMRect(x1, run.y, x2 - x1, run.height));
  });
  return out;
}

/** Viewport rects of [start, end) of `fullText`; [] when none of it is on a rendered (visible) run. */
export function offsetToRects(
  fullText: string,
  runs: RectRun[],
  start: number,
  end: number,
  measure: (text: string, font: string) => number,
): DOMRect[] {
  return rectsOnRuns(runs, locateRuns(fullText, runs), start, end, measure);
}
