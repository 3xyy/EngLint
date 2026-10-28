import type { CheckStatus } from '../../core/types';
import { helpLink, linksToSettings, statusText } from '../status-text';
import { useProviderInfo } from '../use-provider-info';
import { Pill, type PillProps } from './controls';

/**
 * The status in a few words, for a header pill: `active` once a text box on the page has reported (before that,
 * "Ready"). The banner says what to do about a problem; the pill only names it.
 */
export function statusPill(status: CheckStatus, active: boolean): { tone: NonNullable<PillProps['tone']>; label: string } {
  switch (status) {
    case 'ok':
      return active ? { tone: 'ok', label: 'Up to date' } : { tone: 'neutral', label: 'Ready' };
    case 'paused_cap':
      return { tone: 'error', label: 'Paused at your limit' };
    case 'off_site':
      return { tone: 'neutral', label: 'Off for this site' };
    case 'key_missing':
    case 'key_invalid':
    case 'endpoint_blocked':
      return { tone: 'error', label: 'Needs setup' };
    case 'out_of_credit':
      return { tone: 'error', label: 'Out of credit' };
    case 'rate_limited':
    case 'overloaded':
      return { tone: 'accent', label: 'Retrying' };
    case 'bad_response':
      return { tone: 'accent', label: 'Will retry' };
    case 'offline':
      return { tone: 'error', label: 'Offline' };
    case 'docs_fallback':
      return { tone: 'neutral', label: 'Limited in Docs' };
  }
}

export function StatusPill({ status, active, className }: { status: CheckStatus; active: boolean; className?: string }) {
  const { tone, label } = statusPill(status, active);
  return (
    <Pill tone={tone} dot className={className}>
      {label}
    </Pill>
  );
}

/** The visible form of a non-ok status. Key problems link to the options page; account problems to the Console. */
export function StatusBanner({
  status,
  spend,
  hideSettingsLink = false,
}: {
  status: CheckStatus;
  spend?: { spent: number; cap: number } | null;
  /** The page already has its own main button to settings. */
  hideSettingsLink?: boolean;
}) {
  const who = useProviderInfo();
  const text = statusText(status, spend ?? undefined, who);
  if (!text) return null;
  const help = helpLink(status, who);
  return (
    <div className="banner" role="status">
      {text}
      {help && (
        <>
          {' '}
          <a href={help.href} target="_blank" rel="noopener noreferrer">
            {help.label}
          </a>
        </>
      )}
      {linksToSettings(status) && !hideSettingsLink && (
        <>
          {' '}
          <button type="button" className="link" onClick={() => void browser.runtime.openOptionsPage()}>
            Open settings
          </button>
        </>
      )}
    </div>
  );
}
