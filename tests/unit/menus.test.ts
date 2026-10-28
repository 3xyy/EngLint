import { describe, expect, it, vi } from 'vitest';
import {
  createToolsLauncher,
  focusEntries,
  menuRequest,
  registerMenus,
  toolsStashKey,
  type LauncherDeps,
  type MenusApi,
} from '../../src/background/menus';

// registerMenus against a fake contextMenus that records every create; the launcher against fake deps
// whose sends the test can hold, so it can check what happened before the first await.

function fakeMenus() {
  const created: Record<string, unknown>[] = [];
  const order: string[] = [];
  const menus = {
    removeAll: vi.fn(async () => {
      order.push('removeAll');
    }),
    create: vi.fn((props: Record<string, unknown>, done?: () => void) => {
      order.push(`create:${String(props.id)}`);
      created.push(props);
      done?.();
      return String(props.id);
    }),
  };
  return { menus: menus as unknown as MenusApi, created, order, removeAll: menus.removeAll };
}

describe('registerMenus', () => {
  it('creates the parent "EngLint" for selections and editable fields', async () => {
    const { menus, created } = fakeMenus();
    await registerMenus(menus);
    const parent = created.find((p) => p.parentId === undefined)!;
    expect(parent).toMatchObject({ title: 'EngLint', contexts: ['selection', 'editable'] });
    expect(created.filter((p) => p.parentId === undefined)).toHaveLength(1);
  });

  it('its children follow the selection bar: Improve, Shorten ▸, Tone ▸, My voice and More ▸', async () => {
    const { menus, created } = fakeMenus();
    await registerMenus(menus);
    const parent = created.find((p) => p.parentId === undefined)!;
    const under = (id: unknown) => created.filter((p) => p.parentId === id).map((c) => c.title);
    expect(under(parent.id)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'More']);
    expect(under('englint-shorten')).toEqual(['Shorter', 'Fit a word limit…']);
    expect(under('englint-tone')).toEqual(['Formal', 'Confident', 'Friendly', 'Casual']);
    expect(under('englint-more')).toEqual(['Expand', 'Synonyms', 'Ask anything…']);
    expect(created).toHaveLength(1 + 5 + 2 + 4 + 3); // nothing else
    // A child's contexts default to 'page': each one needs the parent's to show under it.
    for (const c of created) expect(c.contexts).toEqual(['selection', 'editable']);
    expect(new Set(created.map((c) => c.id)).size).toBe(created.length);
  });

  it('clears the old menu first, so a reinstall or update never creates a duplicate id', async () => {
    const { menus, order } = fakeMenus();
    await registerMenus(menus);
    expect(order[0]).toBe('removeAll');
    expect(order.filter((o) => o === 'removeAll')).toHaveLength(1);
  });
});

describe('menuRequest', () => {
  it('maps each item to what it opens; the parent, the submenus and unknown ids to null', async () => {
    const { menus, created } = fakeMenus();
    await registerMenus(menus);
    const byTitle = (t: string) => String(created.find((c) => c.title === t)!.id);
    expect(menuRequest(byTitle('Improve'))).toEqual({ kind: 'preset', presetId: 'rewrite' });
    expect(menuRequest(byTitle('Shorter'))).toEqual({ kind: 'preset', presetId: 'shorter' });
    expect(menuRequest(byTitle('Fit a word limit…'))).toEqual({ kind: 'wordLimit' });
    expect(menuRequest(byTitle('Formal'))).toEqual({ kind: 'preset', presetId: 'formal' });
    expect(menuRequest(byTitle('Friendly'))).toEqual({ kind: 'preset', presetId: 'friendlier' });
    expect(menuRequest(byTitle('My voice'))).toEqual({ kind: 'preset', presetId: 'voice' });
    expect(menuRequest(byTitle('Expand'))).toEqual({ kind: 'preset', presetId: 'expand' });
    expect(menuRequest(byTitle('Synonyms'))).toEqual({ kind: 'synonyms' });
    expect(menuRequest(byTitle('Ask anything…'))).toBe('custom-prompt');
    // The ids stay what they were for the presets kept, so a menu Chrome still holds keeps working.
    expect(['englint-rewrite', 'englint-shorter', 'englint-formal', 'englint-voice', 'englint-synonyms', 'englint-custom'].map(menuRequest)).not.toContain(null);
    expect(menuRequest(byTitle('EngLint'))).toBeNull();
    expect(menuRequest(byTitle('Shorten'))).toBeNull();
    expect(menuRequest(byTitle('Tone'))).toBeNull();
    expect(menuRequest(byTitle('More'))).toBeNull();
    expect(menuRequest('englint-clearer')).toBeNull();
    expect(menuRequest('something-else')).toBeNull();
  });
});

