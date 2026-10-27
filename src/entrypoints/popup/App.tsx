import { useEffect, useState } from 'react';
import { keyNeeded, spendTracked } from '../../core/provider';
import { isSiteDisabled } from '../../core/sites';
import { sendMessage } from '../../shared/messages';
import { disabledSitesItem, providerItem } from '../../shared/settings';
import { StatusBanner } from '../../shared/ui/StatusBanner';
import { SPEND_NOT_TRACKED, spendText } from '../../shared/status-text';
import { pageStatus } from '../../shared/page-status';
import { useKeyStatus } from '../../shared/use-key-status';
import { useSetting } from '../../shared/use-setting';
import { useSpend } from '../../shared/use-spend';
import { useCurrentTabId, useTabState } from '../../shared/use-tab-state';

/** The host of the popup's tab, or null when the browser doesn't expose a usable URL. */
function useHost(tabId: number | null): string | null | undefined {
  const [host, setHost] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (tabId === null) return setHost(null);
    let live = true;
    browser.tabs
      .get(tabId)
      .then((tab) => {
        let h: string | null = null;
        try {
          const url = new URL(tab.url ?? '');
          if (url.protocol === 'http:' || url.protocol === 'https:') h = url.hostname;
        } catch {
          // no URL (no activeTab/host permission) or not a web page
        }
        if (live) setHost(h);
      })
      .catch(() => live && setHost(null));
    return () => {
      live = false;
    };
  }, [tabId]);
  return host;
}

function openSettings(): void {
  void browser.runtime
    .openOptionsPage()
    .catch(() => {})
    .finally(() => window.close());
}

function SettingsButton() {
  return (
    <button type="button" className="btn" onClick={openSettings} style={{ marginTop: 8 }}>
      Settings
    </button>
  );
}

export function App() {
  const tabId = useCurrentTabId();
  const host = useHost(tabId);
  const state = useTabState(tabId);
  const spend = useSpend();
  const disabled = useSetting(disabledSitesItem);
  const { status: key, failed: keyFailed } = useKeyStatus();
  const provider = useSetting(providerItem);

  const shell = (children?: React.ReactNode) => (
    <main style={{ width: 300, padding: 16 }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 16 }}>EngLint</h1>
      {children}
      <SettingsButton />
    </main>
  );

  // Settings is always reachable: it never waits for storage, the background or the tab.
  if (host === undefined) return shell();
  if (host === null || tabId === null) return shell(<p>EngLint can't run on this page</p>);
  if (keyFailed && key === null) {
    return shell(
      <>
        <p className="muted" style={{ margin: '0 0 12px' }}>{host}</p>
        <p role="status">Couldn't reach EngLint's background. Try reopening the popup.</p>
      </>,
    );
  }
  if (disabled === null || key === null || spend === null || provider === null) return shell();

  const enabled = !isSiteDisabled(disabled, host);
  const status = pageStatus({ tabState: state, keySaved: key.saved || !keyNeeded(provider), spent: spend.spent, cap: spend.cap, siteDisabled: !enabled });

  return (
    <main style={{ width: 300, padding: 16 }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 16 }}>EngLint</h1>
      <p className="muted" style={{ margin: '0 0 12px' }}>{host}</p>
      <StatusBanner status={status} spend={spend} hideSettingsLink={status === 'key_missing'} />
      {status === 'ok' && (
        <p className="muted" style={{ margin: '0 0 12px' }}>
          {state ? 'Status: checking' : 'Ready. EngLint checks text boxes as you type.'}
        </p>
      )}
      <label className="row">
        <span>EngLint on this site</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void sendMessage('setSiteEnabled', { host, enabled: e.target.checked, tabId })}
        />
      </label>
      <p className="muted">{spendTracked(provider) ? spendText(spend.spent, spend.cap) : SPEND_NOT_TRACKED}</p>
      {status === 'key_missing' ? (
        <button type="button" className="btn primary" onClick={openSettings}>
          Add your API key
        </button>
      ) : (
        <button type="button" className="btn primary" onClick={() => void browser.sidePanel.open({ tabId })}>
          Open panel
        </button>
      )}
      <SettingsButton />
    </main>
  );
}
