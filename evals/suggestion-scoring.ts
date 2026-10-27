/**
 * Pure scoring for the suggestion eval. No side effects and no API: the unit tests import this
 * module, never run-eval.ts (which runs main() at import).
 */
import { toggleOf } from '../src/core/kinds';
import { capFamily } from '../src/core/match';
import type { FamilyToggle, LocatedIssue, SuggestionFamily } from '../src/core/types';

export interface SuggestLabel {
  original: string;
  family: SuggestionFamily;
  kind?: string;
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