function setup() {
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const deps = {
    openPanel: vi.fn((tabId: number) => void calls.push(`panel:${tabId}`)),
    openTools: vi.fn(async (target: { tabId: number; frameId: number }) => {
      calls.push(`tools:${target.tabId}/${target.frameId}`);
      await held;
      return { opened: true };
    }),
    pageSelection: vi.fn(async () => {
      calls.push('pageSelection');
      await held;
      return 'Some page text';
    }),
    stash: vi.fn(async (tabId: number) => void calls.push(`stash:${tabId}`)),
    rememberFocus: vi.fn((_tabId: number, _frameId: number | null) => {}),
    now: () => 1234,
  } satisfies LauncherDeps;
  return { launcher: createToolsLauncher(deps), deps, calls, release };
}

const click = (menuItemId: string, editable: boolean, extra: { selectionText?: string; frameId?: number } = {}) => ({
  menuItemId,
  editable,
  ...extra,
});
const TAB = { id: 7 };

describe('a menu click', () => {
  it('on page text: opens the panel before any await, then stashes the selection and the request', async () => {
    const { launcher, deps, calls, release } = setup();
    const done = launcher.menuClicked(click('englint-shorter', false, { selectionText: 'A sentence.', frameId: 3 }), TAB);
    expect(calls[0]).toBe('panel:7'); // synchronous: sidePanel.open needs the user gesture
    release();
    await done;
    expect(deps.stash).toHaveBeenCalledWith(7, { text: 'A sentence.', request: { kind: 'preset', presetId: 'shorter' }, at: 1234 });
    expect(deps.openTools).not.toHaveBeenCalled();
  });

  it('Ask anything… on page text stashes the text with no request', async () => {
    const { launcher, deps } = setup();
    await launcher.menuClicked(click('englint-custom', false, { selectionText: 'A sentence.' }), TAB);
    expect(deps.openPanel).toHaveBeenCalledWith(7);
    expect(deps.stash).toHaveBeenCalledWith(7, { text: 'A sentence.', at: 1234 });
  });

  it('in an editable field: asks the clicked frame to open the popover with the request, never the panel', async () => {
    const { launcher, deps, release } = setup();
    release();
    await launcher.menuClicked(click('englint-synonyms', true, { selectionText: 'big', frameId: 3 }), TAB);
    expect(deps.openTools).toHaveBeenCalledWith({ tabId: 7, frameId: 3 }, { kind: 'synonyms' });
    await launcher.menuClicked(click('englint-custom', true, { frameId: 0 }), TAB);
    expect(deps.openTools).toHaveBeenLastCalledWith({ tabId: 7, frameId: 0 }, 'custom-prompt');
    expect(deps.openPanel).not.toHaveBeenCalled();
    expect(deps.stash).not.toHaveBeenCalled();
  });

  it('a frame that cannot be reached is not an error', async () => {
    const { launcher, deps } = setup();
    deps.openTools.mockRejectedValueOnce(new Error('No response'));
    await expect(launcher.menuClicked(click('englint-rewrite', true, { frameId: 2 }), TAB)).resolves.toBeUndefined();
  });

  it('ignores the parent, unknown ids and clicks outside a tab', async () => {
    const { launcher, deps } = setup();
    await launcher.menuClicked(click('englint', false, { selectionText: 'x' }), TAB);
    await launcher.menuClicked(click('other', false, { selectionText: 'x' }), TAB);
    await launcher.menuClicked(click('englint-rewrite', false, { selectionText: 'x' }), undefined);
    await launcher.menuClicked(click('englint-rewrite', false, { selectionText: 'x' }), { id: -1 }); // TAB_ID_NONE
    expect(deps.openPanel).not.toHaveBeenCalled();
    expect(deps.openTools).not.toHaveBeenCalled();
    expect(deps.stash).not.toHaveBeenCalled();
  });
});

