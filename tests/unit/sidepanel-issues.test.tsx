import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from 'wxt/utils/storage';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { TabState } from '../../src/background/tab-state';
import { monthKey } from '../../src/background/usage';
import type { LocatedIssue } from '../../src/core/types';
import { App, contextBefore } from '../../src/entrypoints/sidepanel/App';
import { sendMessage } from '../../src/shared/messages';
import { capUsdItem, providerItem, spendItem } from '../../src/shared/settings';

// The side panel's Issues tab and its frame (header, footer) against a fake tab state and background.

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

let n = 0;
function issue(over: Partial<LocatedIssue>): LocatedIssue {
  const original = over.original ?? 'has';
  const replacement = over.replacement === undefined ? 'have' : over.replacement;
  return {
    original,
    replacement,
    before: 'Last week I',
    category: 'grammar',
    severity: 'error',
    kind: 'subject_verb_agreement',
    reason: 'Use "have" with "I".',
    model: { original, replacement },
    id: `i${++n}`,
    paragraphHash: 'h',
    start: 0,
    end: original.length,
    ...over,
  };
}

const HAS = issue({ id: 'has' });
const SPELL = issue({ id: 'spell', original: 'recieve', replacement: 'receive', before: 'I hope to', kind: 'spelling', category: 'spelling', reason: 'Spelling.' });
const WORDY = issue({
  id: 'wordy',
  original: 'In order to',
  replacement: 'To',
  before: '',
  category: 'clarity',
  severity: 'suggestion',
  kind: 'wordy_phrase',
  reason: 'This opening is longer than it needs to be.',
});
const NOTE = issue({
  id: 'note',
  original: 'really good',
  replacement: null,
  before: 'The trip was',
  category: 'engagement',
  severity: 'suggestion',
  kind: 'vague_word',
  reason: 'A sharper word carries more.',
});
const CHAIR = issue({ id: 'chair', original: 'chairman', replacement: 'chair', before: 'Ask the', category: 'delivery', severity: 'suggestion', kind: 'inclusive_language', reason: 'Inclusive.' });
const GENERIC = issue({ id: 'generic', original: 'In today’s world', replacement: 'Now', before: '', category: 'delivery', severity: 'suggestion', kind: 'generic_phrasing', reason: 'A stock opener.' });

function tabState(issues: LocatedIssue[] | null, status: TabState['status'] = 'ok'): TabState {
  return {
    host: 'example.com',
    mode: 'standard',
    status,
    activeFieldId: issues ? 'f-1' : null,
    fields: issues ? { 'f-1': issues } : {},
    frames: issues ? { 'f-1': 3 } : {},
    pageId: 'p-1',
  };
}

async function renderPanel(issues: LocatedIssue[] | null, status: TabState['status'] = 'ok') {
  if (issues) await storage.setItem('session:tab:7', tabState(issues, status));
  else await storage.removeItem('session:tab:7');
  window.history.replaceState(null, '', '/sidepanel.html?tabId=7');
  render(<App />);
  // The tab state has arrived once Check everything is on.
  if (issues) await waitFor(() => expect(within(pane()).getByRole<HTMLButtonElement>('button', { name: 'Check everything' }).disabled).toBe(false));
}

const pane = () => document.getElementById('pane-issues')!;
const card = (id: string) => within(pane()).getAllByRole('listitem').find((li) => li.dataset.issue === id)!;

beforeEach(() => {
  fakeBrowser.reset();
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string) => {
    if (name === 'keyStatus') return { saved: true, last4: 'abcd' };
    if (name === 'applyFix') return { ok: true };
    if (name === 'rewriteSentence') return { opened: true };
    if (name === 'acceptAllErrors') return { failed: 0 };
    return undefined;
  }) as never);
});
afterEach(cleanup);

