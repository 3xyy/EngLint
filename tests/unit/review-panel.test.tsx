import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../../src/entrypoints/sidepanel/App';
import { Review } from '../../src/entrypoints/sidepanel/review/Review';
import { sendMessage } from '../../src/shared/messages';
import { citationStyleItem, providerItem } from '../../src/shared/settings';

// The side panel's Review tab against a fake content script (sendMessage answers fieldText).

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));
// Whether the API offers web search: true unless a test turns it off; null follows the real rule.
const provider = vi.hoisted(() => ({ webSearch: true as boolean | null }));
vi.mock('../../src/core/provider', async (original) => {
  const real = await original<typeof import('../../src/core/provider')>();
  return { ...real, supportsWebSearch: (c: Parameters<typeof real.supportsWebSearch>[0]) => provider.webSearch ?? real.supportsWebSearch(c) };
});

// 40 words in 4 sentences of 10 (the Flesch score needs 30 or more).
const DOC = [
  'We go to the old market and buy some bread.',
  'The baker makes a loaf that smells like warm honey.',
  'I think this town is a good place to live.',
  'My mother says that the river runs very cold here.',
].join(' ');
const COUNTS = { errors: 2, clarity: 3, engagement: 1, delivery: 4 };

let docText = DOC;

beforeEach(() => {
  fakeBrowser.reset();
  docText = DOC;
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string) => {
    if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'standard' };
    throw new Error(`unexpected ${name}`);
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderReview(props: Partial<Parameters<typeof Review>[0]> = {}) {
  return render(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} {...props} />);
}

const reads = () => vi.mocked(sendMessage).mock.calls.filter(([name]) => name === 'fieldText').length;
const stat = (label: string) =>
  within(document.querySelector<HTMLElement>('section.review')!).getByText(label).closest('.stat')!.querySelector('dd')!.textContent;

describe('the Review tab Overview', () => {
  it('shows the stats of the field text, read from its frame, and the four open counts', async () => {
    renderReview();
    await waitFor(() => expect(stat('Words')).toBe('40'));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('fieldText', { fieldId: 'f-1' }, { tabId: 7, frameId: 3 });
    expect(stat('Characters')).toBe(String(DOC.length));
    expect(stat('Sentences')).toBe('4');
    expect(stat('Reading time')).toBe('10 sec');
    expect(stat('Speaking time')).toBe('13 sec');
    expect(stat('Avg. sentence')).toBe('10 words');
    expect(stat('Readability')).toMatch(/^\d+ · /);
    expect(stat('Unique words')).toMatch(/%$/);
    expect(stat('Long words')).toMatch(/%$/);
    expect(stat('Errors')).toBe('2');
    expect(stat('Clarity')).toBe('3');
    expect(stat('Engagement')).toBe('1');
    expect(stat('Delivery')).toBe('4');
  });

  it('shows no readability score for a short text', async () => {
    docText = 'Just a few words.';
    renderReview();
    await waitFor(() => expect(stat('Words')).toBe('4'));
    expect(stat('Readability')).toBe('Needs 30 words');
  });

  it('reads again every 3 seconds while shown, and not at all while hidden', async () => {
    vi.useFakeTimers();
    renderReview();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reads()).toBe(1);
    docText = DOC + ' One more sentence here.';
    await act(() => vi.advanceTimersByTimeAsync(2999));
    expect(reads()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(reads()).toBe(2);
    expect(stat('Words')).toBe('44');
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(reads()).toBe(3);
  });

  it('does not read while hidden, and reads once when it is shown', async () => {
    vi.useFakeTimers();
    const view = renderReview({ shown: false });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(reads()).toBe(0);
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reads()).toBe(1);
  });

  it('stops reading when the document is hidden, and catches up when it shows again', async () => {
    vi.useFakeTimers();
    let state: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    renderReview();
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(reads()).toBe(1); // the read when shown
    state = 'visible';
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(reads()).toBe(2);
    vi.restoreAllMocks();
  });

  it('reads again when the document becomes visible', async () => {
    vi.useFakeTimers();
    let state: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    renderReview();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reads()).toBe(1);
    state = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(reads()).toBe(2);
    vi.restoreAllMocks();
  });

  it('reads the new field when the field changes', async () => {
    const view = renderReview();
    await waitFor(() => expect(reads()).toBe(1));
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(reads()).toBe(2));
    expect(vi.mocked(sendMessage)).toHaveBeenLastCalledWith('fieldText', { fieldId: 'f-2' }, { tabId: 7, frameId: 3 });
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={5} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(reads()).toBe(3));
    expect(vi.mocked(sendMessage)).toHaveBeenLastCalledWith('fieldText', { fieldId: 'f-2' }, { tabId: 7, frameId: 5 });
  });

  it('shows only the new field when a slow read of the old field answers late', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(sendMessage).mockReset();
    vi.mocked(sendMessage).mockImplementation((async (_name: string, data: { fieldId: string }) => {
      if (data.fieldId === 'f-1') return new Promise((r) => (release = r));
      return { ok: true, text: 'Just a few words.', focus: null, mode: 'standard' };
    }) as never);
    const view = renderReview();
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(stat('Words')).toBe('4'));
    await act(async () => release({ ok: true, text: DOC, focus: null, mode: 'standard' }));
    expect(stat('Words')).toBe('4');
  });

  it('stops polling the old field when the field changes: one read per tick for the new one', async () => {
    vi.useFakeTimers();
    const view = renderReview();
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    vi.mocked(sendMessage).mockClear();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(reads()).toBe(2);
    expect(vi.mocked(sendMessage).mock.calls.every(([, data]) => (data as { fieldId: string }).fieldId === 'f-2')).toBe(true);
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers();
    const view = renderReview();
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.unmount();
    vi.mocked(sendMessage).mockClear();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(reads()).toBe(0);
  });

  it('keeps the last stats on screen while the tab is hidden and shown again', async () => {
    const view = renderReview();
    await waitFor(() => expect(stat('Words')).toBe('40'));
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown={false} spend={null} counts={COUNTS} />);
    expect(stat('Words')).toBe('40');
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    expect(stat('Words')).toBe('40');
  });

  it('asks for a text box when there is no field', () => {
    renderReview({ fieldId: null });
    expect(screen.getByText('Click into a text box or document first.')).toBeTruthy();
    expect(reads()).toBe(0);
  });

  it('says so when the field cannot be reached', async () => {
    vi.mocked(sendMessage).mockImplementation((async () => {
      throw new Error('gone');
    }) as never);
    renderReview();
    await waitFor(() => expect(screen.getByText("Couldn't reach that text box. Click into it and try again.")).toBeTruthy());
  });

  it('says it reviews the first 30,000 characters of a longer text, and nothing for a shorter one', async () => {
    docText = 'word '.repeat(7000);
    const view = renderReview();
    await waitFor(() => expect(screen.getByText('Reviewing the first 30,000 characters.')).toBeTruthy());
    view.unmount();
    docText = DOC;
    renderReview();
    await waitFor(() => expect(stat('Words')).toBe('40'));
    expect(screen.queryByText('Reviewing the first 30,000 characters.')).toBeNull();
  });
});

