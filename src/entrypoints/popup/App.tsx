import { useEffect, useState, type ReactNode } from 'react';
import { effectiveMode } from '../../core/modes';
import { keyNeeded, spendTracked } from '../../core/provider';
import { isSiteDisabled } from '../../core/sites';
import type { Mode } from '../../core/types';
import { sendMessage } from '../../shared/messages';
import { disabledSitesItem, essaySitesItem, providerItem, siteModesItem } from '../../shared/settings';
import { Button, Segmented, Switch, type SegmentedOption } from '../../shared/ui/controls';
import { SpendMeter } from '../../shared/ui/SpendMeter';
import { StatusBanner, StatusPill } from '../../shared/ui/StatusBanner';
import { pageStatus } from '../../shared/page-status';
import { useKeyStatus } from '../../shared/use-key-status';
import { useSetting } from '../../shared/use-setting';
import { useSpend } from '../../shared/use-spend';
import { useCurrentTabId, useTabState } from '../../shared/use-tab-state';
import './popup.css';

const MODES: SegmentedOption<Mode>[] = [
  { value: 'essay', label: 'Essay' },
  { value: 'standard', label: 'Standard' },
  { value: 'casual', label: 'Casual' },
];

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

/** The popup's frame: the wordmark (and the site, and a status pill, once known), the body, then the buttons. */
function Shell({ host, pill, actions, children }: { host?: string; pill?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <main className="popup">
      <header className="popup-head">
        <div className="popup-title">
          <h1 className="popup-mark">EngLint</h1>
          {host && <p className="popup-site">{host}</p>}
        </div>
        {pill}
      </header>
      {children}
      <div className="popup-actions">
        {actions}
        {/* Settings is always reachable: it never waits for storage, the background or the tab. */}
        <Button onClick={openSettings}>Settings</Button>
      </div>
    </main>
  );
}

export function App() {
  const tabId = useCurrentTabId();
  const host = useHost(tabId);
  const state = useTabState(tabId);
  const spend = useSpend();
  const disabled = useSetting(disabledSitesItem);
  const siteModes = useSetting(siteModesItem);
  const essaySites = useSetting(essaySitesItem);
  const { status: key, failed: keyFailed } = useKeyStatus();
  const provider = useSetting(providerItem);

  if (host === undefined) return <Shell />;
  if (host === null || tabId === null) {
    return (
      <Shell>
        <p className="popup-note">EngLint can't run on this page</p>
      </Shell>
    );
  }
  if (keyFailed && key === null) {
    return (
      <Shell host={host}>
        <p className="popup-note" role="status">
          Couldn't reach EngLint's background. Try reopening the popup.
        </p>
      </Shell>
    );
  }
  if (disabled === null || siteModes === null || essaySites === null || key === null || spend === null || provider === null) {
    return <Shell host={host} />;
  }

  const enabled = !isSiteDisabled(disabled, host);
  const status = pageStatus({ tabState: state, keySaved: key.saved || !keyNeeded(provider), spent: spend.spent, cap: spend.cap, siteDisabled: !enabled });
  const mode = effectiveMode(host, siteModes, essaySites);

  return (
    <Shell
      host={host}
      pill={<StatusPill status={status} active={!!state} />}
      actions={
        status === 'key_missing' ? (
          <Button variant="primary" className="popup-main" onClick={openSettings}>
            Add your API key
          </Button>
        ) : (
          <Button variant="primary" className="popup-main" onClick={() => void browser.sidePanel.open({ tabId })}>
            Open panel
          </Button>
        )
      }
    >
      {/* Off for this site needs no banner: the pill and the switch say so. */}
      {status !== 'off_site' && <StatusBanner status={status} spend={spend} hideSettingsLink={status === 'key_missing'} />}
      {status === 'ok' && !state && <p className="popup-note">EngLint checks text boxes as you type.</p>}
      <div className="popup-card">
        <label className="setting">
          <span className="setting-name">Check this site</span>
          <Switch aria-label="Check this site" checked={enabled} onChange={(on) => void sendMessage('setSiteEnabled', { host, enabled: on, tabId })} />
        </label>
        <div className="popup-mode">
          <span className="popup-mode-label" aria-hidden="true">
            Mode
          </span>
          <Segmented label="Mode" options={MODES} value={mode} onChange={(m) => void sendMessage('setSiteMode', { host, mode: m })} />
        </div>
      </div>
      <SpendMeter spend={spend} tracked={spendTracked(provider)} />
    </Shell>
  );
}
