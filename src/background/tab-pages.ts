import { clearChat } from './chat-store';
import { clearTab } from './tab-state';

export interface TabPagesDeps {
  /** Forgets the frame with the tab's focused field (background/menus.ts). */
  tabGone(tabId: number): void;
  refreshBadge(tabId: number): Promise<void>;
  /** Sends `pagePresent` to the tab's top frame (askTopFrame): resolves when the page's EngLint script answers, rejects when none runs. */
  pagePresent(tabId: number): Promise<unknown>;
}

/** The parts of a `runtime.MessageSender` a `pageStarted` message is judged by. */
export interface PageSender {
  tab?: { id?: number };
  frameId?: number;
}

/**
 * `pagePresent` to the tab's top frame, in the format its listener (shared/messages.ts) reads; resolves only on the
 * page script's answer. The promise form of tabs.sendMessage: no receiver comes back as a rejection, not as an
 * unchecked runtime.lastError in the console. A frame whose listeners leave it unanswered resolves with nothing,
 * which is no answer either.
 */
export async function askTopFrame(
  tabs: { sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown> },
  tabId: number,
): Promise<true> {
  const now = Date.now();
  const answer = await tabs.sendMessage(tabId, { id: now, type: 'pagePresent', timestamp: now }, { frameId: 0 });
  if ((answer as { res?: unknown } | undefined)?.res !== true) throw new Error('No answer from the page');
  return true;
}

/**
 * A tab's state and chats are about one document. A new one resets them: its top frame's EngLint script says so
 * (`pageStarted`) as it starts, and again when a back/forward restore shows it from the bfcache; and a completed
 * load whose top frame has no EngLint script to answer `pagePresent` resets them too (a new-tab page, chrome://, the
 * Web Store, Sheets). Nothing else does: a move within the page (a new fragment, as Docs sets on moving between
 * headings, or history.pushState) keeps them, whatever URL or status Chrome reports for it.
 * `starts` counts each tab's pageStarted messages (a parameter so tests can read it).
 */
export function watchTabPages(
  tabs: Pick<typeof browser.tabs, 'onUpdated' | 'onRemoved'>,
  deps: TabPagesDeps,
  starts = new Map<number, number>(),
) {
  /** Forgets the tab's old page (fields, off flag, chats, focused frame), queued at once; then redraws its badge. */
  function newPage(tabId: number): Promise<void> {
    deps.tabGone(tabId);
    const chats = clearChat(tabId).catch(() => {});
    return Promise.all([clearTab(tabId), chats]).then(() => deps.refreshBadge(tabId));
  }

  tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'complete') return;
    // Chrome keeps most URLs from the extension, so the page is asked whether an EngLint script runs on it. Scripts
    // start by the page's load event, about when 'complete' comes, in no set order: a ping can reach a new page
    // before its script listens. It then clears a page whose own pageStarted, a moment later, clears it anyway. And
    // a missed ping clears only when no pageStarted came in since it was sent, so its clear is queued before that
    // page's pageStarted and so before its first report.
    const seen = starts.get(tabId) ?? 0;
    void deps
      .pagePresent(tabId)
      .then(
        () => undefined,
        () => ((starts.get(tabId) ?? 0) === seen ? newPage(tabId) : undefined),
      )
      .catch(() => {});
  });
  tabs.onRemoved.addListener((tabId) => void starts.delete(tabId));

  /** `pageStarted`: only a tab's top frame (frame id 0) speaks for its document; a frame's start is no new page. */
  function pageStarted(sender: PageSender): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.frameId !== 0) return Promise.resolve();
    starts.set(tabId, (starts.get(tabId) ?? 0) + 1);
    return newPage(tabId);
  }

  return { pageStarted };
}
