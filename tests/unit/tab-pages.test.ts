import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { loadChat } from '../../src/background/chat-store';
import { askTopFrame, watchTabPages } from '../../src/background/tab-pages';
import { applyIssuesUpdate, getTabState, isTabOff, setTabOff, type TabState } from '../../src/background/tab-state';
import type { ChatTurn } from '../../src/core/chat-format';
import { onMessage, type IssuesUpdate } from '../../src/shared/messages';

beforeEach(() => fakeBrowser.reset());

const DOC = 'https://docs.google.com/document/d/1/edit?tab=t.0';
const upd = (over: Partial<IssuesUpdate> = {}): IssuesUpdate => ({
  fieldId: 'gdocs', host: 'docs.google.com', mode: 'essay', status: 'ok', focused: false, issues: [], ...over,
});
const turns: ChatTurn[] = [{ role: 'user', text: 'Is this clear?' }, { role: 'assistant', text: 'Yes.' }];
const settled = () => new Promise((r) => setTimeout(r, 20));
const noReceiver = () => new Error('Could not establish connection. Receiving end does not exist.');

function setup() {
  // The state each badge redraw saw.
  const badgeSaw: (TabState | null)[] = [];
  const deps = {
    tabGone: vi.fn((_tabId: number) => {}),
    refreshBadge: vi.fn(async (tabId: number) => void badgeSaw.push(await getTabState(tabId))),
    // The page's EngLint script answers, by default.
    pagePresent: vi.fn(async (_tabId: number): Promise<unknown> => true),
  };
  const starts = new Map<number, number>();
  return { pages: watchTabPages(fakeBrowser.tabs, deps, starts), deps, badgeSaw, starts };
}

describe('tab pages: pageStarted', () => {
  it("a top frame's pageStarted clears its tab's state, off flag and chats, forgets its focused frame, then redraws its badge", async () => {
    const { pages, deps, badgeSaw } = setup();
    await applyIssuesUpdate(7, upd(), 0);
    await setTabOff(7, true);
    await applyIssuesUpdate(8, upd(), 0);
    await storage.setItem('session:chat:7:gdocs', turns);
    await storage.setItem('session:chat:8:gdocs', turns);

    await pages.pageStarted({ tab: { id: 7 }, frameId: 0 });
    expect(await getTabState(7)).toBeNull();
    expect(await isTabOff(7)).toBe(false);
    expect(await loadChat(7, 'gdocs')).toEqual([]);
    expect(deps.tabGone).toHaveBeenCalledWith(7);
    expect(deps.refreshBadge).toHaveBeenCalledWith(7);
    expect(badgeSaw).toEqual([null]);
    // Another tab keeps its own.
    expect(await getTabState(8)).not.toBeNull();
    expect(await loadChat(8, 'gdocs')).toHaveLength(2);
  });

  it('pageStarted from a frame, or without a tab or a frame id, changes nothing', async () => {
    const { pages, deps } = setup();
    await applyIssuesUpdate(7, upd(), 0);
    await storage.setItem('session:chat:7:gdocs', turns);
    for (const sender of [{ tab: { id: 7 }, frameId: 2 }, { tab: { id: 7 } }, { frameId: 0 }]) {
      await pages.pageStarted(sender);
    }
    expect(await getTabState(7)).not.toBeNull();
    expect(await loadChat(7, 'gdocs')).toHaveLength(2);
    expect(deps.tabGone).not.toHaveBeenCalled();
    expect(deps.refreshBadge).not.toHaveBeenCalled();
  });

  it("the new page's first report, sent right after pageStarted, is kept", async () => {
    const { pages } = setup();
    await applyIssuesUpdate(7, upd({ fieldId: 'old' }), 0);
    const started = pages.pageStarted({ tab: { id: 7 }, frameId: 0 });
    await applyIssuesUpdate(7, upd({ fieldId: 'new' }), 0);
    await started;
    expect(Object.keys((await getTabState(7))!.fields)).toEqual(['new']);
  });
});

describe('tab pages: tab updates', () => {
  it("a new URL (another fragment, path or query) or a status alone keeps the tab's state, page id and chats", async () => {
    const { pages, deps } = setup();
    await pages.pageStarted({ tab: { id: 7 }, frameId: 0 });
    await applyIssuesUpdate(7, upd(), 0);
    const pageId = (await getTabState(7))!.pageId;
    await storage.setItem('session:chat:7:gdocs', turns);
    deps.tabGone.mockClear();
    deps.refreshBadge.mockClear();

    for (const change of [
      { status: 'loading', url: `${DOC}#heading=h.x` },
      { status: 'loading', url: 'https://docs.google.com/document/d/1/edit?tab=t.1' },
      { url: 'https://docs.google.com/document/d/2/edit' },
      { status: 'loading' },
    ]) {
      await fakeBrowser.tabs.onUpdated.trigger(7, change as any, {} as any);
    }
    await settled();
    expect((await getTabState(7))?.pageId).toBe(pageId);
    expect(await loadChat(7, 'gdocs')).toHaveLength(2);
    expect(deps.tabGone).not.toHaveBeenCalled();
    expect(deps.refreshBadge).not.toHaveBeenCalled();
    expect(deps.pagePresent).not.toHaveBeenCalled();
  });
});

