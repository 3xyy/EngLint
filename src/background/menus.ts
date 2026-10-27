// The right-click "EngLint" menu and the englint-tools shortcut: how each opens the tools on a selection.
// In a field EngLint can edit, the frame opens the tools popover (openTools). Anywhere else (page text, a
// canvas app, Docs in fallback mode) the side panel opens with the text (the stash), Copy only. The side
// panel needs the user gesture, so it opens synchronously, before any await. Nothing here logs page text.
import { BUILTIN_PRESETS, type ToolRequest } from '../core/presets';
import type { OpenToolsRequest } from '../shared/messages';

export const TOOLS_COMMAND = 'englint-tools';
const ROOT_ID = 'englint';
const CONTEXTS: ['selection', 'editable'] = ['selection', 'editable'];

/** What the side panel's Tools show for a tab: a selection no field holds, and the request to run on it. */
export interface ToolsStash {
  text: string;
  request?: ToolRequest;
  /** When it was written (ms): a request the panel finds much later isn't run (it only fills the text). */
  at: number;
}
/** The stash's storage key (WXT storage: the session area, per tab). */
export const toolsStashKey = (tabId: number) => `session:tools:${tabId}` as const;

/** Where the launcher remembers each tab's focused-field frame, so a restarted worker can read it back. */
export const toolsFocusKey = (tabId: number) => `session:toolsFocus:${tabId}` as const;
const FOCUS_KEY = /^toolsFocus:(\d+)$/; // the same key as chrome.storage.session lists it

/** The remembered [tabId, frameId] pairs in a chrome.storage.session listing. */
export function focusEntries(all: Record<string, unknown>): [number, number][] {
  return Object.entries(all).flatMap(([key, frameId]): [number, number][] => {
    const m = FOCUS_KEY.exec(key);
    return m && typeof frameId === 'number' ? [[Number(m[1]), frameId]] : [];
  });
}

type Child = { id: string; title: string; opens: OpenToolsRequest } | { id: string; separator: true };
const CHILDREN: readonly Child[] = [
  ...BUILTIN_PRESETS.map((p): Child => ({ id: `englint-${p.id}`, title: p.title, opens: { kind: 'preset', presetId: p.id } })),
  { id: 'englint-separator', separator: true },
  { id: 'englint-synonyms', title: 'Synonyms', opens: { kind: 'synonyms' } },
  { id: 'englint-custom', title: 'Custom instruction…', opens: 'custom-prompt' },
];

export type MenusApi = Pick<typeof browser.contextMenus, 'create' | 'removeAll'>;

/**
 * Creates the menu: "EngLint" on a selection or in an editable field, with the four presets, a separator,
 * Synonyms and "Custom instruction…". Chrome keeps menus across worker restarts, so this runs on install
 * and update; it clears the old menu first, or the same ids would be created twice.
 */
export async function registerMenus(menus: MenusApi = browser.contextMenus): Promise<void> {
  await menus.removeAll();
  const create = (props: Parameters<MenusApi['create']>[0]) =>
    new Promise<void>((resolve, reject) =>
      menus.create(props, () => {
        const error = browser.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      }),
    );
  await create({ id: ROOT_ID, title: 'EngLint', contexts: CONTEXTS });
  // A child's contexts default to 'page', where the parent never shows: each one needs the parent's.
  for (const child of CHILDREN) {
    await create(
      'separator' in child
        ? { id: child.id, parentId: ROOT_ID, type: 'separator', contexts: CONTEXTS }
        : { id: child.id, parentId: ROOT_ID, title: child.title, contexts: CONTEXTS },
    );
  }
}

/** What a menu item opens: a request, 'custom-prompt' (the menu with the custom input focused), or null. */
export function menuRequest(menuItemId: string): ToolRequest | 'custom-prompt' | null {
  const child = CHILDREN.find((c) => c.id === menuItemId);
  return child && !('separator' in child) ? child.opens : null;
}

export interface LauncherDeps {
  /** Opens the side panel on the tab. Called synchronously in the click or command handler: it needs the user gesture. */
  openPanel(tabId: number): void;
  /** Asks one frame to open the tools popover on its focused field's selection. */
  openTools(target: { tabId: number; frameId: number }, request?: OpenToolsRequest): Promise<{ opened: boolean }>;
  /** The selected text in the tab's top frame. */
  pageSelection(tabId: number): Promise<string>;
  stash(tabId: number, stash: ToolsStash): Promise<void>;
  /** Persists a tab's focused-field frame (null: none), for the prefill after a worker restart. */
  rememberFocus(tabId: number, frameId: number | null): void;
  now(): number;
}