describe('an issue card in the side panel', () => {
  it('shows the type label, the change in its context, the reason, and Accept, Dismiss and Show in text', async () => {
    await renderPanel([HAS]);
    const li = card('has');
    expect(li.querySelector('.el-type-text')!.textContent).toBe('Correctness · Fix subject-verb agreement');
    expect(li.querySelector('.el-diff')!.textContent).toBe('Last week I hashave');
    expect(li.querySelector('.el-diff del')!.textContent).toBe('has');
    expect(li.querySelector('.el-diff ins')!.textContent).toBe('have');
    expect(within(li).getByText('Use "have" with "I".')).toBeTruthy();
    const buttons = within(li).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Accept', 'Dismiss', 'Show in text']);
    // Each button says which change it is about.
    for (const b of buttons) expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toBe("Replace 'has' with 'have'");
  });

  it('Accept applies the fix, Dismiss dismisses it and Show in text jumps to it, each in the field’s frame', async () => {
    await renderPanel([HAS]);
    const li = card('has');
    const target = { tabId: 7, frameId: 3 };
    await act(async () => fireEvent.click(within(li).getByRole('button', { name: 'Accept' })));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('applyFix', { fieldId: 'f-1', issueId: 'has' }, target);
    await act(async () => fireEvent.click(within(li).getByRole('button', { name: 'Dismiss' })));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('dismissIssue', { fieldId: 'f-1', issueId: 'has' }, target);
    vi.mocked(sendMessage).mockClear();
    await act(async () => fireEvent.click(within(li).getByRole('button', { name: 'Show in text' })));
    expect(vi.mocked(sendMessage).mock.calls).toEqual([['jumpTo', { fieldId: 'f-1', issueId: 'has' }, target]]); // once: the card's own jump doesn't add one
  });

  it('a comment-only note has "Rewrite sentence" in place of Accept, and marks its words without striking them', async () => {
    await renderPanel([NOTE]);
    const li = card('note');
    expect(li.querySelector('.el-type-text')!.textContent).toBe('Engagement · Use a sharper word');
    expect(li.querySelector('.el-diff mark')!.textContent).toBe('really good');
    expect(li.querySelector('.el-diff del, .el-diff ins')).toBeNull();
    expect(within(li).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Rewrite sentence', 'Dismiss', 'Show in text']);
    await act(async () => fireEvent.click(within(li).getByRole('button', { name: 'Rewrite sentence' })));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('rewriteSentence', { fieldId: 'f-1', issueId: 'note' }, { tabId: 7, frameId: 3 });
  });

  it('a deletion strikes the words and inserts nothing', async () => {
    await renderPanel([issue({ id: 'del', original: 'very', replacement: '', before: 'It was', category: 'clarity', severity: 'suggestion', kind: 'redundancy', reason: 'Not needed.' })]);
    const li = card('del');
    expect(li.querySelector('.el-diff del')!.textContent).toBe('very');
    expect(li.querySelector('.el-diff ins')).toBeNull();
    expect(document.getElementById(within(li).getByRole('button', { name: 'Accept' }).getAttribute('aria-describedby')!)!.textContent).toBe("Delete 'very'");
  });
});

describe('the Issues list', () => {
  it('groups the issues under Correctness, Clarity, Engagement, Delivery and Generic phrasing, as the cards name them, each heading with a family dot and its count', async () => {
    await renderPanel([WORDY, HAS, NOTE, SPELL, GENERIC, CHAIR]);
    const sections = within(pane()).getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['Correctness (2)', 'Clarity (1)', 'Engagement (1)', 'Delivery (1)', 'Generic phrasing (1)']);
    const heads = sections.map((s) => s.querySelector('h2')!);
    expect(heads.map((h) => h.querySelector('.panel-group-name')!.textContent)).toEqual(['Correctness', 'Clarity', 'Engagement', 'Delivery', 'Generic phrasing']);
    expect(heads.map((h) => h.querySelector('.panel-count')!.textContent)).toEqual(['2', '1', '1', '1', '1']);
    expect(heads.map((h) => h.querySelector('.el-dot')!.className)).toEqual([
      'el-dot el-fam-correctness',
      'el-dot el-fam-clarity',
      'el-dot el-fam-engagement',
      'el-dot el-fam-delivery',
      'el-dot el-fam-generic',
    ]);
    expect(within(sections[0]!).getAllByRole('listitem').map((li) => li.dataset.issue)).toEqual(['has', 'spell']);
    expect(within(sections[3]!).getAllByRole('listitem').map((li) => li.dataset.issue)).toEqual(['chair']);
    expect(within(sections[4]!).getAllByRole('listitem').map((li) => li.dataset.issue)).toEqual(['generic']);
    expect(within(sections[4]!).getByRole('listitem').querySelector('.el-type-text')!.textContent).toMatch(/^Generic phrasing · /);
  });

  it('Accept all errors carries the count and is off with no errors', async () => {
    await renderPanel([HAS, SPELL, WORDY]);
    const button = within(pane()).getByRole<HTMLButtonElement>('button', { name: /^Accept all errors/ });
    expect(button.textContent).toBe('Accept all errors 2');
    expect(button.disabled).toBe(false);
    await act(async () => fireEvent.click(button));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('acceptAllErrors', { fieldId: 'f-1' }, { tabId: 7, frameId: 3 });
    cleanup();
    await renderPanel([WORDY]);
    const none = within(pane()).getByRole<HTMLButtonElement>('button', { name: /^Accept all errors/ });
    expect(none.textContent).toBe('Accept all errors');
    expect(none.disabled).toBe(true);
  });

  it('says "Nothing to fix here." when the text box has no issues, and asks for a text box when there is none', async () => {
    await renderPanel([]);
    expect(within(pane()).getByText('Nothing to fix here.')).toBeTruthy();
    expect(pane().querySelector('.panel-empty svg')).not.toBeNull();
    expect(within(pane()).queryByRole('region')).toBeNull();
    cleanup();
    await renderPanel(null);
    await waitFor(() => expect(within(pane()).getByText('Click into a text box to start checking.')).toBeTruthy());
    expect(within(pane()).queryByText('Nothing to fix here.')).toBeNull();
  });
});