describe('tab pages: a loaded page with no EngLint script', () => {
  it("status 'complete' with no answer from the top frame clears the tab's state, off flag and chats, forgets its focused frame, then redraws its badge", async () => {
    const { deps, badgeSaw } = setup();
    deps.pagePresent.mockRejectedValue(noReceiver());
    await applyIssuesUpdate(7, upd(), 0);
    await setTabOff(7, true);
    await applyIssuesUpdate(8, upd(), 0);
    await storage.setItem('session:chat:7:gdocs', turns);
    await storage.setItem('session:chat:8:gdocs', turns);

    await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'complete' }, {} as any);
    await vi.waitFor(() => expect(deps.refreshBadge).toHaveBeenCalledWith(7));
    expect(deps.pagePresent).toHaveBeenCalledWith(7);
    expect(await getTabState(7)).toBeNull();
    expect(await isTabOff(7)).toBe(false);
    expect(await loadChat(7, 'gdocs')).toEqual([]);
    expect(deps.tabGone).toHaveBeenCalledWith(7);
    expect(badgeSaw).toEqual([null]);
    // Another tab keeps its own.
    expect(await getTabState(8)).not.toBeNull();
    expect(await loadChat(8, 'gdocs')).toHaveLength(2);
  });

  it("status 'complete' with the page's script answering keeps everything", async () => {
    const { deps } = setup();
    await applyIssuesUpdate(7, upd(), 0);
    await storage.setItem('session:chat:7:gdocs', turns);
    await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'complete' }, {} as any);
    await settled();
    expect(deps.pagePresent).toHaveBeenCalledWith(7);
    expect(await getTabState(7)).not.toBeNull();
    expect(await loadChat(7, 'gdocs')).toHaveLength(2);
    expect(deps.tabGone).not.toHaveBeenCalled();
    expect(deps.refreshBadge).not.toHaveBeenCalled();
  });

  it('a same-document change (loading, then complete, the script answering) keeps everything; only complete asks', async () => {
    const { pages, deps } = setup();
    await pages.pageStarted({ tab: { id: 7 }, frameId: 0 });
    await applyIssuesUpdate(7, upd(), 0);
    const pageId = (await getTabState(7))!.pageId;
    await storage.setItem('session:chat:7:gdocs', turns);
    deps.tabGone.mockClear();
    deps.refreshBadge.mockClear();

    await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'loading', url: `${DOC}#heading=h.x` }, {} as any);
    await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'loading' }, {} as any);
    expect(deps.pagePresent).not.toHaveBeenCalled();
    await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'complete' }, {} as any);
    await settled();
    expect(deps.pagePresent).toHaveBeenCalledTimes(1);
    expect((await getTabState(7))?.pageId).toBe(pageId);
    expect(await loadChat(7, 'gdocs')).toHaveLength(2);
    expect(deps.tabGone).not.toHaveBeenCalled();
    expect(deps.refreshBadge).not.toHaveBeenCalled();
  });

  it("a ping that missed a new page's script clears nothing once that page's pageStarted came in: its first report stays", async () => {
    const { pages, deps } = setup();
    let miss!: (e: Error) => void;
    deps.pagePresent.mockReturnValue(new Promise((_resolve, reject) => (miss = reject)));
    await applyIssuesUpdate(7, upd({ fieldId: 'old' }), 0);
    await fakeBrowser.tabs.onUpdated.trigger(7, { status: 'complete' }, {} as any);
    // The new page's script registers just after the ping got there: its pageStarted and first report come in first.
    await pages.pageStarted({ tab: { id: 7 }, frameId: 0 });
    await applyIssuesUpdate(7, upd({ fieldId: 'new' }), 0);
    miss(noReceiver());
    await settled();
    expect(Object.keys((await getTabState(7))!.fields)).toEqual(['new']);
    expect(deps.refreshBadge).toHaveBeenCalledTimes(1); // pageStarted's own
  });

  it("a closed tab's pageStarted count is dropped", async () => {
    const { pages, starts } = setup();
    await pages.pageStarted({ tab: { id: 7 }, frameId: 0 });
    await pages.pageStarted({ tab: { id: 8 }, frameId: 0 });
    expect([...starts.keys()]).toEqual([7, 8]);
    await fakeBrowser.tabs.onRemoved.trigger(7, { windowId: 1, isWindowClosing: false });
    expect([...starts.keys()]).toEqual([8]);
  });
});

describe('askTopFrame', () => {
  /** A tabs.sendMessage like Chrome's promise form: the frame's listeners answer, or it rejects when none does. */
  const promiseTabs = () => ({
    sendMessage: vi.fn(
      (tabId: number, message: unknown, options?: { frameId?: number }) =>
        new Promise((resolve, reject) => {
          void fakeBrowser.runtime.onMessage.trigger(message, { tab: { id: tabId }, frameId: options?.frameId } as any, resolve).then((held) => {
            if (!held.some((r) => (r as unknown) === true)) reject(noReceiver());
          });
        }),
    ),
  });

  it("asks the tab's top frame with the promise form, in the format the page's listener reads, and gets its answer", async () => {
    const off = onMessage('pagePresent', () => true);
    try {
      const tabs = promiseTabs();
      expect(await askTopFrame(tabs, 7)).toBe(true);
      const [tabId, message, options] = tabs.sendMessage.mock.calls[0]!;
      expect(tabId).toBe(7);
      expect(message).toMatchObject({ type: 'pagePresent', id: expect.any(Number), timestamp: expect.any(Number) });
      expect(options).toEqual({ frameId: 0 });
    } finally {
      off();
    }
  });

  it('rejects when no EngLint script answers on the page', async () => {
    await expect(askTopFrame(promiseTabs(), 7)).rejects.toThrow('Receiving end does not exist');
  });

  it("rejects when the frame's listeners leave pagePresent unanswered (Chrome's promise then resolves with nothing)", async () => {
    const tabs = { sendMessage: vi.fn(async (_tabId: number, _message: unknown, _options: { frameId: number }) => undefined) };
    await expect(askTopFrame(tabs, 7)).rejects.toThrow();
  });
});
