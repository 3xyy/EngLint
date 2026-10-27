export type Mode = 'essay' | 'standard' | 'casual';
export type Dialect = 'en-US' | 'en-GB' | 'en-CA' | 'en-AU' | 'en-IN';
export type Category =
  | 'spelling'
  | 'grammar'
  | 'punctuation'
  | 'word_choice'
  | 'clarity'
  | 'engagement'
  | 'delivery';
export type SuggestionFamily = 'clarity' | 'engagement' | 'delivery';
export type FamilyToggle = SuggestionFamily | 'generic';
export type FamilyToggles = Record<FamilyToggle, boolean>;
export type Severity = 'error' | 'suggestion';
export type CheckStatus =
  | 'ok'
  | 'off_site'
  | 'paused_cap'
  | 'key_missing'
  | 'key_invalid'
  | 'endpoint_blocked'
  | 'out_of_credit'
  | 'rate_limited'
  | 'overloaded'
  | 'offline'
  | 'bad_response'
  | 'docs_fallback';

export interface RawIssue {
  original: string;
  replacement: string | null;
  before: string;
  category: Category;
  severity: Severity;
  kind: string;
  reason: string;
}

export interface Paragraph {
  id: string; // `p${index}`
  text: string;
  start: number; // UTF-16 offset in the original text
  hash: string;
}

export interface LocatedIssue extends RawIssue {
  /**
   * The model's own `original` and `replacement`. selectIssues may take `original` from the document
   * (typography fallback), curl the fix, or make it comment-only; the session matches this issue to
   * its raw entry, and keys its dismissal, by these.
   */
  model: { original: string; replacement: string | null };
  id: string;
  paragraphHash: string;
  start: number; // absolute offsets
  end: number;
}