describe('the panel tab bar', () => {
  it('hands Review the open counts of the followed field, and reads its text only while Review is shown', async () => {
    const issue = (id: string, severity: 'error' | 'suggestion', category: string, kind: string) => ({
      id,
      original: 'x',
      replacement: 'y',
      before: '',
      category,
      severity,
      kind,
      reason: '',
      model: { original: 'x', replacement: 'y' },
      paragraphHash: 'h',
      start: 0,
      end: 1,
    });
    await fakeBrowser.storage.session.set({
      'tab:7': {
        host: 'example.com',
        mode: 'standard',
        status: 'ok',
        activeFieldId: 'f-1',
        frames: { 'f-1': 3 },
        fields: {
          'f-1': [issue('a', 'error', 'grammar', 'subject_verb_agreement'), issue('b', 'error', 'grammar', 'subject_verb_agreement'), issue('c', 'suggestion', 'clarity', 'wordy_phrase')],
        },
      },
    });
    window.history.replaceState(null, '', '/sidepanel.html?tabId=7');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Errors (2)')).toBeTruthy());
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(reads()).toBe(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    await waitFor(() => expect(stat('Words')).toBe('40'));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('fieldText', { fieldId: 'f-1' }, { tabId: 7, frameId: 3 });
    expect(stat('Errors')).toBe('2');
    expect(stat('Clarity')).toBe('1');
  });

  it('keys Review results on the page id of the tab state: a new page shows none', async () => {
    const state = (pageId: string) => ({ host: 'docs.google.com', mode: 'standard', status: 'ok', activeFieldId: 'gdocs', frames: { gdocs: 0 }, fields: { gdocs: [] }, pageId });
    await fakeBrowser.storage.session.set({ 'tab:7': state('p-1') });
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'standard' };
      if (name === 'reviewReaders') {
        return { status: 'ok', reaction: { firstImpression: 'Reads well.', remember: [], questions: [], lost: [], strength: { quote: '', why: 'Clear.' } } };
      }
      throw new Error(`unexpected ${name}`);
    }) as never);
    window.history.replaceState(null, '', '/sidepanel.html?tabId=7');
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    await waitFor(() => expect(stat('Words')).toBe('40'));
    fireEvent.click(screen.getByRole('button', { name: /Get reactions/ }));
    await waitFor(() => expect(screen.getByText('Reads well.')).toBeTruthy());
    await act(() => fakeBrowser.storage.session.set({ 'tab:7': state('p-2') }));
    await waitFor(() => expect(screen.queryByText('Reads well.')).toBeNull());
  });

  it('has four tabs: Issues, Tools, Chat, Review; the Review tab shows its pane', async () => {
    window.history.replaceState(null, '', '/sidepanel.html?tabId=7');
    render(<App />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Issues', 'Tools', 'Chat', 'Review']);
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull(); // hidden
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByRole('region', { name: 'Review' })).toBeTruthy();
  });
});

describe('the cost labels off Claude', () => {
  const ready = () => waitFor(() => expect(stat('Words')).toBe('40'));
  const card = (name: string) => screen.getByRole('region', { name });
  const useOpenAI = (prices: Record<string, { input: number; output: number }>) =>
    providerItem.setValue({
      active: 'compatible',
      compatible: { preset: 'openai', baseURL: 'https://api.openai.com/v1', fastModel: 'gpt-a', smartModel: 'gpt-b', structuredOutputs: true, prices },
    });

  it('estimate with the writer\'s prices for the smart model, never Claude\'s', async () => {
    await useOpenAI({ 'gpt-b': { input: 100, output: 400 } });
    renderReview();
    await ready();
    expect(within(card('Reader reactions')).getByRole('button', { name: 'Get reactions · about $0.64' })).toBeTruthy();
    expect(within(card('Grader')).getByRole('button', { name: 'Grade against it · about $0.88' })).toBeTruthy();
    expect(within(card('Deep check')).getByRole('button', { name: 'Check the whole text · about $1.36' })).toBeTruthy();
    expect(screen.queryByText('Cost not known for this model.')).toBeNull();
  });

  it('say the cost is not known for a model with no prices, and show no figure', async () => {
    await useOpenAI({ 'gpt-a': { input: 0.15, output: 0.6 } }); // the fast model only: reviews run on the smart one
    renderReview();
    await ready();
    for (const [name, run] of [['Reader reactions', 'Get reactions'], ['Grader', 'Grade against it'], ['Deep check', 'Check the whole text']] as const) {
      expect(within(card(name)).getByRole('button', { name: run })).toBeTruthy();
      expect(within(card(name)).getByText('Cost not known for this model.')).toBeTruthy();
    }
    expect(document.querySelector('section.review')!.textContent).not.toMatch(/\$\d/);
  });

  it('follow a change of provider', async () => {
    await useOpenAI({});
    renderReview();
    await ready();
    expect(within(card('Reader reactions')).getByRole('button', { name: 'Get reactions' })).toBeTruthy();
    await act(() => providerItem.setValue({ active: 'anthropic', compatible: null }));
    await waitFor(() => expect(within(card('Reader reactions')).getByRole('button', { name: 'Get reactions · about $0.02' })).toBeTruthy());
    expect(screen.queryByText('Cost not known for this model.')).toBeNull();
  });
});