/** The parts of contextMenus.OnClickData the menu uses. */
export interface MenuClick {
  menuItemId: string | number;
  editable: boolean;
  selectionText?: string;
  frameId?: number;
}

const tabIdOf = (tab?: { id?: number }) => (tab?.id !== undefined && tab.id >= 0 ? tab.id : null); // -1: not a tab

export function createToolsLauncher(deps: LauncherDeps) {
  /**
   * The frame of each tab's focused field, from the frames' fieldFocused messages. The command handler must
   * decide before any await (the gesture), so this lives in memory. A worker that slept forgets it: the
   * frames say it again when a selection settles and every 10 s while it stays, and prefill() reads back
   * what was remembered in storage.session.
   */
  const focused = new Map<number, number>();
  /** Tabs heard from (a focus, a blur, closed) since this worker started: the prefill leaves them alone. */
  const touched = new Set<number>();
  /**
   * What this worker last wrote to storage for each tab: the same again (the frames' heartbeat) writes
   * nothing. Its first write for a tab always goes, so storage never keeps an older worker's frame.
   */
  const remembered = new Map<number, number | null>();

  function setFocus(tabId: number, frameId: number | null) {
    touched.add(tabId);
    if (frameId === null) focused.delete(tabId);
    else focused.set(tabId, frameId);
    if (remembered.get(tabId) === frameId) return; // undefined (never written) matches neither
    remembered.set(tabId, frameId);
    deps.rememberFocus(tabId, frameId);
  }

  const notOpened = () => ({ opened: false });

  /** The panel path: the panel opens at once (still inside the gesture), then gets the text. */
  async function toPanel(tabId: number, text: () => Promise<string>, request?: ToolRequest) {
    deps.openPanel(tabId);
    const got = await text();
    if (got.trim() === '') return; // nothing selected: the panel keeps what it has
    await deps.stash(tabId, { text: got, ...(request ? { request } : {}), at: deps.now() });
  }

  return {
    /** fieldFocused from one frame: it has the tab's focused field, or (focused false) it has none. */
    fieldFocused(tabId: number, frameId: number, isFocused: boolean) {
      if (isFocused) return setFocus(tabId, frameId);
      const known = focused.get(tabId);
      // Another frame's blur after focus moved there changes nothing. Unknown here (this worker hasn't heard
      // yet): forget what an older worker remembered, which may be this frame.
      if (known === frameId || known === undefined) setFocus(tabId, null);
    },

    /** The tab closed or navigated: its fields are gone. */
    tabGone(tabId: number) {
      setFocus(tabId, null);
    },

    /** At worker start: the frames remembered before the worker slept (focusEntries), unless heard since. */
    prefill(entries: [number, number][]) {
      for (const [tabId, frameId] of entries) if (!touched.has(tabId)) focused.set(tabId, frameId);
    },

    /** contextMenus.onClicked. */
    async menuClicked(info: MenuClick, tab?: { id?: number }) {
      const request = menuRequest(String(info.menuItemId));
      const tabId = tabIdOf(tab);
      if (request === null || tabId === null) return;
      if (!info.editable) {
        // Page text or a canvas: no field to edit, so the panel (Copy only). Chrome gives the text.
        return toPanel(tabId, async () => info.selectionText ?? '', request === 'custom-prompt' ? undefined : request);
      }
      // A field (or an editable box EngLint doesn't edit: then the frame answers opened: false).
      await deps.openTools({ tabId, frameId: info.frameId ?? 0 }, request).catch(notOpened);
    },

    /** commands.onCommand. */
    async command(name: string, tab?: { id?: number }) {
      const tabId = tabIdOf(tab);
      if (name !== TOOLS_COMMAND || tabId === null) return;
      const frameId = focused.get(tabId);
      if (frameId !== undefined) {
        await deps.openTools({ tabId, frameId }).catch(notOpened);
        return;
      }
      await toPanel(tabId, () => deps.pageSelection(tabId).catch(() => ''));
    },
  };
}

export type ToolsLauncher = ReturnType<typeof createToolsLauncher>;
