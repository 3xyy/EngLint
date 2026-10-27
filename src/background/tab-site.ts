import { isPageDisabled, webHost } from '../core/sites';
import { disabledSitesItem } from '../shared/settings';
import { getTabState, isTabOff } from './tab-state';

/**
 * Whether EngLint is switched off for a tab's site. The host comes from the tab's URL; Chrome hides that from an
 * extension without host access, and then the host its fields reported decides. With neither, it is whether the
 * tab's own frame said its site is off.
 */
export async function tabIsOff(tabId: number, deps: { tabUrl(tabId: number): Promise<string | null> }): Promise<boolean> {
  const host = webHost((await deps.tabUrl(tabId)) ?? '') ?? (await getTabState(tabId))?.host ?? null;
  return host ? isPageDisabled(await disabledSitesItem.getValue(), host) : isTabOff(tabId);
}