describe('the Review tab before the provider settings are read', () => {
  it('shows no card until they are, so the Citation finder never flashes up off Claude', async () => {
    provider.webSearch = null; // the real rule: web search only on Claude
    await providerItem.setValue({
      active: 'compatible',
      compatible: { preset: 'groq', baseURL: 'https://api.groq.com/openai/v1', fastModel: 'm', smartModel: 'm', structuredOutputs: false, prices: {} },
    });
    // The settings arrive well after the field's text.
    const read = providerItem.getValue.bind(providerItem);
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(providerItem, 'getValue').mockImplementation(async () => {
      await late;
      return read();
    });
    try {
      renderReview();
      await waitFor(() => expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('fieldText', { fieldId: 'f-1' }, { tabId: 7, frameId: 3 }));
      await act(async () => {});
      expect(screen.queryByRole('region', { name: 'Citation finder' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Deep check' })).toBeNull();
      release();
      expect(await screen.findByRole('region', { name: 'Deep check' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Citation finder' })).toBeNull();
    } finally {
      spy.mockRestore();
      provider.webSearch = true;
    }
  });
});

describe('the side panel\'s spending meter', () => {
  const compatible = (prices: Record<string, { input: number; output: number }>) =>
    providerItem.setValue({
      active: 'compatible',
      compatible: { preset: 'openai', baseURL: 'https://api.openai.com/v1', fastModel: 'gpt-a', smartModel: 'gpt-b', structuredOutputs: true, prices },
    });

  it('reads "Spending not tracked" when a model has no prices, and the meter otherwise', async () => {
    await compatible({ 'gpt-a': { input: 0.15, output: 0.6 } });
    window.history.replaceState(null, '', '/sidepanel.html?tabId=7');
    render(<App />);
    await waitFor(() => expect(document.querySelector('footer')?.textContent).toBe('Spending not tracked'));
    await act(() => compatible({ 'gpt-a': { input: 0.15, output: 0.6 }, 'gpt-b': { input: 2, output: 8 } }));
    await waitFor(() => expect(document.querySelector('footer')?.textContent).toBe('$0.00 of $25 this month'));
  });
});

describe('the tone line', () => {
  // 60 words (DOC has 40).
  const LONG = `${DOC} ${DOC.split(' ').slice(0, 20).join(' ')}`;
  let toneReply: unknown;
  const tones = () => vi.mocked(sendMessage).mock.calls.filter(([name]) => name === 'reviewTone');
  const toneLine = () => document.querySelector('.tone-line')?.textContent;
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    toneReply = { status: 'ok', tones: ['confident', 'warm'] };
    docText = LONG;
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'essay' };
      if (name === 'reviewTone') {
        if (toneReply instanceof Error) throw toneReply;
        return toneReply;
      }
      throw new Error(`unexpected ${name}`);
    }) as never);
  });

  it('asks once, 10 seconds after the text last changed, with the tab, text and mode', async () => {
    vi.useFakeTimers();
    renderReview();
    await tick(0);
    expect(toneLine()).toBe('Tone appears after you pause for a few seconds.');
    await tick(9999);
    expect(tones()).toHaveLength(0);
    await tick(1);
    expect(tones()).toHaveLength(1);
    expect(tones()[0]![1]).toEqual({ tabId: 7, text: LONG, mode: 'essay' });
    expect(toneLine()).toBe('Tone: confident, warm');
  });

  it('restarts the 10 seconds when the text changes', async () => {
    vi.useFakeTimers();
    renderReview();
    await tick(0);
    await tick(5000);
    docText = `${LONG} More words now.`;
    await tick(1000); // the read at 6 s sees the change, so the wait ends at 16 s
    await tick(0);
    await tick(9999);
    expect(tones()).toHaveLength(0);
    await tick(1);
    expect(tones()).toHaveLength(1);
    expect(tones()[0]![1]).toMatchObject({ text: docText });
  });

  it('does not ask for the same text twice', async () => {
    vi.useFakeTimers();
    renderReview();
    await tick(0);
    await tick(30_000);
    expect(tones()).toHaveLength(1);
  });

  it('asks nothing while the tab is hidden, and starts the wait when it is shown', async () => {
    vi.useFakeTimers();
    const view = renderReview({ shown: false });
    await tick(0);
    await tick(30_000);
    expect(tones()).toHaveLength(0);
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    await tick(0);
    await tick(9999);
    expect(tones()).toHaveLength(0);
    await tick(1);
    expect(tones()).toHaveLength(1);
  });

  it('asks at exactly 40 words', async () => {
    vi.useFakeTimers();
    docText = DOC;
    renderReview();
    await tick(0);
    await tick(10_000);
    expect(tones()).toHaveLength(1);
  });

  it('asks nothing when the tab is hidden before the wait ends', async () => {
    vi.useFakeTimers();
    const view = renderReview();
    await tick(0);
    await tick(5000);
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown={false} spend={null} counts={COUNTS} />);
    await tick(30_000);
    expect(tones()).toHaveLength(0);
  });

  it('does not ask again for the same text when the tab is hidden and shown after an answer', async () => {
    vi.useFakeTimers();
    const view = renderReview();
    await tick(0);
    await tick(10_000);
    expect(tones()).toHaveLength(1);
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown={false} spend={null} counts={COUNTS} />);
    await tick(0);
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    await tick(0);
    await tick(30_000);
    expect(tones()).toHaveLength(1);
  });

  it('reads an answer that is not ok, or has no tones, as unavailable', async () => {
    vi.useFakeTimers();
    toneReply = { status: 'paused_cap', tones: ['warm'] };
    const view = renderReview();
    await tick(0);
    await tick(10_000);
    expect(toneLine()).toBe('Tone unavailable right now.');
    view.unmount();
    toneReply = { status: 'ok', tones: [] };
    renderReview();
    await tick(0);
    await tick(10_000);
    expect(toneLine()).toBe('Tone unavailable right now.');
  });

  it('goes back to the waiting line when the text changes after an answer', async () => {
    vi.useFakeTimers();
    renderReview();
    await tick(0);
    await tick(10_000);
    expect(toneLine()).toBe('Tone: confident, warm');
    docText = `${LONG} More words now.`;
    await tick(3000);
    await tick(0);
    expect(toneLine()).toBe('Tone appears after you pause for a few seconds.');
    await tick(10_000);
    expect(toneLine()).toBe('Tone: confident, warm');
  });

  it('does not show a late answer for text that has since changed, but shows one for the current text', async () => {
    vi.useFakeTimers();
    const answers: ((v: unknown) => void)[] = [];
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'essay' };
      return new Promise((r) => answers.push(r));
    }) as never);
    renderReview();
    await tick(0);
    await tick(10_000);
    expect(answers).toHaveLength(1);
    docText = `${LONG} More words now.`;
    await tick(3000);
    await tick(0);
    await act(async () => answers[0]!({ status: 'ok', tones: ['old'] }));
    expect(toneLine()).toBe('Tone appears after you pause for a few seconds.');
    await tick(10_000);
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]!({ status: 'ok', tones: ['new'] }));
    expect(toneLine()).toBe('Tone: new');
  });

  it('keeps the answer for the current text when an older answer arrives after it', async () => {
    vi.useFakeTimers();
    const answers: ((v: unknown) => void)[] = [];
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'essay' };
      return new Promise((r) => answers.push(r));
    }) as never);
    renderReview();
    await tick(0);
    await tick(10_000);
    docText = `${LONG} More words now.`;
    await tick(3000);
    await tick(0);
    await tick(10_000);
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]!({ status: 'ok', tones: ['new'] }));
    await act(async () => answers[0]!({ status: 'ok', tones: ['old'] }));
    expect(toneLine()).toBe('Tone: new');
  });

  it('asks again when only the mode changes', async () => {
    vi.useFakeTimers();
    renderReview();
    await tick(0);
    await tick(10_000);
    expect(tones()).toHaveLength(1);
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'casual' };
      return toneReply;
    }) as never);
    await tick(3000);
    await tick(0);
    await tick(10_000);
    expect(tones()).toHaveLength(2);
    expect(tones()[1]![1]).toMatchObject({ mode: 'casual' });
  });

  it('asks nothing under 40 words, and says so', async () => {
    vi.useFakeTimers();
    docText = DOC.split(' ').slice(0, 39).join(' ');
    renderReview();
    await tick(0);
    await tick(30_000);
    expect(tones()).toHaveLength(0);
    expect(toneLine()).toBe('Tone needs at least 40 words.');
  });

  it('says it is unavailable when the answer fails or the request throws', async () => {
    vi.useFakeTimers();
    toneReply = { status: 'bad_response' };
    const view = renderReview();
    await tick(0);
    await tick(10_000);
    expect(toneLine()).toBe('Tone unavailable right now.');
    view.unmount();
    toneReply = new Error('gone');
    renderReview();
    await tick(0);
    await tick(10_000);
    expect(toneLine()).toBe('Tone unavailable right now.');
  });

  it('sends only the first 30,000 characters of a longer text', async () => {
    vi.useFakeTimers();
    docText = 'word '.repeat(7000);
    renderReview();
    await tick(0);
    await tick(10_000);
    expect((tones()[0]![1] as { text: string }).text.length).toBeLessThanOrEqual(30_000);
  });

  it('starts over for another field', async () => {
    vi.useFakeTimers();
    const view = renderReview();
    await tick(0);
    await tick(10_000);
    expect(toneLine()).toBe('Tone: confident, warm');
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await tick(0);
    expect(toneLine()).toBe('Tone appears after you pause for a few seconds.');
    await tick(10_000);
    expect(tones()).toHaveLength(2);
  });
});