describe('the shortcut', () => {
  it("with a focused field known in the tab: opens the popover in that field's frame, never the panel", async () => {
    const { launcher, deps, release } = setup();
    launcher.fieldFocused(7, 4, true); // its frame said so (fieldFocused)
    release();
    await launcher.command('englint-tools', TAB);
    expect(deps.openTools).toHaveBeenCalledWith({ tabId: 7, frameId: 4 });
    expect(deps.openPanel).not.toHaveBeenCalled();
  });

  it('with no focused field: opens the panel before any await, then stashes the top frame selection', async () => {
    const { launcher, deps, calls, release } = setup();
    const done = launcher.command('englint-tools', TAB);
    expect(calls[0]).toBe('panel:7');
    release();
    await done;
    expect(deps.pageSelection).toHaveBeenCalledWith(7);
    expect(deps.stash).toHaveBeenCalledWith(7, { text: 'Some page text', at: 1234 });
    expect(deps.openTools).not.toHaveBeenCalled();
  });

  it("with no page selection: opens the panel and leaves the panel's text alone", async () => {
    const { launcher, deps } = setup();
    deps.pageSelection.mockResolvedValueOnce('   ');
    await launcher.command('englint-tools', TAB);
    deps.pageSelection.mockRejectedValueOnce(new Error('No response')); // no script in the top frame
    await launcher.command('englint-tools', TAB);
    expect(deps.openPanel).toHaveBeenCalledTimes(2);
    expect(deps.stash).not.toHaveBeenCalled();
  });

  it("a frame's blur forgets it; another frame's or another tab's does not; a closed or navigated tab is forgotten", async () => {
    const { launcher, deps, release } = setup();
    release();
    launcher.fieldFocused(7, 4, true);
    launcher.fieldFocused(7, 2, false); // another frame of the tab has no focused field
    launcher.fieldFocused(8, 4, false); // another tab
    await launcher.command('englint-tools', TAB);
    expect(deps.openTools).toHaveBeenCalledTimes(1);

    launcher.fieldFocused(7, 4, false); // blurred
    await launcher.command('englint-tools', TAB);
    expect(deps.openPanel).toHaveBeenCalledTimes(1);

    launcher.fieldFocused(7, 5, true);
    launcher.fieldFocused(7, 0, true); // focus moved to a field in the top frame
    launcher.fieldFocused(7, 5, false); // the old frame's blur comes after
    await launcher.command('englint-tools', TAB);
    expect(deps.openTools).toHaveBeenLastCalledWith({ tabId: 7, frameId: 0 });

    launcher.tabGone(7); // closed or navigated
    await launcher.command('englint-tools', TAB);
    expect(deps.openPanel).toHaveBeenCalledTimes(2);
    expect(deps.openTools).toHaveBeenCalledTimes(2);
  });

  it('remembers each change in storage (the prefill after a worker restart reads it back)', () => {
    const { launcher, deps } = setup();
    launcher.fieldFocused(7, 4, true);
    launcher.fieldFocused(7, 2, false); // not the remembered frame: nothing to change
    launcher.fieldFocused(7, 4, false);
    launcher.fieldFocused(9, 1, true);
    launcher.tabGone(9);
    expect(deps.rememberFocus.mock.calls).toEqual([
      [7, 4],
      [7, null],
      [9, 1],
      [9, null],
    ]);
  });

  it('writes storage only when the remembered frame changes: the heartbeat repeating it writes nothing', () => {
    const { launcher, deps } = setup();
    launcher.fieldFocused(7, 4, true);
    launcher.fieldFocused(7, 4, true); // the 10 s heartbeat
    launcher.fieldFocused(7, 4, true);
    launcher.fieldFocused(7, 5, true); // focus moved to another frame
    launcher.fieldFocused(7, 5, false);
    launcher.tabGone(7); // already none
    launcher.fieldFocused(7, 5, true);
    expect(deps.rememberFocus.mock.calls).toEqual([
      [7, 4],
      [7, 5],
      [7, null],
      [7, 5],
    ]);
  });

  it('ignores other commands and a missing tab', async () => {
    const { launcher, deps } = setup();
    await launcher.command('something-else', TAB);
    await launcher.command('englint-tools', undefined);
    expect(deps.openPanel).not.toHaveBeenCalled();
    expect(deps.openTools).not.toHaveBeenCalled();
  });
});

describe('the stash key', () => {
  it('is session:tools:<tabId>', () => {
    expect(toolsStashKey(42)).toBe('session:tools:42');
  });
});

describe('the prefill at worker start (the focus each tab had before the worker slept)', () => {
  it('fills the map, so the next shortcut in a field opens the popover', async () => {
    const { launcher, deps, release } = setup();
    release();
    launcher.prefill([[7, 3]]);
    await launcher.command('englint-tools', TAB);
    expect(deps.openTools).toHaveBeenCalledWith({ tabId: 7, frameId: 3 });
    expect(deps.openPanel).not.toHaveBeenCalled();
  });

  it('never overrides what the worker heard since it started: a focus or a blur', async () => {
    const { launcher, deps, release } = setup();
    release();
    launcher.fieldFocused(7, 0, true); // heard live
    launcher.fieldFocused(8, 2, false); // a blur from a frame this worker never knew
    launcher.tabGone(9);
    launcher.prefill([
      [7, 5],
      [8, 2],
      [9, 1],
    ]); // older, read back late
    await launcher.command('englint-tools', TAB);
    expect(deps.openTools).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
    await launcher.command('englint-tools', { id: 8 });
    await launcher.command('englint-tools', { id: 9 });
    expect(deps.openPanel.mock.calls).toEqual([[8], [9]]);
  });

  it('focusEntries reads the remembered keys out of storage.session', () => {
    expect(
      focusEntries({
        'toolsFocus:7': 3,
        'toolsFocus:12': 0,
        'tab:7': { host: 'x' },
        'tools:7': { text: 'y' },
        'toolsFocus:x': 1,
        'toolsFocus:4': 'no',
        'oldtoolsFocus:5': 1, // only our own keys, whole
        'toolsFocus:6:x': 2,
      }),
    ).toEqual([
      [7, 3],
      [12, 0],
    ]);
  });
});
