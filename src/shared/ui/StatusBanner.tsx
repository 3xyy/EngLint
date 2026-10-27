import type { CheckStatus } from '../../core/types';
import { helpLink, linksToSettings, statusText } from '../status-text';
import { useProviderInfo } from '../use-provider-info';

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
