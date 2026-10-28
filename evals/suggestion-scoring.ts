/**
 * Pure scoring for the suggestion eval. No side effects and no API: the unit tests import this
 * module, never run-eval.ts (which runs main() at import).
 */
import { toggleOf } from '../src/core/kinds';
import { capFamily } from '../src/core/match';
import type { FamilyToggle, LocatedIssue, RawIssue, SuggestionFamily } from '../src/core/types';

export interface SuggestLabel {
  original: string;
  family: SuggestionFamily;
  kind?: string;
  /** The fix a reader would expect (reported by reportLabelledSuggestions, never scored). */
  replacement?: string;
}
export interface AcceptableLabel {
  original: string;
  family: SuggestionFamily;
}
export interface ScoredFixture {
  text: string;
  suggest?: SuggestLabel[];
  acceptable?: AcceptableLabel[];
}
export interface SuggestionScore {
  correct: number;
  falsePositive: number;
  perFamily: Record<SuggestionFamily, { correct: number; flagged: number }>;
  /**
   * The same counts keyed by the settings toggle (toggleOf): generic_phrasing is `generic`, other delivery kinds
   * `delivery`. Correctness is the same as perFamily (generic_phrasing scores against delivery labels).
   */
  perToggle: Record<FamilyToggle, { correct: number; flagged: number }>;
}

const FAMILIES: SuggestionFamily[] = ['clarity', 'engagement', 'delivery'];
const TOGGLES: FamilyToggle[] = ['clarity', 'engagement', 'delivery', 'generic'];

/**
 * A shown suggestion is correct when its span overlaps a `suggest` or `acceptable` span of the same family
 * (the kind is not scored). Any other suggestion is a false positive. Errors are not counted here.
 * The family is the one selectIssues uses for its toggle and cap (capFamily), so what is scored is what the user sees.
 */
export function scoreSuggestions(fixture: ScoredFixture, shown: LocatedIssue[]): SuggestionScore {
  const labels = [...(fixture.suggest ?? []), ...(fixture.acceptable ?? [])].map((l) => {
    const start = fixture.text.indexOf(l.original);
    return { family: l.family, start, end: start + l.original.length };
  });
  const out: SuggestionScore = {
    correct: 0,
    falsePositive: 0,
    perFamily: Object.fromEntries(FAMILIES.map((f) => [f, { correct: 0, flagged: 0 }])) as SuggestionScore['perFamily'],
    perToggle: Object.fromEntries(TOGGLES.map((t) => [t, { correct: 0, flagged: 0 }])) as SuggestionScore['perToggle'],
  };
  for (const issue of shown) {
    if (issue.severity === 'error') continue;
    // The family selectIssues caps and toggles by: an error category counts as clarity, generic phrasing as delivery.
    const family = capFamily(issue);
    const toggle = toggleOf(issue) ?? 'clarity'; // the toggle selectIssues used (an error category counts as clarity)
    out.perFamily[family].flagged++;
    out.perToggle[toggle].flagged++;
    const hit = labels.some((l) => l.start >= 0 && l.family === family && issue.start < l.end && l.start < issue.end);
    if (hit) {
      out.correct++;
      out.perFamily[family].correct++;
      out.perToggle[toggle].correct++;
    } else out.falsePositive++;
  }
  return out;
}

export interface LabelledTally {
  /** `suggest` labels a shown suggestion of the same family overlaps, of `total`. */
  found: number;
  total: number;
  /** Found labels that name a fix and got it, of `fixTotal`. */
  fixes: number;
  fixTotal: number;
  /** Shown suggestions on a label of their family, and on none. */
  ok: number;
  fp: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A report on a fixture that labels suggestions, for reading rather than gating: each shown suggestion OK or FP
 * (scored as scoreSuggestions scores it), each `suggest` label found or missed, FIX OK or FIX DIFF where a label names
 * its fix (a shown replacement holding it as a whole word, any case), and HIDDEN for each suggestion in `raw` (the
 * model's) that isn't shown.
 */
export function reportLabelledSuggestions(
  id: string,
  fixture: ScoredFixture,
  shown: LocatedIssue[],
  raw: RawIssue[],
): { details: string[]; tally: LabelledTally } {
  const spanOf = (original: string) => {
    const start = fixture.text.indexOf(original);
    return { start, end: start + original.length };
  };
  const on = (s: LocatedIssue, l: { start: number; end: number }) => l.start >= 0 && s.start < l.end && l.start < s.end;
  const labels = [...(fixture.suggest ?? []), ...(fixture.acceptable ?? [])].map((l) => ({ family: l.family, ...spanOf(l.original) }));
  const suggestions = shown.filter((s) => s.severity === 'suggestion');
  const details: string[] = [];
  const tally: LabelledTally = { found: 0, total: fixture.suggest?.length ?? 0, fixes: 0, fixTotal: 0, ok: 0, fp: 0 };
  for (const s of suggestions) {
    const family = capFamily(s);
    const ok = labels.some((l) => l.family === family && on(s, l));
    tally[ok ? 'ok' : 'fp']++;
    details.push(`${ok ? 'SUGGEST OK  ' : 'SUGGEST FP  '} [${id}] "${s.original}" -> ${JSON.stringify(s.replacement)} (${family}/${s.kind})`);
  }
  for (const l of fixture.suggest ?? []) {
    const hits = suggestions.filter((s) => capFamily(s) === l.family && on(s, spanOf(l.original)));
    if (hits.length === 0) {
      details.push(`SUGGEST MISS [${id}] "${l.original}" (${l.family}${l.kind ? '/' + l.kind : ''})`);
      continue;
    }
    tally.found++;
    if (l.replacement === undefined) continue;
    tally.fixTotal++;
    const want = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(l.replacement)}(?![\\p{L}\\p{N}])`, 'iu');
    const fixed = hits.some((s) => s.replacement !== null && want.test(s.replacement));
    if (fixed) tally.fixes++;
    const got = hits.map((s) => JSON.stringify(s.replacement)).join(' / ');
    details.push(`${fixed ? 'FIX OK  ' : 'FIX DIFF'} [${id}] "${l.original}": expected ${JSON.stringify(l.replacement)}, shown ${got}`);
  }
  const shownKeys = new Set(suggestions.map((s) => JSON.stringify([s.model.original, s.model.replacement])));
  for (const r of raw) {
    if (r.severity !== 'suggestion' || shownKeys.has(JSON.stringify([r.original, r.replacement]))) continue;
    details.push(`HIDDEN   [${id}] "${r.original}" -> ${JSON.stringify(r.replacement)} (${r.category}/${r.kind}) given by the model, not shown`);
  }
  return { details, tally };
}
