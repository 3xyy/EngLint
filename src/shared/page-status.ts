import type { CheckStatus } from '../core/types';
import type { TabState } from '../background/tab-state';

/** The status a page shows: setup problems come before whatever the last check said. */
export function pageStatus(p: {
  tabState: TabState | null;
  keySaved: boolean;
  spent: number;
  cap: number;
  siteDisabled: boolean;
}): CheckStatus {
  if (!p.keySaved) return 'key_missing';
  if (p.siteDisabled) return 'off_site';
  if (p.spent >= p.cap) return 'paused_cap';
  return p.tabState?.status ?? 'ok';
}