describe('Reader reactions', () => {
  const REACTION = {
    firstImpression: 'A warm, grounded opening.',
    remember: ['The honey loaf'],
    questions: ['Why does the river matter?'],
    lost: [
      { quote: 'the old market', why: 'It lingers.' },
      { quote: 'a dragon in the sky', why: 'Not in the text.' },
    ],
    strength: { quote: 'warm honey', why: 'Concrete and sensory.' },
  };
  let docMode: string;
  let readersReply: unknown;
  let revealReply: unknown;
  const calls = (name: string) => vi.mocked(sendMessage).mock.calls.filter(([n]) => n === name);
  const card = () => screen.getByRole('region', { name: 'Reader reactions' });

  beforeEach(() => {
    docMode = 'standard';
    readersReply = { status: 'ok', reaction: REACTION };
    revealReply = { found: true };
    vi.mocked(sendMessage).mockImplementation((async (name: string, data: { fieldId?: string }) => {
      if (name === 'fieldText') return { ok: true, text: data.fieldId === 'f-2' ? 'Another field entirely, with a few words.' : docText, focus: null, mode: docMode };
      if (name === 'reviewReaders') return readersReply instanceof Error ? Promise.reject(readersReply) : readersReply;
      if (name === 'revealText') return revealReply;
      throw new Error(`unexpected ${name}`);
    }) as never);
  });

  const ready = () => waitFor(() => expect(stat('Words')).toBe('40'));

  it('defaults the reader to General reader, and to Admissions officer in an essay', async () => {
    const view = renderReview();
    await ready();
    expect((within(card()).getByLabelText('Reader') as HTMLSelectElement).value).toBe('general');
    view.unmount();
    docMode = 'essay';
    renderReview();
    await waitFor(() => expect((within(card()).getByLabelText('Reader') as HTMLSelectElement).value).toBe('admissions'));
  });

  it('offers the five readers, and shows an input only for Custom', async () => {
    renderReview();
    await ready();
    const select = within(card()).getByLabelText('Reader') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Admissions officer', 'Teacher', 'Recruiter', 'General reader', 'Custom…']);
    expect(within(card()).queryByPlaceholderText('Describe the reader (e.g. an expert in marine biology)')).toBeNull();
    fireEvent.change(select, { target: { value: 'custom' } });
    expect(within(card()).getByPlaceholderText('Describe the reader (e.g. an expert in marine biology)')).toBeTruthy();
  });

  it('labels the run button with the cost from the text length', async () => {
    const view = renderReview();
    await ready();
    expect(within(card()).getByRole('button', { name: 'Get reactions · about $0.02' })).toBeTruthy();
    view.unmount();
    docText = 'word '.repeat(5000);
    renderReview();
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Get reactions · about $0.03' })).toBeTruthy());
  });

  it('sends the tab, the text as cut, the mode and the reader, and renders the five headings', async () => {
    docMode = 'essay';
    renderReview();
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    await waitFor(() => expect(within(card()).getByText('First impression')).toBeTruthy());
    expect(calls('reviewReaders')[0]![1]).toEqual({ tabId: 7, text: DOC, mode: 'essay', reader: 'admissions' });
    for (const h of ['First impression', 'What they\'ll remember', 'Questions they\'d ask', 'Where they got lost or bored', 'One strength to keep']) {
      expect(within(card()).getByRole('heading', { name: h })).toBeTruthy();
    }
    expect(within(card()).getByText('A warm, grounded opening.')).toBeTruthy();
    expect(within(card()).getByText('The honey loaf')).toBeTruthy();
    expect(within(card()).getByText('Why does the river matter?')).toBeTruthy();
    expect(within(card()).getByText('Concrete and sensory.')).toBeTruthy();
  });

  it('sends a custom reader description with the request, and needs one', async () => {
    renderReview();
    await ready();
    fireEvent.change(within(card()).getByLabelText('Reader'), { target: { value: 'custom' } });
    const run = within(card()).getByRole('button', { name: /Get reactions/ }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(within(card()).getByPlaceholderText(/Describe the reader/), { target: { value: 'a marine biologist' } });
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect(calls('reviewReaders')).toHaveLength(1));
    expect(calls('reviewReaders')[0]![1]).toMatchObject({ reader: 'custom', custom: 'a marine biologist' });
  });

  it('makes a quote found in the text a button that reveals it, and leaves an absent quote as plain text', async () => {
    renderReview();
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    const jump = await within(card()).findByRole('button', { name: /the old market/ });
    expect(within(card()).queryByRole('button', { name: /dragon/ })).toBeNull();
    expect(within(card()).getByText('a dragon in the sky')).toBeTruthy();
    fireEvent.click(jump);
    await waitFor(() => expect(calls('revealText')).toHaveLength(1));
    expect(calls('revealText')[0]).toEqual(['revealText', { fieldId: 'f-1', quote: 'the old market' }, { tabId: 7, frameId: 3 }]);
    expect(within(card()).queryByText('That passage has changed since the review.')).toBeNull();
  });

  it('matches quotes against the text the reaction read, not the text on screen now', async () => {
    vi.useFakeTimers();
    renderReview();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(card()).getByRole('button', { name: /the old market/ })).toBeTruthy();
    docText = 'Completely different words now, nothing like before.';
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(stat('Words')).toBe('7');
    expect(within(card()).getByRole('button', { name: /the old market/ })).toBeTruthy();
  });

  it('sends only the first 30,000 characters of a longer text', async () => {
    docText = 'word '.repeat(7000);
    renderReview();
    await waitFor(() => expect(stat('Words')).toBe('7000'));
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    await waitFor(() => expect(calls('reviewReaders')).toHaveLength(1));
    expect((calls('reviewReaders')[0]![1] as { text: string }).text).toBe('word '.repeat(6000));
  });

  it('shows the reason alone when the strength has no quote', async () => {
    readersReply = { status: 'ok', reaction: { ...REACTION, strength: { quote: '', why: 'Concrete and sensory.' } } };
    renderReview();
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    await waitFor(() => expect(within(card()).getByText('Concrete and sensory.')).toBeTruthy());
    expect(card().querySelectorAll('q')).toHaveLength(2); // the two lost quotes only
  });

  describe('results belong to a tab, page, frame and field', () => {
    const at = (over: Record<string, unknown>) => (
      <Review tabId={7} pageId="p-1" fieldId="gdocs" frameId={0} shown spend={null} counts={COUNTS} {...over} />
    );
    const runFirst = async () => {
      const view = render(at({}));
      await ready();
      fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
      await waitFor(() => expect(within(card()).getByText('A warm, grounded opening.')).toBeTruthy());
      return view;
    };

    it('does not show a result under another tab with the same field id', async () => {
      const view = await runFirst();
      view.rerender(at({ tabId: 8 }));
      await ready();
      expect(within(card()).queryByText('A warm, grounded opening.')).toBeNull();
      view.rerender(at({}));
      await waitFor(() => expect(within(card()).getByText('A warm, grounded opening.')).toBeTruthy());
    });

    it('does not show a result after the same tab loads a new page', async () => {
      const view = await runFirst();
      view.rerender(at({ pageId: 'p-2' }));
      await ready();
      expect(within(card()).queryByText('A warm, grounded opening.')).toBeNull();
    });

    it('does not show a result under another frame', async () => {
      const view = await runFirst();
      view.rerender(at({ frameId: 4 }));
      await ready();
      expect(within(card()).queryByText('A warm, grounded opening.')).toBeNull();
    });

    it('keeps a late answer under the key it was asked for', async () => {
      let release: (v: unknown) => void = () => {};
      vi.mocked(sendMessage).mockImplementation((async (name: string) => {
        if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'standard' };
        if (name === 'reviewReaders') return new Promise((r) => (release = r));
        throw new Error(`unexpected ${name}`);
      }) as never);
      const view = render(at({}));
      await ready();
      fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
      view.rerender(at({ pageId: 'p-2' }));
      await ready();
      await act(async () => release({ status: 'ok', reaction: REACTION }));
      expect(within(card()).queryByText('A warm, grounded opening.')).toBeNull();
      view.rerender(at({}));
      await waitFor(() => expect(within(card()).getByText('A warm, grounded opening.')).toBeTruthy());
    });
  });

  it('says the passage has changed when the field no longer has the quote', async () => {
    revealReply = { found: false };
    renderReview();
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    fireEvent.click(await within(card()).findByRole('button', { name: /warm honey/ }));
    await waitFor(() => expect(within(card()).getByText('That passage has changed since the review.')).toBeTruthy());
  });

  it('keeps the chosen reader and the custom description when the panel follows another field and comes back', async () => {
    const view = renderReview();
    await ready();
    fireEvent.change(within(card()).getByLabelText('Reader'), { target: { value: 'custom' } });
    fireEvent.change(within(card()).getByPlaceholderText(/Describe the reader/), { target: { value: 'a marine biologist' } });
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(stat('Words')).toBe('7'));
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    await ready();
    expect((within(card()).getByLabelText('Reader') as HTMLSelectElement).value).toBe('custom');
    expect((within(card()).getByPlaceholderText(/Describe the reader/) as HTMLInputElement).value).toBe('a marine biologist');
  });

  it('shows a status like paused_cap with the tool copy', async () => {
    readersReply = { status: 'paused_cap' };
    renderReview({ spend: { spent: 25, cap: 25 } });
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    await waitFor(() => expect(within(card()).getByRole('alert').textContent).toContain('Rewrites, synonyms, chat and reviews are paused'));
    expect(within(card()).getByRole('alert').textContent).toContain('$25.00 of $25');
  });

  it('reads a failed send as an unusable answer', async () => {
    readersReply = new Error('gone');
    renderReview();
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    await waitFor(() => expect(within(card()).getByRole('alert').textContent).toBe("Couldn't get a usable answer from Claude. Try again."));
  });

  it('keeps each field its own result: a run for one field never shows under another, and shows again on return', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(sendMessage).mockImplementation((async (name: string, data: { fieldId?: string }) => {
      if (name === 'fieldText') return { ok: true, text: data.fieldId === 'f-2' ? 'Another field entirely, with a few words.' : docText, focus: null, mode: 'standard' };
      if (name === 'reviewReaders') return new Promise((r) => (release = r));
      throw new Error(`unexpected ${name}`);
    }) as never);
    const view = renderReview();
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /Get reactions/ }));
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(stat('Words')).toBe('7'));
    await act(async () => release({ status: 'ok', reaction: REACTION }));
    expect(within(card()).queryByText('A warm, grounded opening.')).toBeNull();
    expect((within(card()).getByRole('button', { name: /Get reactions/ }) as HTMLButtonElement).disabled).toBe(false);
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(within(card()).getByText('A warm, grounded opening.')).toBeTruthy());
  });
});