describe('the side panel header', () => {
  const pill = () => document.querySelector('.panel-pill');

  it('says "Up to date" while the page checks without trouble, and "Ready" before any text box reports', async () => {
    await renderPanel([HAS]);
    expect(pill()!.textContent).toBe('Up to date');
    expect(within(document.querySelector('header')!).getByRole('heading', { level: 1 }).textContent).toBe('EngLint');
    cleanup();
    await renderPanel(null);
    await waitFor(() => expect(pill()!.textContent).toBe('Ready'));
  });

  it('says "Paused at your limit" once the month’s spend reaches the cap, and names a setup problem', async () => {
    await spendItem.setValue({ [monthKey(new Date())]: 25 });
    await renderPanel([HAS]);
    await waitFor(() => expect(pill()!.textContent).toBe('Paused at your limit'));
    cleanup();
    await spendItem.setValue({});
    await renderPanel([HAS], 'key_invalid');
    await waitFor(() => expect(pill()!.textContent).toBe('Needs setup'));
  });
});

describe('the side panel footer', () => {
  const footer = () => document.querySelector('footer')!;

  it('shows the month’s spend as text and as a thin bar filled to its share of the limit', async () => {
    await capUsdItem.setValue(100);
    await spendItem.setValue({ [monthKey(new Date())]: 25 });
    await renderPanel([HAS]);
    await waitFor(() => expect(footer().textContent).toBe('$25.00 of $100 this month'));
    const fill = footer().querySelector<HTMLElement>('.panel-spend-fill')!;
    expect(fill.style.width).toBe('25%');
    expect(footer().querySelector('.panel-spend')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('fills the bar no further than the limit, and shows no bar when spending isn’t tracked', async () => {
    await capUsdItem.setValue(10);
    await spendItem.setValue({ [monthKey(new Date())]: 12 });
    await renderPanel([HAS]);
    await waitFor(() => expect(footer().querySelector<HTMLElement>('.panel-spend-fill')?.style.width).toBe('100%'));
    cleanup();
    await providerItem.setValue({
      active: 'compatible',
      compatible: { preset: 'openai', baseURL: 'https://api.openai.com/v1', fastModel: 'gpt-a', smartModel: 'gpt-b', structuredOutputs: true, prices: {} },
    });
    await renderPanel([HAS]);
    await waitFor(() => expect(footer().textContent).toBe('Spending not tracked'));
    expect(footer().querySelector('.panel-spend')).toBeNull();
  });
});

describe('contextBefore', () => {
  it('joins the words before a change to it with a space', () => {
    expect(contextBefore('Last week I', 'has')).toBe('Last week I ');
  });
  it('is empty at the start of a paragraph', () => {
    expect(contextBefore('', 'In order to')).toBe('');
  });
  it('marks five words (as many as are kept) as cut from a longer sentence', () => {
    expect(contextBefore('we all knew that last', 'week')).toBe('…we all knew that last ');
  });
  it('adds no space before punctuation, or after an opening quote or bracket', () => {
    expect(contextBefore('I like cats', ',')).toBe('I like cats');
    expect(contextBefore('She said “', 'hello')).toBe('She said “');
    expect(contextBefore('the results (', 'which')).toBe('the results (');
  });
});
