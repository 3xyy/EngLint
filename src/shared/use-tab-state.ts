import { useEffect, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import type { TabState } from '../background/tab-state';
import type { StorageItemKey } from 'wxt/utils/storage';

/** Watches one tab's state (`session:tab:<id>`, written by the background) live. */
export function useTabState(tabId: number | null): TabState | null {
  const [state, setState] = useState<TabState | null>(null);
  useEffect(() => {
    setState(null);
    if (tabId === null) return;
    const key: StorageItemKey = `session:tab:${tabId}`;
    let live = true;
    void storage.getItem<TabState>(key).then((v) => live && setState(v));
    const unwatch = storage.watch<TabState>(key, (v) => live && setState(v));
    return () => {
      live = false;
      unwatch();
    };
  }, [tabId]);
  return state;
}

/**
 * The tab a page follows: `?tabId=<n>` wins (tests), otherwise the active tab of this window,
 * tracked as the user switches and navigates.
 */
export function useCurrentTabId(): number | null {
  const [tabId, setTabId] = useState<number | null>(() => {
    const n = Number(new URLSearchParams(location.search).get('tabId'));
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const pinned = tabId !== null && new URLSearchParams(location.search).has('tabId');
  useEffect(() => {
    if (pinned) return;
    let live = true;
    const refresh = () =>
      void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (live) setTabId(tab?.id ?? null);
      });
    refresh();
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(refresh);
    return () => {
      live = false;
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(refresh);
    };
  }, [pinned]);
  return tabId;
}