describe('Grader', () => {
  const GRADING = {
    criteria: [
      { name: 'Voice', rating: 'strong', evidence: [{ quote: 'warm honey', note: 'Vivid.' }], raise: '' },
      { name: 'Structure', rating: 'needs_work', evidence: [], raise: 'Open with the river.' },
    ],
    grade: null as string | null,
  };
  let gradeReply: unknown;
  const calls = (name: string) => vi.mocked(sendMessage).mock.calls.filter(([n]) => n === name);
  const card = () => screen.getByRole('region', { name: 'Grader' });
  const ready = () => waitFor(() => expect(stat('Words')).toBe('40'));
  const run = async (rubric = 'A: great. B: fine.') => {
    fireEvent.change(within(card()).getByPlaceholderText('Paste the prompt or rubric'), { target: { value: rubric } });
    fireEvent.click(within(card()).getByRole('button', { name: /Grade against it/ }));
  };

  beforeEach(() => {
    gradeReply = { status: 'ok', grading: GRADING };
    vi.mocked(sendMessage).mockImplementation((async (name: string, data: { fieldId?: string }) => {
      if (name === 'fieldText') return { ok: true, text: data.fieldId === 'f-2' ? 'Another field entirely, with a few words.' : docText, focus: null, mode: 'standard' };
      if (name === 'reviewGrade') return gradeReply;
      if (name === 'revealText') return { found: true };
      throw new Error(`unexpected ${name}`);
    }) as never);
  });

  it('needs a rubric, and shows the cost from the text and the rubric', async () => {
    docText = 'word '.repeat(3520); // 17,600 characters: just under the $0.03 boundary
    renderReview();
    await waitFor(() => expect(stat('Words')).toBe('3520'));
    const button = within(card()).getByRole('button', { name: /Grade against it · / }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Grade against it · about $0.03');
    fireEvent.change(within(card()).getByPlaceholderText('Paste the prompt or rubric'), { target: { value: 'x'.repeat(2000) } });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Grade against it · about $0.04');
  });

  it('sends the text and rubric, and renders each criterion with its rating, evidence and what would raise it', async () => {
    renderReview();
    await ready();
    await run();
    await waitFor(() => expect(within(card()).getByText('Voice')).toBeTruthy());
    expect(calls('reviewGrade')[0]![1]).toEqual({ tabId: 7, text: DOC, mode: 'standard', rubric: 'A: great. B: fine.' });
    expect(within(card()).getByText('Strong')).toBeTruthy();
    expect(within(card()).getByText('Needs work')).toBeTruthy();
    expect(within(card()).getByText('Vivid.')).toBeTruthy();
    expect(within(card()).getAllByText('To raise it:')).toHaveLength(1); // only where there is something to say
    expect(within(card()).getByText('Open with the river.')).toBeTruthy();
    expect(within(card()).queryByText(/Grade \(from your rubric\)/)).toBeNull();
  });

  it('says only the first 6,000 characters of the rubric are used once it reaches that length', async () => {
    renderReview();
    await ready();
    const box = within(card()).getByPlaceholderText('Paste the prompt or rubric');
    fireEvent.change(box, { target: { value: 'x'.repeat(5999) } });
    expect(within(card()).queryByText('Only the first 6,000 characters of the rubric are used.')).toBeNull();
    fireEvent.change(box, { target: { value: 'x'.repeat(6000) } });
    expect(within(card()).getByText('Only the first 6,000 characters of the rubric are used.')).toBeTruthy();
  });

  it('sends the rubric without the spaces around it', async () => {
    renderReview();
    await ready();
    await run('  Be clear.\n ');
    await waitFor(() => expect(calls('reviewGrade')).toHaveLength(1));
    expect(calls('reviewGrade')[0]![1]).toMatchObject({ rubric: 'Be clear.' });
  });

  it('sends only the first 30,000 characters of a longer text', async () => {
    docText = 'word '.repeat(7000);
    renderReview();
    await waitFor(() => expect(stat('Words')).toBe('7000'));
    await run();
    await waitFor(() => expect(calls('reviewGrade')).toHaveLength(1));
    expect((calls('reviewGrade')[0]![1] as { text: string }).text).toBe('word '.repeat(6000));
  });

  it('keeps the pasted rubric when the panel follows another field and comes back', async () => {
    const view = renderReview();
    await ready();
    fireEvent.change(within(card()).getByPlaceholderText('Paste the prompt or rubric'), { target: { value: 'Be clear.' } });
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(stat('Words')).toBe('7'));
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    await ready();
    expect((within(card()).getByPlaceholderText('Paste the prompt or rubric') as HTMLTextAreaElement).value).toBe('Be clear.');
  });

  it('shows the grade only when the answer has one', async () => {
    gradeReply = { status: 'ok', grading: { ...GRADING, grade: 'B+' } };
    renderReview();
    await ready();
    await run();
    await waitFor(() => expect(within(card()).getByText('Grade (from your rubric): B+')).toBeTruthy());
  });

  it('shows a status with the tool copy', async () => {
    gradeReply = { status: 'key_missing' };
    renderReview();
    await ready();
    await run();
    await waitFor(() => expect(within(card()).getByRole('alert').textContent).toBe('Add your Claude API key to start checking.'));
  });

  it('jumps to an evidence quote that is in the text', async () => {
    renderReview();
    await ready();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: /warm honey/ }));
    await waitFor(() => expect(calls('revealText')).toHaveLength(1));
  });
});

