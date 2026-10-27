import { storage } from 'wxt/utils/storage';
import type { CheckStatus, LocatedIssue, Mode } from '../core/types';
import type { IssuesUpdate } from '../shared/messages';

export interface TabState {
  host: string;
  mode: Mode;
  status: CheckStatus;
  activeFieldId: string | null;
  fields: Record<string, LocatedIssue[]>;
  /** The frame each field lives in, so panel messages can target it (`{ tabId, frameId }`). */
  frames: Record<string, number>;
  /**
   * Random, made when the tab's state is first created after a clear: a new page (or a closed and reopened tab) gets
   * a new one; a move within the page (a new fragment) keeps it.
   */
  pageId: string;
}

const keyFor = (tabId: number) => `session:tab:${tabId}` as const;
/** Set while the tab's site is switched off: its badge says "off". Kept apart from TabState (no fields, nothing checked). */
const offKeyFor = (tabId: number) => `session:tabOff:${tabId}` as const;

// Serializes read-modify-write: several fields in one tab update at once.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Runs `fn` after every tab-state update queued before it, so it reads their result (badge refreshes). */
export function afterTabUpdates<T>(fn: () => Promise<T>): Promise<T> {
  return serialized(fn);
}

export function getTabState(tabId: number): Promise<TabState | null> {
  return storage.getItem<TabState>(keyFor(tabId));
}

export function applyIssuesUpdate(tabId: number, u: IssuesUpdate, frameId: number): Promise<void> {
  return serialized(async () => {
    const prev = await getTabState(tabId);
    const fields = { ...prev?.fields, [u.fieldId]: u.issues };
    const frames = { ...prev?.frames, [u.fieldId]: frameId };
    let activeFieldId = u.focused ? u.fieldId : (prev?.activeFieldId ?? null);
    if (u.removed) {
      delete fields[u.fieldId];
      delete frames[u.fieldId];
      if (activeFieldId === u.fieldId) activeFieldId = null;
    }
    const next: TabState = { host: u.host, mode: u.mode, status: u.status, activeFieldId, fields, frames, pageId: prev?.pageId ?? crypto.randomUUID() };
    await storage.setItem(keyFor(tabId), next);
  });
}

/** Forgets the tab's page (fields and off flag): a new page in the tab, or the tab closed. Queued after the updates before it. */
export function clearTab(tabId: number): Promise<void> {
  return serialized(() => storage.removeItems([keyFor(tabId), offKeyFor(tabId)]));
}

export async function isTabOff(tabId: number): Promise<boolean> {
  return (await storage.getItem<boolean>(offKeyFor(tabId))) === true;
}

export function setTabOff(tabId: number, off: boolean): Promise<void> {
  return serialized(() => (off ? storage.setItem(offKeyFor(tabId), true) : storage.removeItem(offKeyFor(tabId))));
}
