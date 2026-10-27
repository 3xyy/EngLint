import { CLAUDE_INFO, type ProviderInfo } from '../core/provider';
import type { CheckStatus } from '../core/types';

/** The provider's name when it is Claude: the only one with a Console to add credit in. */
export const CLAUDE = CLAUDE_INFO.name;

/**
 * The banner copy for a status, naming the provider (`who`, from providerInfo(): every caller says which); null when
 * nothing is wrong.
 */
export function statusText(status: CheckStatus, spend: { spent: number; cap: number } | undefined, who: ProviderInfo): string | null {
  const { name } = who;
  switch (status) {
    case 'ok':
      return null;
    case 'key_missing':
      return `Add your ${name} API key to start checking.`;
    case 'key_invalid':
      // A server on this computer takes no key: its 401 or 403 is a refusal (Ollama refuses an origin it doesn't list).
      return who.keyless
        ? `${name} refused the request. Check that it accepts requests from browser extensions.`
        : 'Your API key was rejected. Check it in settings.';
    case 'endpoint_blocked':
      return `EngLint isn't allowed to reach ${name} yet. Open Settings to allow it.`;
    case 'out_of_credit':
      return name === CLAUDE
        ? 'Your Claude account is out of API credit. Add credit in the Claude Console.'
        : `Your ${name} account is out of credit.`;
    case 'paused_cap':
      return spend
        ? `Monthly limit reached ($${spend.spent.toFixed(2)} of $${spend.cap}). Live checks are paused.`
        : 'Monthly limit reached. Live checks are paused.';
    case 'rate_limited':
    case 'overloaded':
      return `${name} is busy. Retrying shortly.`;
    case 'offline':
      return `Can't reach ${name}. Check your connection.`;
    case 'bad_response':
      return `Got an unexpected answer from ${name}. Will retry on your next edit.`;
    case 'docs_fallback':
      return "Google Docs live checking isn't available right now.";
    case 'off_site':
      return 'EngLint is off for this site.';
  }
}

const TOOLS_PAUSED = 'Rewrites, synonyms, chat and reviews are paused until next month or until you raise the limit in settings.';

/**
 * The tools' and the chat's copy for a status. Four live-check messages are wrong there: nothing retries
 * a tool request by itself (the popover has a Retry button), and the cap pauses rewrites, synonyms, chat and reviews,
 * not live checks. Every other status reads as statusText().
 */
export function toolStatusText(status: CheckStatus, spend: { spent: number; cap: number } | undefined, who: ProviderInfo): string | null {
  const { name } = who;
  switch (status) {
    case 'rate_limited':
    case 'overloaded':
      return `${name} is busy right now. Try again in a moment.`;
    case 'bad_response':
      return `Couldn't get a usable answer from ${name}. Try again.`;
    case 'paused_cap':
      return spend
        ? `Monthly limit reached ($${spend.spent.toFixed(2)} of $${spend.cap}). ${TOOLS_PAUSED}`
        : `Monthly limit reached. ${TOOLS_PAUSED}`;
    default:
      return statusText(status, spend, who);
  }
}

/** The panel couldn't reach the field's frame (the page went away, or its script isn't running there). */
export const UNREACHABLE_FIELD = "Couldn't reach that text box. Click into it and try again.";

/** A fix, a version or a chat edit the field wouldn't take: it went to the clipboard instead. */
export const APPLY_FAILED_COPIED = "Couldn't apply here — copied to clipboard.";
/** The same, when the clipboard refused it too. */
export const APPLY_FAILED = "Couldn't apply here.";

export const BILLING_URL = 'https://platform.claude.com/settings/billing';

/** Statuses fixed outside EngLint: where the banner links (opened in a new tab). */
export function helpLink(status: CheckStatus, who: ProviderInfo): { href: string; label: string } | null {
  return status === 'out_of_credit' && who.name === CLAUDE ? { href: BILLING_URL, label: 'Open billing' } : null;
}

/** Statuses fixed in the options page, so their banner links there. */
export function linksToSettings(status: CheckStatus): boolean {
  return status === 'key_missing' || status === 'key_invalid' || status === 'endpoint_blocked';
}

/** In place of the meter when the active fast or smart model has no prices: it would read $0.00 whatever was spent. */
export const SPEND_NOT_TRACKED = 'Spending not tracked';

export function spendText(spent: number, cap: number): string {
  return `$${spent.toFixed(2)} of $${cap} this month`;
}