describe('Deep check', () => {
  const at = (text: string, sub: string, n = 0) => {
    let i = -1;
    for (let k = 0; k <= n; k++) i = text.indexOf(sub, i + 1);
    return i;
  };
  const issue = (text: string, original: string, replacement: string | null, n = 0, over: Record<string, unknown> = {}) => {
    const start = at(text, original, n);
    return {
      original, replacement, before: '', kind: 'wordy_phrase', category: 'clarity', severity: 'suggestion', reason: 'Shorter.',
      model: { original, replacement }, id: `h:${start}:wordy_phrase`, paragraphHash: 'h', start, end: start + original.length, ...over,
    };
  };
  const NOTES = [
    { type: 'overused_word', text: 'You lean on "very".', quotes: ['very cold', 'a dragon in the sky'], count: 6 },
    { type: 'tense_shift', text: 'The tense slips.', quotes: [], count: null },
  ];
  let deepReply: unknown;
  let applyReply: unknown;
  let revealReply: unknown;
  const calls = (name: string) => vi.mocked(sendMessage).mock.calls.filter(([n]) => n === name);
  const card = () => screen.getByRole('region', { name: 'Deep check' });
  const ready = () => waitFor(() => expect(stat('Words')).toBe('40'));
  const reply = (issues: unknown[], notes: unknown[] = []) => ({ status: 'ok', issues, notes });
  const run = async () => {
    await ready();
    fireEvent.click(within(card()).getByRole('button', { name: /^Check the whole text/ }));
    await waitFor(() => expect(calls('deepCheck')).toHaveLength(1));
  };

  beforeEach(() => {
    deepReply = reply([issue(DOC, 'very cold', 'cold'), issue(DOC, 'warm honey', null)], NOTES);
    applyReply = { result: 'applied' };
    revealReply = { found: true };
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'standard' };
      if (name === 'deepCheck') return deepReply;
      if (name === 'applyEdit') return applyReply instanceof Error ? Promise.reject(applyReply) : applyReply;
      if (name === 'revealText') return revealReply;
      throw new Error(`unexpected ${name}`);
    }) as never);
  });

  afterEach(() => vi.unstubAllGlobals());

  const clipboard = (refuse = false) => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: async (t: string) => {
          if (refuse) throw new Error('no focus');
          copied.push(t);
        },
      },
    });
    return copied;
  };

  it('shows the cost on the button and sends the text to read, with the tab and the mode', async () => {
    renderReview();
    await ready();
    expect(within(card()).getByRole('button', { name: 'Check the whole text · about $0.04' })).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: /^Check the whole text/ }));
    await waitFor(() => expect(calls('deepCheck')).toHaveLength(1));
    expect(calls('deepCheck')[0]![1]).toEqual({ tabId: 7, text: DOC, mode: 'standard' });
  });

  it('lists the issues with their fixes and Go to, and the notes with counts and quotes', async () => {
    renderReview();
    await run();
    await within(card()).findByText('Issues (2)');
    expect(within(card()).getByText('About the whole text')).toBeTruthy();
    expect(within(card()).getAllByRole('button', { name: /^Go to/ })).toHaveLength(2);
    expect(within(card()).getByText('You lean on "very".')).toBeTruthy();
    expect(within(card()).getByText(/used 6 times/)).toBeTruthy();
    expect(within(card()).getByText('The tense slips.')).toBeTruthy();
    expect(within(card()).queryByText(/used null|times.*times/)).toBeNull();
    // A quote the text holds is a button; one it doesn't is plain text.
    expect(within(card()).getByRole('button', { name: /very cold/ })).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: /a dragon/ })).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: /very cold/ }));
    await waitFor(() => expect(calls('revealText')).toHaveLength(1));
    expect(calls('revealText')[0]![1]).toEqual({ fieldId: 'f-1', quote: 'very cold' });
  });

  it("shows no issue's reason: cards carry no explanations", async () => {
    renderReview();
    await run();
    await within(card()).findByText('Issues (2)');
    expect(within(card()).queryAllByText('Shorter.')).toHaveLength(0);
  });

  it('sends the text exactly as read, leading and trailing spaces included', async () => {
    docText = `  ${DOC}  `;
    renderReview();
    await screen.findByRole('region', { name: 'Deep check' });
    await waitFor(() => expect(stat('Words')).toBe('40'));
    fireEvent.click(within(card()).getByRole('button', { name: /^Check the whole text/ }));
    await waitFor(() => expect(calls('deepCheck')).toHaveLength(1));
    expect(calls('deepCheck')[0]![1]).toMatchObject({ text: `  ${DOC}  ` });
  });

  it('says "used 1 time" for a count of one', async () => {
    deepReply = reply([], [{ type: 'overused_word', text: 'Leaning on "so".', quotes: [], count: 1 }]);
    renderReview();
    await run();
    expect(await within(card()).findByText(/used 1 time$/)).toBeTruthy();
  });

  it('shows no "Nothing to flag." when only notes came back', async () => {
    deepReply = reply([], [{ type: 'tense_shift', text: 'The tense slips.', quotes: [], count: null }]);
    renderReview();
    await run();
    await within(card()).findByText('The tense slips.');
    expect(within(card()).queryByText('Nothing to flag.')).toBeNull();
    expect(within(card()).queryByText(/^Issues/)).toBeNull();
  });

  it('shows a comment-only issue as plain text, not as a change', async () => {
    renderReview();
    await run();
    const items = await within(card()).findAllByRole('listitem');
    const commentOnly = items.find((li) => li.textContent?.includes('warm honey'))!;
    expect(commentOnly.querySelector('ins, del')).toBeNull();
    expect(items.find((li) => li.textContent?.includes('very cold'))!.querySelector('del')).not.toBeNull();
  });

  it('disables Go to for a passage too short to find', async () => {
    docText = 'Ok. Then we go on from here to there.';
    deepReply = reply([issue(docText, 'Ok', 'OK')]);
    renderReview();
    await screen.findByRole('region', { name: 'Deep check' });
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    fireEvent.click(await within(card()).findByRole('button', { name: /^Check the whole text/ }));
    expect(((await within(card()).findByRole('button', { name: /^Go to/ })) as HTMLButtonElement).disabled).toBe(true);
  });

  it('waits for a fix being applied before it can run again', async () => {
    let release: (v: unknown) => void = () => {};
    applyReply = undefined;
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'standard' };
      if (name === 'deepCheck') return deepReply;
      if (name === 'applyEdit') return new Promise((r) => (release = r));
      throw new Error(`unexpected ${name}`);
    }) as never);
    renderReview();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: 'Apply fix 1' }));
    expect((within(card()).getByRole('button', { name: /^Check the whole text/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release({ result: 'applied' }));
    expect((within(card()).getByRole('button', { name: /^Check the whole text/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('works out the Go to windows once per result, not on every render', async () => {
    const view = renderReview();
    await run();
    await within(card()).findByText('Issues (2)');
    const quotes = await import('../../src/core/quotes');
    const spy = vi.spyOn(quotes, 'findQuote');
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={{ ...COUNTS, errors: 9 }} />);
    await within(card()).findByText('Issues (2)');
    const before = spy.mock.calls.length;
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={{ ...COUNTS, errors: 8 }} />);
    // Quote buttons in the notes still search; the Go to windows must not.
    expect(spy.mock.calls.length - before).toBeLessThanOrEqual(2);
    spy.mockRestore();
  });

  it('clears applied marks and notes when it runs again', async () => {
    deepReply = reply([issue(DOC, 'very cold', 'cold'), issue(DOC, 'warm honey', 'honey')]);
    renderReview();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: 'Apply fix 1' }));
    await within(card()).findByRole('button', { name: 'Fix 1 applied' });
    applyReply = { result: 'changed' };
    fireEvent.click(within(card()).getByRole('button', { name: 'Apply fix 2' }));
    await within(card()).findByText('The text changed. Run Deep check again.');
    fireEvent.click(within(card()).getByRole('button', { name: /^Check the whole text/ }));
    await waitFor(() => expect(calls('deepCheck')).toHaveLength(2));
    expect(await within(card()).findByRole('button', { name: 'Apply fix 1' })).toBeTruthy();
    expect(within(card()).queryByText('The text changed. Run Deep check again.')).toBeNull();
  });

  it("says it couldn't reach the text box when the edit can't be sent", async () => {
    applyReply = new Error('gone');
    renderReview();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: /^Apply/ }));
    expect(await within(card()).findByText("Couldn't reach that text box. Click into it and try again.")).toBeTruthy();
    expect((within(card()).getByRole('button', { name: /^Apply/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says "Nothing to flag." when both lists are empty', async () => {
    deepReply = reply([], []);
    renderReview();
    await run();
    expect(await within(card()).findByText('Nothing to flag.')).toBeTruthy();
    expect(within(card()).queryByText(/^Issues/)).toBeNull();
  });

  it('shows a comment-only issue with Go to alone, and a fix with Apply', async () => {
    renderReview();
    await run();
    await within(card()).findByText('Issues (2)');
    expect(within(card()).getAllByRole('button', { name: /^Apply/ })).toHaveLength(1);
  });

  it('Apply sends the unique edit, and marks the issue applied', async () => {
    const text = 'We know its edge and its shape. Over time its end shifted.';
    docText = text;
    deepReply = reply([issue(text, 'its', "it's", 0)]);
    renderReview();
    await screen.findByRole('region', { name: 'Deep check' });
    fireEvent.click(await within(card()).findByRole('button', { name: /^Check the whole text/ }));
    fireEvent.click(await within(card()).findByRole('button', { name: /^Apply/ }));
    await waitFor(() => expect(calls('applyEdit')).toHaveLength(1));
    expect(calls('applyEdit')[0]![1]).toEqual({ fieldId: 'f-1', original: 'know its', replacement: "know it's" });
    expect(calls('applyEdit')[0]![2]).toEqual({ tabId: 7, frameId: 3 });
    const done = await within(card()).findByRole('button', { name: 'Fix 1 applied' });
    expect((done as HTMLButtonElement).disabled).toBe(true);
  });

  it('Go to jumps by the issue text, or by the unique window when the text repeats', async () => {
    const text = 'We know its edge and its shape. Over time its end shifted.';
    docText = text;
    deepReply = reply([issue(text, 'its', "it's", 0), issue(text, 'its', "it's", 1)]);
    renderReview();
    await screen.findByRole('region', { name: 'Deep check' });
    fireEvent.click(await within(card()).findByRole('button', { name: /^Check the whole text/ }));
    const gos = await within(card()).findAllByRole('button', { name: /^Go to/ });
    fireEvent.click(gos[1]!);
    await waitFor(() => expect(calls('revealText')).toHaveLength(1));
    expect(calls('revealText')[0]![1]).toEqual({ fieldId: 'f-1', quote: 'and its' });
    fireEvent.click(gos[0]!);
    await waitFor(() => expect(calls('revealText')).toHaveLength(2));
    expect(calls('revealText')[1]![1]).toEqual({ fieldId: 'f-1', quote: 'its' });
  });

  it('says "The text changed. Run Deep check again." when the text has changed', async () => {
    applyReply = { result: 'changed' };
    renderReview();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: /^Apply/ }));
    expect(await within(card()).findByText('The text changed. Run Deep check again.')).toBeTruthy();
  });

  it.each(['ambiguous', 'failed', 'blocked'])('copies the fix and says so when the edit comes back %s', async (result) => {
    const copied = clipboard();
    applyReply = { result };
    renderReview();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: /^Apply/ }));
    expect(await within(card()).findByText("Couldn't apply here — copied to clipboard.")).toBeTruthy();
    expect(copied).toEqual(['cold']);
  });

  it("says it couldn't apply when the clipboard refuses too", async () => {
    clipboard(true);
    applyReply = { result: 'failed' };
    renderReview();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: /^Apply/ }));
    expect(await within(card()).findByText("Couldn't apply here.")).toBeTruthy();
  });

  it('shows the Essay too-big copy for too_big', async () => {
    applyReply = { result: 'too_big' };
    renderReview();
    await run();
    fireEvent.click(await within(card()).findByRole('button', { name: /^Apply/ }));
    expect(await within(card()).findByText('Too big a change to suggest for an essay — try revising it yourself.')).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: /^Apply/ })).toBeNull();
  });

  it('copies the fix when no unique window exists', async () => {
    const copied = clipboard();
    const text = `${'its '.repeat(200)}end`;
    docText = text;
    deepReply = reply([issue(text, 'its', "it's", 100)]);
    renderReview();
    await screen.findByRole('region', { name: 'Deep check' });
    fireEvent.click(await within(card()).findByRole('button', { name: /^Check the whole text/ }));
    fireEvent.click(await within(card()).findByRole('button', { name: /^Apply/ }));
    expect(await within(card()).findByText("Couldn't apply here — copied to clipboard.")).toBeTruthy();
    expect(copied).toEqual(["it's"]);
    expect(calls('applyEdit')).toHaveLength(0);
  });

  it('says so when the passage is gone at Go to', async () => {
    revealReply = { found: false };
    renderReview();
    await run();
    fireEvent.click((await within(card()).findAllByRole('button', { name: /^Go to/ }))[0]!);
    expect(await within(card()).findByText('That passage has changed since the review.')).toBeTruthy();
  });

  it('shows the banner for a status that stopped the run', async () => {
    deepReply = { status: 'key_missing' };
    renderReview();
    await run();
    expect(await within(card()).findByRole('alert')).toBeTruthy();
    expect(within(card()).queryByText('Nothing to flag.')).toBeNull();
  });

  it('keeps a result under the field it ran for', async () => {
    const view = renderReview();
    await run();
    await within(card()).findByText('Issues (2)');
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(reads()).toBeGreaterThan(1));
    await waitFor(() => expect(within(card()).queryByText('Issues (2)')).toBeNull());
  });
});

