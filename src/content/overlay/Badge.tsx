import { shownFamily } from '../../core/kinds';
import type { ProviderInfo } from '../../core/provider';
import type { CheckStatus, FamilyToggle, LocatedIssue } from '../../core/types';
import { statusText } from '../../shared/status-text';
import { byUser } from './by-user';

/** The badge's diameter, px (overlay.css .englint-badge). */
export const BADGE_SIZE = 20;

/** What the badge is told about its field. */
export interface BadgeView {
  /** Open issues with severity 'error'. */
  errors: number;
  /** Every other open issue. */
  suggestions: number;
  /** A check request is in flight. */
  busy: boolean;
  status: CheckStatus;
  /** The field has had its first answer: until then, no issues means nothing is known yet. */
  checked: boolean;
  /** The top family of the open suggestions (topFamily): a suggestions count is drawn in its colour. */
  family?: FamilyToggle;
}

/** The suggestion families in the order the panel lists them. */
const FAMILY_ORDER: readonly FamilyToggle[] = ['clarity', 'engagement', 'delivery', 'generic'];

/** The first family, in the panel's order, with an open suggestion (an error's family, Correctness, isn't listed). */
export function topFamily(issues: readonly LocatedIssue[]): FamilyToggle | undefined {
  const open = new Set(issues.map(shownFamily));
  return FAMILY_ORDER.find((f) => open.has(f));
}

export interface BadgeLook {
  face: 'count' | 'check' | 'dot' | 'spinner' | 'status';
  /** The count or the status glyph; '' for the check, the dot and the spinner. */
  text: string;
  /**
   * red: errors, or a key problem; family: suggestions only, in `family`'s colour; green: nothing open; grey:
   * checking (or soon), or Claude out of reach; amber: spending, or Docs.
   */
  tone: 'red' | 'family' | 'green' | 'grey' | 'amber';
  /** The family whose colour a suggestions count is drawn in. */
  family?: FamilyToggle;
  /** Its accessible name. */
  label: string;
}

/** The glyph for a status that stops or holds checking; null when the counts are what matters. */
function statusGlyph(status: CheckStatus): Pick<BadgeLook, 'text' | 'tone'> | null {
  switch (status) {
    case 'paused_cap':
    case 'out_of_credit':
      return { text: '$', tone: 'amber' };
    case 'key_missing':
    case 'key_invalid':
    case 'endpoint_blocked':
      return { text: '!', tone: 'red' };
    case 'docs_fallback':
      return { text: '–', tone: 'amber' };
    case 'rate_limited':
    case 'overloaded':
    case 'offline':
    case 'bad_response':
      return { text: '…', tone: 'grey' };
    case 'ok':
    case 'off_site':
      return null;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shown = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * What the badge shows, in this order: the spinner while a check is in flight; a status glyph while a status
 * stops or holds checking; the error count in red; the suggestion count in its top family's colour (Clarity's
 * when none is given) when there are no errors;
 * a green check when nothing is open, or a grey dot before the field's first answer. `who` names the provider in a
 * status's label.
 */
export function badgeLook(view: BadgeView, who: ProviderInfo): BadgeLook {
  if (view.busy) return { face: 'spinner', text: '', tone: 'grey', label: 'EngLint: checking' };
  const glyph = statusGlyph(view.status);
  if (glyph) return { face: 'status', ...glyph, label: `EngLint: ${statusText(view.status, undefined, who)}` };
  const { errors, suggestions } = view;
  if (errors + suggestions === 0) {
    return view.checked
      ? { face: 'check', text: '', tone: 'green', label: 'EngLint: no issues' }
      : { face: 'dot', text: '', tone: 'grey', label: 'EngLint: checking soon' };
  }
  const label = `EngLint: ${plural(errors, 'error')}, ${plural(suggestions, 'suggestion')}`;
  if (errors > 0) return { face: 'count', text: shown(errors), tone: 'red', label };
  return { face: 'count', text: shown(suggestions), tone: 'family', family: view.family ?? 'clarity', label };
}

/**
 * Whether something other than the field, its contents or EngLint's own elements is on top at a point: the
 * badge moves aside for it (another extension's badge, the page's own UI over the corner). Our elements are
 * looked past, so the badge already standing there doesn't hide what is under it.
 */
export function coveredAt(field: Element): (x: number, y: number) => boolean {
  const root = field.getRootNode() as Document | ShadowRoot;
  return (x, y) => {
    const stack =
      typeof root.elementsFromPoint === 'function' ? root.elementsFromPoint(x, y) : [root.elementFromPoint?.(x, y) ?? null];
    const top = stack.find((el): el is Element => !!el && !el.localName.startsWith('englint-'));
    return !!top && !field.contains(top);
  };
}

/**
 * The badge in the focused field's corner, in the fixed overlay. Its mousedown is prevented, so pressing it
 * leaves focus (and the badge) in the field; it is out of the Tab order for the same reason. Only the user's
 * own click counts (byUser): a page script can't press it. `hot`: the pointer is over its field (full opacity).
 */
export function Badge(props: { x: number; y: number; look: BadgeLook; hot?: boolean; onClick(): void }) {
  const { look } = props;
  return (
    <button
      type="button"
      className={`englint-badge ${look.tone}${look.family ? ` el-fam-${look.family}` : ''}${props.hot ? ' hot' : ''}`}
      aria-label={look.label}
      tabIndex={-1}
      style={{ left: props.x, top: props.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={byUser(() => props.onClick())}
    >
      {look.face === 'spinner' ? (
        <span className="englint-badge-spinner" aria-hidden="true" />
      ) : look.face === 'dot' ? (
        <span className="englint-badge-dot" aria-hidden="true" />
      ) : look.face === 'check' ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M2.5 6.2 5 8.6 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className={look.text.length > 2 ? 'englint-badge-text long' : 'englint-badge-text'} aria-hidden="true">
          {look.text}
        </span>
      )}
    </button>
  );
}
