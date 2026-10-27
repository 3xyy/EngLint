import type { ProviderConfig } from '../core/provider';
import { toggleSite, webHost } from '../core/sites';
import { createKeyStore, keyForProvider, keyStatusOf } from '../background/key-store';
import { refreshBadge } from '../background/badge';
import type { PublicPath } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import { startDevReload } from '../background/dev-reload';
import { addDismissal, getDismissalsFor } from '../background/cache';
import { createChatService, watchTabsForChat } from '../background/chat-service';
import { checkFromSender, createCheckService } from '../background/check-service';
import {
  closeWhenLocalChecksOff,
  createCloseOffscreen,
  createEnsureOffscreen,
  createHarperRouter,
  type OffscreenApi,
} from '../background/harper';
import { clientFor } from '../background/llm';
import { createProviderOps } from '../background/provider-ops';
import { readProvider } from '../background/provider-gate';
import { askTopFrame, watchTabPages } from '../background/tab-pages';
import { applyIssuesUpdate, clearTab, setTabOff } from '../background/tab-state';
import { createToolsLauncher, focusEntries, registerMenus, toolsFocusKey, toolsStashKey } from '../background/menus';
import { createReviewService } from '../background/review-service';
import { createToolsService } from '../background/tools-service';
import { onMessage, sendMessage } from '../shared/messages';
import {
  disabledSitesItem,
  siteModesItem,
} from '../shared/settings';

/**
 * The client for `config`, the provider settings the calling service read for this call (never read again here, so
 * the key and the endpoint come from the same read). WXT_API_BASE_URL is set only by `npm run build:e2e` (the mock
 * Anthropic server); undefined means the real API.
 */
const activeClient = (config: ProviderConfig, key: string | null) =>
  clientFor(config, key, { anthropicBaseURL: import.meta.env.WXT_API_BASE_URL || undefined });