describe('Citation finder', () => {
  const CLAIM = 'The baker makes a loaf that smells like warm honey.';
  const START = DOC.indexOf(CLAIM);
  const SOURCES = [
    { url: 'https://www.example.org/sleep', title: 'Sleep Strengthens Memory', snippet: 'Recall doubled after sleep.', pageAge: 'April 30, 2025', note: 'Supports the claim.' },
    { url: 'https://news.example.com/b', title: 'Does Bread Smell Sweet?', snippet: null, pageAge: null, note: null },
  ];
  const MLA_FIRST = '“Sleep Strengthens Memory.” example.org, 30 Apr. 2025, www.example.org/sleep. Accessed 25 Oct. 2026.';
  let focus: { start: number; end: number } | null;
  let citeReply: unknown;
  const calls = (name: string) => vi.mocked(sendMessage).mock.calls.filter(([n]) => n === name);
  const card = () => screen.getByRole('region', { name: 'Citation finder' });
  const ready = () => waitFor(() => expect(stat('Words')).toBe('40'));
  const findButton = () => within(card()).getByRole('button', { name: /^Find sources/ }) as HTMLButtonElement;
  const run = async () => {
    await waitFor(() => expect(findButton().disabled).toBe(false));
    fireEvent.click(findButton());
    await waitFor(() => expect(calls('findCitations')).toHaveLength(1));
  };

  beforeEach(() => {
    provider.webSearch = true;
    focus = { start: START, end: START + CLAIM.length };
    citeReply = { status: 'ok', sources: SOURCES };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 25, 12, 0, 0));
    vi.mocked(sendMessage).mockImplementation((async (name: string, data: { fieldId?: string }) => {
      if (name === 'fieldText') return { ok: true, text: data.fieldId === 'f-2' ? 'Another field entirely, with a few words.' : docText, focus: data.fieldId === 'f-2' ? null : focus, mode: 'standard' };
      if (name === 'findCitations') return citeReply instanceof Error ? Promise.reject(citeReply) : citeReply;
      throw new Error(`unexpected ${name}`);
    }) as never);
  });

  afterEach(() => vi.unstubAllGlobals());

  const clipboard = () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (t: string) => void copied.push(t) } });
    return copied;
  };

  it('with no selection, disables the button and asks for a claim', async () => {
    focus = null;
    renderReview();
    await ready();
    expect(findButton().disabled).toBe(true);
    expect(within(card()).getByText('Select a claim in your text, then search.')).toBeTruthy();
  });

  it('treats a caret, or a selection under 8 characters, as no claim', async () => {
    focus = { start: START, end: START };
    const view = renderReview();
    await ready();
    expect(findButton().disabled).toBe(true);
    expect(within(card()).getByText('Select a claim in your text, then search.')).toBeTruthy();
    view.unmount();
    focus = { start: START, end: START + 7 };
    renderReview();
    await ready();
    expect(findButton().disabled).toBe(true);
    expect(within(card()).getByText('Select a claim in your text, then search.')).toBeTruthy();
  });

  it('says to select less for a claim over 600 characters', async () => {
    docText = `${DOC} ${'word '.repeat(130)}`;
    focus = { start: 0, end: 601 };
    renderReview();
    await waitFor(() => expect(within(card()).getByText('Select a shorter claim, up to 600 characters.')).toBeTruthy());
    expect(findButton().disabled).toBe(true);
  });

  it('labels the button with the cost of the search for the selected claim', async () => {
    renderReview();
    await ready();
    // 189 characters of claim and context plus 40,000 for the search results, 1,500 output tokens and 3 searches.
    expect(within(card()).getByRole('button', { name: 'Find sources · about $0.07' })).toBeTruthy();
    expect(within(card()).queryByText('Select a claim in your text, then search.')).toBeNull();
  });

  it('prices the search like the other cards: the provider\'s smart model, and no figure without its prices', async () => {
    // Shown off Claude only because this file stands in for the web-search rule.
    await providerItem.setValue({
      active: 'compatible',
      compatible: { preset: 'openai', baseURL: 'https://api.openai.com/v1', fastModel: 'gpt-a', smartModel: 'gpt-b', structuredOutputs: true, prices: {} },
    });
    renderReview();
    await ready();
    expect(within(card()).getByRole('button', { name: 'Find sources' })).toBeTruthy();
    expect(within(card()).getByText('Cost not known for this model.')).toBeTruthy();
  });

  it('sends the tab, the claim and the text on each side of it', async () => {
    renderReview();
    await ready();
    await run();
    expect(calls('findCitations')[0]![1]).toEqual({ tabId: 7, claim: CLAIM, before: DOC.slice(0, START), after: DOC.slice(START + CLAIM.length) });
  });

  it('takes the claim from the whole text, even past the 30,000 characters a review reads', async () => {
    docText = `${'word '.repeat(6100)}${CLAIM}`;
    focus = { start: docText.length - CLAIM.length, end: docText.length };
    renderReview();
    await run();
    expect(calls('findCitations')[0]![1]).toMatchObject({ claim: CLAIM, after: '' });
  });

  it('shows each source: its title as a link that opens a new tab, the excerpt or "No excerpt", the note and the MLA citation', async () => {
    renderReview();
    await ready();
    await run();
    const link = (await within(card()).findByRole('link', { name: 'Sleep Strengthens Memory' })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.example.org/sleep');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(card()).getByRole('link', { name: 'Does Bread Smell Sweet?' })).toBeTruthy();
    expect(within(card()).getByText('Recall doubled after sleep.')).toBeTruthy();
    expect(within(card()).getByText('No excerpt')).toBeTruthy();
    expect(within(card()).getByText('Supports the claim.')).toBeTruthy();
    expect(within(card()).getByText(MLA_FIRST)).toBeTruthy();
    expect(within(card()).getByText('“Does Bread Smell Sweet?” news.example.com, news.example.com/b. Accessed 25 Oct. 2026.')).toBeTruthy();
  });

  it('formats in the stored style, and a new style re-formats the shown sources without searching again, and is saved', async () => {
    await citationStyleItem.setValue('apa');
    renderReview();
    await ready();
    await run();
    expect(await within(card()).findByText('Sleep Strengthens Memory. (2025, April 30). example.org. https://www.example.org/sleep')).toBeTruthy();
    expect((within(card()).getByLabelText('Citation style') as HTMLSelectElement).value).toBe('apa');
    fireEvent.change(within(card()).getByLabelText('Citation style'), { target: { value: 'chicago' } });
    expect(
      await within(card()).findByText('“Sleep Strengthens Memory.” example.org. Last modified April 30, 2025. https://www.example.org/sleep.'),
    ).toBeTruthy();
    expect(calls('findCitations')).toHaveLength(1);
    expect(await citationStyleItem.getValue()).toBe('chicago');
  });

  it('offers MLA, APA and Chicago, MLA first by default', async () => {
    renderReview();
    await ready();
    const select = within(card()).getByLabelText('Citation style') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['MLA', 'APA', 'Chicago']);
    await waitFor(() => expect(select.value).toBe('mla'));
  });

  it('copies a citation, then says Copied', async () => {
    const copied = clipboard();
    renderReview();
    await ready();
    await run();
    const copy = await within(card()).findByRole('button', { name: 'Copy citation 1' });
    expect(copy.textContent).toBe('Copy citation');
    fireEvent.click(copy);
    await waitFor(() => expect(copied).toEqual([MLA_FIRST]));
    await waitFor(() => expect(copy.textContent).toBe('Copied'));
  });

  it('says web search is turned off, in place of the usual problem line', async () => {
    citeReply = { status: 'bad_response', searchOff: true };
    renderReview();
    await ready();
    await run();
    expect(
      await within(card()).findByText("Web search is turned off for this API key's organization. An admin can turn it on in the Claude Console."),
    ).toBeTruthy();
    expect(within(card()).getAllByRole('alert')).toHaveLength(1);
  });

  it('says Claude would not search for a refused claim, in place of the usual problem line', async () => {
    citeReply = { status: 'bad_response', refused: true };
    renderReview();
    await ready();
    await run();
    expect(await within(card()).findByText("Claude wouldn't search for this claim.")).toBeTruthy();
    expect(within(card()).getAllByRole('alert')).toHaveLength(1);
  });

  it('shows the title as plain text, not a link, for an address that is not http or https', async () => {
    citeReply = { status: 'ok', sources: [{ ...SOURCES[0], url: 'javascript:alert(1)', title: 'Odd Page' }, SOURCES[1]] };
    renderReview();
    await ready();
    await run();
    expect(await within(card()).findByText('Odd Page')).toBeTruthy();
    expect(within(card()).queryByRole('link', { name: 'Odd Page' })).toBeNull();
    expect(within(card()).getAllByRole('link')).toHaveLength(1);
  });

  it('says so when no sources came back', async () => {
    citeReply = { status: 'ok', sources: [] };
    renderReview();
    await ready();
    await run();
    expect(await within(card()).findByText('No sources found for that claim.')).toBeTruthy();
    expect(within(card()).queryAllByRole('link')).toHaveLength(0);
  });

  it('shows a status like paused_cap with the tool copy, and a failed send as an unusable answer', async () => {
    citeReply = { status: 'paused_cap' };
    const view = renderReview();
    await ready();
    await run();
    expect((await within(card()).findByRole('alert')).textContent).toMatch(/paused/i);
    view.unmount();
    vi.mocked(sendMessage).mockClear();
    citeReply = new Error('gone');
    renderReview();
    await ready();
    await run();
    expect(await within(card()).findByRole('alert')).toBeTruthy();
    expect(within(card()).queryByText(/Web search is turned off/)).toBeNull();
  });

  it('shows Searching… and disables the button until the answer arrives', async () => {
    let release: (v: unknown) => void = () => {};
    citeReply = new Promise((r) => (release = r));
    renderReview();
    await ready();
    await run();
    expect(within(card()).getByText('Searching…')).toBeTruthy();
    expect(findButton().disabled).toBe(true);
    await act(async () => release({ status: 'ok', sources: SOURCES }));
    expect(await within(card()).findByRole('link', { name: 'Sleep Strengthens Memory' })).toBeTruthy();
    expect(findButton().disabled).toBe(false);
  });

  it('keeps sources under the field they were found for', async () => {
    const view = renderReview();
    await ready();
    await run();
    await within(card()).findByRole('link', { name: 'Sleep Strengthens Memory' });
    view.rerender(<Review tabId={7} fieldId="f-2" frameId={3} shown spend={null} counts={COUNTS} />);
    await waitFor(() => expect(stat('Words')).toBe('7'));
    expect(within(card()).queryByRole('link')).toBeNull();
    view.rerender(<Review tabId={7} fieldId="f-1" frameId={3} shown spend={null} counts={COUNTS} />);
    await ready();
    expect(await within(card()).findByRole('link', { name: 'Sleep Strengthens Memory' })).toBeTruthy();
  });

  it('is not shown when the API has no web search', async () => {
    provider.webSearch = false;
    renderReview();
    await ready();
    expect(screen.queryByRole('region', { name: 'Citation finder' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Deep check' })).toBeTruthy();
  });
});

describe('the busy lines', () => {
  it('each card says what it is doing while it runs, and an empty lost list says so', async () => {
    const pending: Record<string, (v: unknown) => void> = {};
    vi.mocked(sendMessage).mockImplementation((async (name: string) => {
      if (name === 'fieldText') return { ok: true, text: docText, focus: null, mode: 'standard' };
      if (name === 'reviewReaders' || name === 'reviewGrade' || name === 'deepCheck') return new Promise((r) => (pending[name] = r));
      throw new Error(`unexpected ${name}`);
    }) as never);
    renderReview();
    await waitFor(() => expect(stat('Words')).toBe('40'));
    const card = (name: string) => screen.getByRole('region', { name });
    fireEvent.click(within(card('Reader reactions')).getByRole('button', { name: /^Get reactions/ }));
    fireEvent.change(within(card('Grader')).getByPlaceholderText('Paste the prompt or rubric'), { target: { value: 'Show growth.' } });
    fireEvent.click(within(card('Grader')).getByRole('button', { name: /^Grade against it/ }));
    fireEvent.click(within(card('Deep check')).getByRole('button', { name: /^Check the whole text/ }));
    expect((await within(card('Reader reactions')).findByRole('status')).textContent).toBe('Reading…');
    expect(within(card('Grader')).getByRole('status').textContent).toBe('Grading…');
    expect(within(card('Deep check')).getByRole('status').textContent).toBe('Checking…');

    const reaction = { firstImpression: 'Reads well.', remember: [], questions: [], lost: [], strength: { quote: '', why: 'Clear.' } };
    await act(async () => pending.reviewReaders!({ status: 'ok', reaction }));
    expect(await within(card('Reader reactions')).findByText('Nowhere in particular.')).toBeTruthy();
    expect(within(card('Reader reactions')).queryByRole('status')).toBeNull();
  });
});
