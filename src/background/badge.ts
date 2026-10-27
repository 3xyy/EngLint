import type { CheckStatus } from '../core/types';
import { afterTabUpdates, getTabState, isTabOff, type TabState } from './tab-state';

const RED = '#d93025';
const GREY = '#80868b';
const AMBER = '#f29900';

export function badgeFor(status: CheckStatus, errorCount: number): { text: string; color: string } {
  switch (status) {
    case 'ok':
      return { text: errorCount > 0 ? String(errorCount) : '', color: RED };
    case 'off_site':
      return { text: 'off', color: GREY };
    case 'paused_cap':
    case 'out_of_credit':
      return { text: '$', color: AMBER };
    case 'key_missing':
    case 'key_invalid':
    case 'endpoint_blocked':
      return { text: '!', color: RED };
    case 'rate_limited':
    case 'overloaded':
    case 'offline':
    case 'bad_response':
      return { text: '…', color: GREY };
    case 'docs_fallback':
      return { text: 'D', color: AMBER };
  }
}

/** Issues with severity 'error' across every field of the tab. */
export function errorCount(state: TabState): number {
  return Object.values(state.fields).reduce(
    (n, issues) => n + issues.filter((i) => i.severity === 'error').length,
    0,
  );
}

/** A tab's badge: "off" while its site is switched off, else its last status and error count (nothing for a tab with no state). */
export function tabBadge(state: TabState | null, off: boolean): { text: string; color: string } {
  return badgeFor(off ? 'off_site' : (state?.status ?? 'ok'), state ? errorCount(state) : 0);
}

/** Redraws the tab's badge from its stored state, after the updates queued before it. */
export function refreshBadge(tabId: number): Promise<void> {
  return afterTabUpdates(async () => {
    const [state, off] = await Promise.all([getTabState(tabId), isTabOff(tabId)]);
    const { text, color } = tabBadge(state, off);
    await Promise.all([
      browser.action.setBadgeText({ tabId, text }),
      browser.action.setBadgeBackgroundColor({ tabId, color }),
    ]);
  });
}
