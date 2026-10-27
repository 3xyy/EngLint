/**
 * Pure scoring for the local-sources eval (Harper and the generic-phrasing detectors). No side effects and no
 * API: the unit tests import this module, never run-sources-eval.ts (which runs main() at import).
 */
import { locateIssue } from '../src/core/match';
import { carryTypography } from '../src/core/typography';

/** One Harper flag, reduced to what scoring needs. `at` is where `original` starts in the paragraph. */
export interface Flag {
  rule: string;
  original: string;
  replacement: string | null;
  at: number;
  suggestionCount: number;
}
export interface Gold {
  original: string;
  replacement: string | null;
}
export interface FlagRow {
  text: string;
  flags: Flag[];
  gold: Gold[];
}
export interface RuleTally {
  flags: number;
  /** Flags whose range overlaps a gold issue. */
  overlapping: number;
  /** Overlapping flags whose first fix equals the gold fix, after carrying the document's typography. */
  matched: number;
  /** Flags that came with more than one fix. */
  manyFixes: number;
}

type Range = { start: number; end: number };
const overlap = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

/** The text with `range` replaced by the fix, the fix taking on the document's curled quotes. */
function applied(text: string, range: Range, replacement: string): string {
  const original = text.slice(range.start, range.end);
  return text.slice(0, range.start) + carryTypography(original, replacement) + text.slice(range.end);
}

/** Two fixes agree when they leave the same text, so a fix of "an" to "a" equals one of "an year" to "a year". */
function sameFix(text: string, a: Range, aFix: string | null, b: Range, bFix: string | null): boolean {
  if (aFix === null || bFix === null) return aFix === bFix;
  return applied(text, a, aFix) === applied(text, b, bFix);
}

/** Per rule: how many flags, how many overlap a gold issue, and how many also carry its fix. */
export function scoreFlags(rows: FlagRow[]): Record<string, RuleTally> {
  const out: Record<string, RuleTally> = {};
  for (const { text, flags, gold } of rows) {
    const goldRanges = gold.flatMap((g) => {
      const range = locateIssue(text, { original: g.original, before: '' });
      return range ? [{ range, gold: g }] : [];
    });
    for (const flag of flags) {
      const t = (out[flag.rule] ??= { flags: 0, overlapping: 0, matched: 0, manyFixes: 0 });
      t.flags++;
      if (flag.suggestionCount > 1) t.manyFixes++;
      const range = { start: flag.at, end: flag.at + flag.original.length };
      const hits = goldRanges.filter((g) => overlap(range, g.range));
      if (hits.length === 0) continue;
      t.overlapping++;
      if (hits.some((g) => sameFix(text, range, flag.replacement, g.range, g.gold.replacement))) t.matched++;
    }
  }
  return out;
}

/** The share of a rule's flags that were not right (no gold issue with the same fix); 0 for a rule with no flags. */
export const falseFlagRate = (t: RuleTally): number => (t.flags === 0 ? 0 : (t.flags - t.matched) / t.flags);

/** Rules at or under the limit that gave exactly one fix on every flag, sorted by name. */
export function instantCandidates(tallies: Record<string, RuleTally>, maxFalseRate: number): string[] {
  return Object.entries(tallies)
    .filter(([, t]) => t.flags > 0 && t.manyFixes === 0 && falseFlagRate(t) <= maxFalseRate)
    .map(([rule]) => rule)
    .sort();
}

/** The listed rules without any whose false-flag rate is above the limit; a rule that never flagged stays. */
export function pruneInstant(current: ReadonlySet<string>, tallies: Record<string, RuleTally>, maxFalseRate: number): string[] {
  return [...current].filter((rule) => !tallies[rule] || falseFlagRate(tallies[rule]!) <= maxFalseRate).sort();
}

export interface TellLabel {
  pattern: string;
  original: string;
}
export interface TellHit {
  ruleId: string;
  original: string;
  at: number;
}
export interface TellCounts {
  tp: number;
  fp: number;
  fn: number;
}

/** Per pattern: a hit is true when a label of the same pattern overlaps it; a label no hit overlaps is a miss. */
export function scoreTells(fixture: { text: string; expect: TellLabel[] }, hits: TellHit[]): Record<string, TellCounts> {
  const out: Record<string, TellCounts> = {};
  const counts = (pattern: string) => (out[pattern] ??= { tp: 0, fp: 0, fn: 0 });
  const labels = fixture.expect.map((label) => {
    const start = fixture.text.indexOf(label.original);
    return { label, range: { start, end: start + label.original.length } };
  });
  const found = new Set<number>();
  for (const hit of hits) {
    const pattern = hit.ruleId.replace(/^tell:/, '');
    const range = { start: hit.at, end: hit.at + hit.original.length };
    const idx = labels.findIndex((l) => l.label.pattern === pattern && l.range.start >= 0 && overlap(range, l.range));
    if (idx === -1) counts(pattern).fp++;
    else {
      counts(pattern).tp++;
      found.add(idx);
    }
  }
  labels.forEach((l, i) => {
    if (!found.has(i)) counts(l.label.pattern).fn++;
  });
  return out;
}
