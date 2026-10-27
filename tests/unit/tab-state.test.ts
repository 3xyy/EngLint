import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { applyIssuesUpdate, clearTab, getTabState, isTabOff, setTabOff } from '../../src/background/tab-state';
import type { IssuesUpdate } from '../../src/shared/messages';
import type { LocatedIssue } from '../../src/core/types';

beforeEach(() => fakeBrowser.reset());

const li = (id: string): LocatedIssue => ({
  id, paragraphHash: 'h', start: 0, end: 1, original: 'a', replacement: 'b', before: '',
  category: 'grammar', severity: 'error', kind: 'k', reason: 'r', model: { original: 'a', replacement: 'b' },
});
const upd = (over: Partial<IssuesUpdate>): IssuesUpdate => ({
  fieldId: 'f1', host: 'example.com', mode: 'standard', status: 'ok', focused: false, issues: [], ...over,
});

describe('tab state', () => {
  it('null when nothing stored', async () => {
    expect(await getTabState(1)).toBeNull();
  });
  it('focused update sets activeFieldId', async () => {
    await applyIssuesUpdate(1, upd({ fieldId: 'f1', issues: [li('a')] }), 0);
    expect((await getTabState(1))!.activeFieldId).toBeNull();
    await applyIssuesUpdate(1, upd({ fieldId: 'f2', focused: true, issues: [li('b')] }), 0);
    const s = (await getTabState(1))!;
    expect(s.activeFieldId).toBe('f2');
    expect(Object.keys(s.fields).sort()).toEqual(['f1', 'f2']);
    expect(s.fields.f2![0]!.id).toBe('b');
  });
  it('records the frame of each field and forgets a removed field', async () => {
    await applyIssuesUpdate(1, upd({ fieldId: 'f-aaaaaa-1', focused: true, issues: [li('a')] }), 7);
    await applyIssuesUpdate(1, upd({ fieldId: 'f-bbbbbb-1', issues: [li('b')] }), 0);
    let s = (await getTabState(1))!;
    expect(s.frames).toEqual({ 'f-aaaaaa-1': 7, 'f-bbbbbb-1': 0 });

    await applyIssuesUpdate(1, upd({ fieldId: 'f-aaaaaa-1', removed: true }), 7);
    s = (await getTabState(1))!;
    expect(s.frames).toEqual({ 'f-bbbbbb-1': 0 });
    expect(Object.keys(s.fields)).toEqual(['f-bbbbbb-1']);
    expect(s.activeFieldId).toBeNull(); // the removed field was the active one
  });
  it('tabs are independent', async () => {
    await applyIssuesUpdate(1, upd({ host: 'a.com' }), 0);
    await applyIssuesUpdate(2, upd({ host: 'b.com' }), 0);
    expect((await getTabState(1))!.host).toBe('a.com');
  });
  it('concurrent updates do not lose fields', async () => {
    await Promise.all([
      applyIssuesUpdate(1, upd({ fieldId: 'f1' }), 0),
      applyIssuesUpdate(1, upd({ fieldId: 'f2' }), 0),
    ]);
    expect(Object.keys((await getTabState(1))!.fields).sort()).toEqual(['f1', 'f2']);
  });
  it('gives a new tab state a page id, keeps it across updates, and makes a new one after clearTab', async () => {
    await applyIssuesUpdate(1, upd({ fieldId: 'f1' }), 0);
    const first = (await getTabState(1))!.pageId;
    expect(first).toMatch(/\S{8,}/);
    await applyIssuesUpdate(1, upd({ fieldId: 'f2' }), 0);
    expect((await getTabState(1))!.pageId).toBe(first);
    await applyIssuesUpdate(2, upd({ fieldId: 'f1' }), 0);
    expect((await getTabState(2))!.pageId).not.toBe(first);
    await clearTab(1);
    await applyIssuesUpdate(1, upd({ fieldId: 'f1' }), 0);
    expect((await getTabState(1))!.pageId).not.toBe(first);
  });
  it('clearTab removes state', async () => {
    await applyIssuesUpdate(1, upd({}), 0);
    await clearTab(1);
    expect(await getTabState(1)).toBeNull();
  });
  it("a report from the old page still queued when the tab is cleared (a new page) doesn't come back after the clear", async () => {
    await Promise.all([applyIssuesUpdate(1, upd({ fieldId: 'old' }), 0), clearTab(1)]);
    expect(await getTabState(1)).toBeNull();
  });
});

describe('tab off flag (the site is switched off in this tab)', () => {
  it('is set and cleared per tab, without creating a tab state', async () => {
    expect(await isTabOff(1)).toBe(false);
    await setTabOff(1, true);
    expect(await isTabOff(1)).toBe(true);
    expect(await isTabOff(2)).toBe(false);
    expect(await getTabState(1)).toBeNull(); // the panel and popup still see "nothing checked here"
    await setTabOff(1, false);
    expect(await isTabOff(1)).toBe(false);
  });
  it('a navigation (clearTab) forgets it with the rest of the tab', async () => {
    await applyIssuesUpdate(1, upd({ issues: [li('a')] }), 0);
    await setTabOff(1, true);
    await clearTab(1);
    expect(await isTabOff(1)).toBe(false);
    expect(await getTabState(1)).toBeNull();
  });
});