/** chrome.offscreen, with hasDocument from runtime.getContexts where Chrome lacks it; undefined without the API. */
function offscreenApi(): OffscreenApi | undefined {
  const offscreen = browser.offscreen;
  if (!offscreen) return undefined;
  return {
    hasDocument:
      typeof offscreen.hasDocument === 'function'
        ? () => offscreen.hasDocument()
        : async () => (await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0,
    createDocument: (p) => offscreen.createDocument(p),
    closeDocument: () => offscreen.closeDocument(),
  };
}

// e2e only: what the last openPanel attempt got from Chrome.
async function recordPanelOpen(outcome: { opened: boolean; error?: string }): Promise<{ opened: boolean }> {
  if (import.meta.env.ENGLINT_E2E) await browser.storage.session.set({ 'e2e:panelOpen': outcome });
  return { opened: outcome.opened };
}

export default defineBackground(() => {
  // Unpacked installs pick up a new `npm run build` by themselves (never in the store or e2e builds).
  void startDevReload({
    running: import.meta.env.ENGLINT_BUILD_ID,
    isUnpacked: async () => (await browser.management.getSelf()).installType === 'development',
    // build-id.txt is written after the bundle, so it isn't in WXT's typed list of public paths.
    readOnDisk: async () => (await fetch(browser.runtime.getURL('/build-id.txt' as PublicPath), { cache: 'no-store' })).text(),
    reload: () => browser.runtime.reload(),
    alarms: browser.alarms,
  });

  // Migrates a key an older build kept in storage.local; reads wait for it.
  const keys = createKeyStore(browser.runtime.getURL('/'), () => readProvider({}));
  const service = createCheckService({
    getApiKey: (provider) => keyForProvider(keys, provider),
    makeClient: activeClient,
    now: () => new Date(),
  });

  const tools = createToolsService({
    getApiKey: (provider) => keyForProvider(keys, provider),
    makeClient: activeClient,
    now: () => new Date(),
    extensionOrigin: browser.runtime.getURL('/'),
  });

  // The side panel's Review tab: every message answers only to an extension page.
  const review = createReviewService({
    getApiKey: (provider) => keyForProvider(keys, provider),
    makeClient: activeClient,
    now: () => new Date(),
    tabUrl: async (tabId) => (await browser.tabs.get(tabId).catch(() => null))?.url ?? null,
    extensionOrigin: browser.runtime.getURL('/'),
  });

  // The side panel's Chat: a long-lived port per open panel, streaming each answer.
  const chat = createChatService({
    getApiKey: (provider) => keyForProvider(keys, provider),
    makeClient: activeClient,
    now: () => new Date(),
    tabUrl: async (tabId) => (await browser.tabs.get(tabId).catch(() => null))?.url ?? null,
    extensionOrigin: browser.runtime.getURL('/'),
  });
  browser.runtime.onConnect.addListener((port) => chat.connect(port));
  watchTabsForChat(browser.tabs);

  onMessage('check', ({ data, sender }) => checkFromSender(service, data, sender));
  // The local Harper checker runs in an offscreen document, so its WebAssembly compiles once per browser session.
  const offscreen = offscreenApi();
  const harper = createHarperRouter({
    ensureOffscreen: createEnsureOffscreen(offscreen),
    closeOffscreen: createCloseOffscreen(offscreen),
    sendToOffscreen: (message) => browser.runtime.sendMessage(message),
    dismissedFor: getDismissalsFor,
    now: () => Date.now(),
    extensionOrigin: browser.runtime.getURL('/'),
  });
  onMessage('harperCheck', ({ data, sender }) => harper.check(data, sender));
  closeWhenLocalChecksOff(harper);
  onMessage('rewrite', ({ data, sender }) => tools.rewrite(data, { topHost: webHost(sender.tab?.url) }));
  onMessage('synonyms', ({ data, sender }) => tools.synonyms(data, { topHost: webHost(sender.tab?.url) }));
  onMessage('followUp', ({ data, sender }) => tools.followUp(data, { topHost: webHost(sender.tab?.url) }));
  onMessage('buildStyleProfile', ({ data, sender }) => tools.buildStyleProfile(data, { url: sender.url }));
  onMessage('reviewTone', ({ data, sender }) => review.tone(data, { url: sender.url }));
  onMessage('reviewReaders', ({ data, sender }) => review.readers(data, { url: sender.url }));
  onMessage('reviewGrade', ({ data, sender }) => review.grade(data, { url: sender.url }));
  onMessage('deepCheck', ({ data, sender }) => review.deepCheck(data, { url: sender.url }));
  onMessage('findCitations', ({ data, sender }) => review.citations(data, { url: sender.url }));
  onMessage('topHost', ({ sender }) => webHost(sender.tab?.url));
  onMessage('dismiss', ({ data }) => addDismissal(data));

  // The right-click menu and the shortcut (background/menus.ts). The side panel opens synchronously in
  // each handler: sidePanel.open needs the user gesture, which ends at the first await.
  const launcher = createToolsLauncher({
    openPanel(tabId) {
      try {
        void browser.sidePanel.open({ tabId }).catch(() => {});
      } catch {
        // no side panel here
      }
    },
    openTools: (target, request) => sendMessage('openTools', request ? { request } : {}, target),
    pageSelection: async (tabId) => (await sendMessage('pageSelection', undefined, { tabId, frameId: 0 }))?.text ?? '',
    stash: (tabId, stash) => storage.setItem(toolsStashKey(tabId), stash),
    rememberFocus(tabId, frameId) {
      const key = toolsFocusKey(tabId);
      void (frameId === null ? storage.removeItem(key) : storage.setItem(key, frameId)).catch(() => {});
    },
    now: () => Date.now(),
  });
  // A worker that slept forgot which frame had each tab's focused field: read back what was remembered. It
  // lands too late for the command that woke the worker, but helps when anything else woke it first.
  const prefill = browser.storage.session
    .get(null)
    .then((all) => launcher.prefill(focusEntries(all)))
    .catch(() => {});
  browser.contextMenus.onClicked.addListener((info, tab) => void launcher.menuClicked(info, tab).catch(() => {}));
  browser.commands.onCommand.addListener((command, tab) => void launcher.command(command, tab).catch(() => {}));
  // e2e only: Playwright can't click Chrome's own menu or press an extension shortcut, so tests call these.
  if (import.meta.env.ENGLINT_E2E) Object.assign(globalThis, { __englintLauncher: launcher, __englintPrefill: prefill });

  // The side panel opens before any await: sidePanel.open needs the user gesture behind the click.
  onMessage('openPanel', ({ sender }) => {
    const tabId = sender.tab?.id;
    let opening: Promise<void>;
    try {
      opening = tabId === undefined ? Promise.reject(new Error('no tab')) : browser.sidePanel.open({ tabId });
    } catch (e) {
      opening = Promise.reject(e);
    }
    return opening.then(
      () => recordPanelOpen({ opened: true }),
      (e: unknown) => recordPanelOpen({ opened: false, error: e instanceof Error ? e.message : String(e) }),
    );
  });

  // A tab's state and chats are about one document: a new one (a navigation, a reload, a back/forward restore, a
  // page with no EngLint script) resets them, a move within the page (a Docs heading's fragment) keeps them.
  const pages = watchTabPages(browser.tabs, {
    tabGone: (tabId) => launcher.tabGone(tabId),
    refreshBadge,
    pagePresent: (tabId) => askTopFrame(browser.tabs, tabId),
  });
  onMessage('pageStarted', ({ sender }) => pages.pageStarted(sender));

  onMessage('fieldFocused', ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) launcher.fieldFocused(tabId, sender.frameId ?? 0, data.focused);
  });

  onMessage('issuesUpdated', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    await applyIssuesUpdate(tabId, data, sender.frameId ?? 0);
    await refreshBadge(tabId);
  });

  onMessage('siteOff', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined || (sender.frameId ?? 0) !== 0) return; // the tab's own site, not a frame's
    await setTabOff(tabId, data.off);
    await refreshBadge(tabId);
  });

  onMessage('setSiteMode', async ({ data }) => {
    await siteModesItem.setValue({ ...(await siteModesItem.getValue()), [data.host]: data.mode });
  });

  onMessage('setSiteEnabled', async ({ data }) => {
    await disabledSitesItem.setValue(toggleSite(await disabledSitesItem.getValue(), data.host, data.enabled));
    if (data.tabId === undefined) return;
    await setTabOff(data.tabId, !data.enabled);
    await refreshBadge(data.tabId);
  });

  onMessage('keyStatus', ({ data }) => keyStatusOf(keys, data?.slot, () => readProvider({})));
  onMessage('setApiKey', ({ data, sender }) => keys.set(data.slot, data.key, sender.url, data.baseURL));
  onMessage('clearApiKey', ({ data, sender }) => keys.clear(data.slot, sender.url));

  // The Options page's provider section: an endpoint's models, and the key test.
  const providerOps = createProviderOps({
    extensionOrigin: browser.runtime.getURL('/'),
    getKey: (slot, endpoint) => keys.keyFor(slot, endpoint),
    makeClient: activeClient,
    now: () => new Date(),
  });
  onMessage('testKey', ({ sender }) => providerOps.testKey(sender.url));
  onMessage('listModels', ({ data, sender }) => providerOps.listModels(data, sender.url));

  browser.tabs.onRemoved.addListener((tabId) => {
    launcher.tabGone(tabId);
    void clearTab(tabId);
    void storage.removeItem(toolsStashKey(tabId)).catch(() => {});
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    void registerMenus().catch(() => {}); // on update too: Chrome keeps the old menu until it is replaced
    // A new install has the default provider, Claude.
    if (reason === 'install' && !(await keys.get('anthropic'))) await browser.runtime.openOptionsPage();
  });
});

