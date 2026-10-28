import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Tools } from '../../src/entrypoints/sidepanel/Tools';
import { countWords } from '../../src/core/doc-stats';
import type { Mode } from '../../src/core/types';
import type { WordLimitCut } from '../../src/core/word-limit';
import { sendMessage } from '../../src/shared/messages';
import { siteModesItem } from '../../src/shared/settings';

// The side panel's Tools against a fake background (sendMessage answers rewrite).

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

const VOICE = { kind: 'preset', presetId: 'voice' } as const;
const ORIGINAL = 'It was not just a trip, it was a journey.';

let answers: Record<string, unknown>[] = [];
let limitAnswers: Record<string, unknown>[] = [];
beforeEach(() => {
  fakeBrowser.reset();
  answers = [];
  limitAnswers = [];
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string) => {
    if (name === 'rewrite') return answers.shift() ?? { status: 'bad_response' };
    if (name === 'wordLimit') return limitAnswers.shift() ?? { status: 'bad_response' };
    throw new Error(`unexpected ${name}`);
  }) as never);
});
afterEach(cleanup);

async function renderTools(mode: Mode = 'standard') {
  await siteModesItem.setValue({ 'example.com': mode });
  render(<Tools tabId={null} fallbackHost="example.com" spend={null} />);
  const region = screen.getByRole('region', { name: 'Tools' });
  if (mode !== 'standard') await waitFor(() => expect(within(region).queryByRole('button', { name: 'Expand' }) === null).toBe(mode === 'essay'));
  return region;
}
const voiceButton = (region: HTMLElement) => within(region).getByRole('button', { name: 'My voice' });
async function runVoice(region: HTMLElement, text = ORIGINAL) {
  fireEvent.change(within(region).getByLabelText('Paste or select text'), { target: { value: text } });
  await act(async () => {
    fireEvent.click(voiceButton(region));
  });
}

describe('the side panel Tools: the actions', () => {
  /** The actions as the panel lays them out: the leading buttons, then each labelled group with its buttons. */
  function layout(region: HTMLElement) {
    const row = region.querySelector<HTMLElement>('.tools-actions')!;
    const lead = [...row.querySelectorAll<HTMLElement>(':scope > .tools-lead > button')].map((b) => b.textContent);
    const groups = within(row).queryAllByRole('group').map((g) => [g.getAttribute('aria-label'), ...within(g).getAllByRole('button').map((b) => b.textContent)]);
    return { lead, groups };
  }

  it('follow the selection bar: Improve, My voice and Synonyms, then Shorten, Tone and More, every item a button', async () => {
    const region = await renderTools('standard');
    expect(layout(region)).toEqual({
      lead: ['Improve', 'My voice', 'Synonyms'],
      groups: [
        ['Shorten', 'Shorter', 'Fit a word limit…'],
        ['Tone', 'Formal', 'Confident', 'Friendly', 'Casual'],
        ['More', 'Expand'],
      ],
    });
    expect(within(region).getByRole('button', { name: 'Improve' }).className).toContain('el-btn-primary');
  });

  it('leave More out in Essay, where Expand is not offered', async () => {
    const region = await renderTools('essay');
    expect(layout(region).groups.map((g) => g[0])).toEqual(['Shorten', 'Tone']);
  });

  it('run the item picked: Tone · Formal sends the formal preset', async () => {
    answers.push({ status: 'ok', variants: ['One.', 'Two.', 'Three.'] });
    const region = await renderTools();
    fireEvent.change(within(region).getByLabelText('Paste or select text'), { target: { value: ORIGINAL } });
    await act(async () => {
      fireEvent.click(within(within(region).getByRole('group', { name: 'Tone' })).getByRole('button', { name: 'Formal' }));
    });
    expect(vi.mocked(sendMessage).mock.calls[0]![1]).toMatchObject({ request: { kind: 'preset', presetId: 'formal' }, stage: 'variants' });
    await waitFor(() => expect(region.querySelectorAll('.tools-result')).toHaveLength(3));
  });
});

describe('the side panel Tools: My voice', () => {
  it('is offered in every mode, and runs there in that mode', async () => {
    const expand = (region: HTMLElement) => within(region).queryByRole('button', { name: 'Expand' });
    /** Runs Sound like me and checks the request went out in `mode` (the run refuses a preset the mode doesn't offer). */
    async function runsIn(region: HTMLElement, mode: Mode) {
      vi.mocked(sendMessage).mockClear();
      await runVoice(region);
      await waitFor(() => expect(vi.mocked(sendMessage), mode).toHaveBeenCalledTimes(1));
      expect(vi.mocked(sendMessage).mock.calls[0]![1], mode).toMatchObject({ mode, request: VOICE, stage: mode === 'essay' ? 'critique' : 'variants' });
    }
    // Standard is where the panel starts. Then Essay (Expand goes) and Casual (Expand comes back): each change
    // is seen before the buttons are checked, so each check is in that mode.
    const region = await renderTools('standard');
    expect(voiceButton(region)).toBeTruthy();
    await runsIn(region, 'standard');
    await act(() => siteModesItem.setValue({ 'example.com': 'essay' }));
    await waitFor(() => expect(expand(region)).toBeNull());
    expect(voiceButton(region)).toBeTruthy();
    await runsIn(region, 'essay');
    await act(() => siteModesItem.setValue({ 'example.com': 'casual' }));
    await waitFor(() => expect(expand(region)).not.toBeNull());
    expect(voiceButton(region)).toBeTruthy();
    await runsIn(region, 'casual');
  });

  it('sends the variants stage with no voice sample (no field here), then shows the tells, one diff and Copy', async () => {
    answers.push({ status: 'ok', variants: ['It was a long trip.'], tells: ['a staged contrast', 'an inflated claim'] });
    const region = await renderTools();
    await runVoice(region);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('rewrite', {
      host: 'example.com',
      mode: 'standard',
      request: VOICE,
      text: ORIGINAL,
      before: '',
      after: '',
      stage: 'variants',
    });
    await waitFor(() => expect(within(region).getByText('Generic patterns found: a staged contrast, an inflated claim')).toBeTruthy());
    const results = region.querySelectorAll('.tools-result');
    expect(results).toHaveLength(1);
    expect(results[0]!.querySelector('ins')).not.toBeNull();
    expect(within(region).getByRole('button', { name: 'Copy this version' })).toBeTruthy();
    expect(region.textContent).not.toContain('Check the facts');
  });

  it('no tells says so; a version that changes a number shows the fact note', async () => {
    answers.push({ status: 'ok', variants: ['It took 3 days.'], tells: [] });
    const region = await renderTools();
    await runVoice(region);
    await waitFor(() => expect(within(region).getByText('No generic patterns found.')).toBeTruthy());
    expect(within(region).getByText('Check the facts: this version changes a number, name or quote.')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Copy this version' })).toBeTruthy();
  });

  it('Essay: the critique comes first, then "Show the version" shows the version with its tells', async () => {
    answers.push({ status: 'ok', critique: { weakness: 'It sounds staged.', lightFix: 'It was a journey.' } });
    answers.push({ status: 'ok', variants: ['It was a long trip.'], tells: ['a staged contrast'] });
    const region = await renderTools('essay');
    await runVoice(region);
    await waitFor(() => expect(within(region).getByText('It sounds staged.')).toBeTruthy());
    expect(vi.mocked(sendMessage).mock.calls[0]![1]).toMatchObject({ mode: 'essay', request: VOICE, stage: 'critique' });
    expect(within(region).queryByRole('button', { name: 'Show 3 rewrites' })).toBeNull();
    expect(region.textContent).not.toContain('Check the facts');
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Show the version' }));
    });
    await waitFor(() => expect(within(region).getByText('Generic patterns found: a staged contrast')).toBeTruthy());
    expect(vi.mocked(sendMessage).mock.calls[1]![1]).toMatchObject({ mode: 'essay', request: VOICE, stage: 'variants' });
  });

  it('Essay: a light fix that changes a number shows the fact note', async () => {
    answers.push({ status: 'ok', critique: { weakness: 'It sounds staged.', lightFix: 'It took 3 days.' } });
    const region = await renderTools('essay');
    await runVoice(region);
    await waitFor(() => expect(within(region).getByText('It sounds staged.')).toBeTruthy());
    expect(within(region).getByText('Check the facts: this version changes a number, name or quote.')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Copy this version' })).toBeTruthy();
  });

  it('the passage back as it was: it says so, with no diff and no Copy', async () => {
    answers.push({ status: 'ok', variants: [ORIGINAL], tells: [] });
    const region = await renderTools();
    await runVoice(region);
    await waitFor(() => expect(within(region).getByText('No generic patterns found. This already sounds like you.')).toBeTruthy());
    expect(region.querySelectorAll('.tools-result, del, ins')).toHaveLength(0);
    expect(within(region).queryByRole('button', { name: 'Copy this version' })).toBeNull();
  });

  it('a version or light fix that only drops an opener at a later sentence start shows no fact note', async () => {
    const opener = 'We packed early. Moreover, we were tired.';
    answers.push({ status: 'ok', variants: ['We packed early, and we were tired.'], tells: ['a stock transition'] });
    const region = await renderTools();
    await runVoice(region, opener);
    await waitFor(() => expect(within(region).getByText('Generic patterns found: a stock transition')).toBeTruthy());
    expect(region.textContent).not.toContain('Check the facts');
    cleanup();
    answers.push({ status: 'ok', critique: { weakness: 'A stock transition.', lightFix: 'We packed early, and we were tired.' } });
    const essay = await renderTools('essay');
    await runVoice(essay, opener);
    await waitFor(() => expect(within(essay).getByText('A stock transition.')).toBeTruthy());
    expect(essay.textContent).not.toContain('Check the facts');
  });
});

describe('the side panel Tools: fit a word limit', () => {
  const SEL = 'In order to win the final, we really practiced every single day after school.'; // 14 words
  function cutOf(original: string, replacement: string, changesFacts = false): WordLimitCut {
    const start = SEL.indexOf(original);
    return { start, end: start + original.length, original, replacement, why: 'filler', saves: countWords(original) - countWords(replacement), changesFacts };
  }
  const CUTS = [cutOf('In order to', 'To'), cutOf('really', ''), cutOf('after school', '', true)];
  const VERSION = 'To win the final, we practiced daily.';
  const limitButton = (region: HTMLElement) => within(region).getByRole('button', { name: 'Fit a word limit…' });
  const type = (region: HTMLElement, text: string) => fireEvent.change(within(region).getByLabelText('Paste or select text'), { target: { value: text } });
  let clipboard: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    clipboard = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
  });
  async function cutsShown(region: HTMLElement, target = '12') {
    type(region, SEL);
    fireEvent.click(limitButton(region));
    fireEvent.change(within(region).getByLabelText('Target'), { target: { value: target } });
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Find cuts' }));
    });
    await waitFor(() => expect(region.querySelector('.el-wl-cuts')).not.toBeNull());
  }

  it('opens the target picker for the text, counted locally, in Essay too; nothing is sent before Find cuts', async () => {
    const region = await renderTools('essay');
    type(region, `  ${SEL}  `);
    fireEvent.click(limitButton(region));
    expect(region.querySelector('.el-wl-count')!.textContent).toBe('14 words selected');
    expect((within(region).getByLabelText('Target') as HTMLInputElement).value).toBe('10');
    expect(vi.mocked(sendMessage)).not.toHaveBeenCalled();
  });

  it('Find cuts sends the text with no context and the target, then shows the cuts with the greedy picks and the counter', async () => {
    limitAnswers.push({ status: 'ok', cuts: CUTS, version: VERSION });
    const region = await renderTools('essay');
    await cutsShown(region);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('wordLimit', { host: 'example.com', mode: 'essay', text: SEL, before: '', after: '', target: 12 });
    const boxes = [...region.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]); // 12 after the first; the fact-changing cut never
    expect(region.querySelector('.el-wl-counter')!.textContent).toBe('Selected cuts: 12 words (at the limit)');
    expect(region.querySelector('.el-wl-head')!.textContent).toBe('14 → 12 words');
  });

  it('Copy selected copies the text with the picked cuts applied; Copy full version copies the version', async () => {
    limitAnswers.push({ status: 'ok', cuts: CUTS, version: VERSION });
    const region = await renderTools();
    await cutsShown(region);
    fireEvent.click(region.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!);
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Copy selected' }));
    });
    expect(clipboard).toHaveBeenLastCalledWith('To win the final, we practiced every single day after school.');
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Copy full version (7 words)' }));
    });
    expect(clipboard).toHaveBeenLastCalledWith(VERSION);
    fireEvent.click(region.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!);
    fireEvent.click(region.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!);
    expect((within(region).getByRole('button', { name: 'Copy selected' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a version that changes a fact has the fact note, which describes Copy full version', async () => {
    limitAnswers.push({ status: 'ok', cuts: CUTS, version: VERSION, versionChangesFacts: true });
    const region = await renderTools();
    await cutsShown(region);
    const note = region.querySelector('.el-wl-facts')!;
    expect(note.textContent).toBe('Check the facts: this version changes a number, name or quote.');
    expect(within(region).getByRole('button', { name: 'Copy full version (7 words)' }).getAttribute('aria-describedby')).toBe(note.id);
    cleanup();
    limitAnswers.push({ status: 'ok', cuts: CUTS, version: VERSION, versionChangesFacts: false });
    const plain = await renderTools();
    await cutsShown(plain);
    expect(plain.querySelector('.el-wl-facts')).toBeNull();
  });

  it('Find more cuts sends the cuts shown; the new ones join the list, the picks kept', async () => {
    limitAnswers.push({ status: 'ok', cuts: CUTS.slice(0, 2), version: null }, { status: 'ok', cuts: [cutOf('every single day', 'daily')], version: VERSION });
    const region = await renderTools();
    await cutsShown(region, '10');
    fireEvent.click(region.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!); // unpick "really"
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Find more cuts' }));
    });
    await waitFor(() => expect(region.querySelectorAll('input[type="checkbox"]')).toHaveLength(3));
    expect(vi.mocked(sendMessage).mock.calls[1]![1]).toMatchObject({ target: 10, shown: CUTS.slice(0, 2).map(({ start, end, original, replacement }) => ({ start, end, original, replacement })) });
    expect([...region.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((b) => b.checked)).toEqual([true, false, true]);
    expect(within(region).getByRole('button', { name: 'Copy full version (7 words)' })).toBeTruthy();
  });

  it('a failed search for more keeps the cuts and the picks, with its status under them; Find more cuts tries again', async () => {
    limitAnswers.push({ status: 'ok', cuts: CUTS.slice(0, 2), version: VERSION }, { status: 'overloaded' }, { status: 'ok', cuts: [cutOf('every single day', 'daily')], version: null });
    const region = await renderTools();
    await cutsShown(region, '10');
    const boxes = () => [...region.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    fireEvent.click(boxes()[1]!); // unpick "really"
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Find more cuts' }));
    });
    await waitFor(() => expect(within(region).getByRole('alert').textContent).toBe('Claude is busy right now. Try again in a moment.'));
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
    expect(within(region).getByRole('button', { name: 'Copy full version (7 words)' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Find more cuts' }));
    });
    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(vi.mocked(sendMessage).mock.calls[2]![1]).toEqual(vi.mocked(sendMessage).mock.calls[1]![1]);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
    expect(within(region).queryByRole('alert')).toBeNull();
  });

  it('a search for more stopped by the cap keeps the cuts with its status, and offers no Find more cuts', async () => {
    limitAnswers.push({ status: 'ok', cuts: CUTS.slice(0, 2), version: null }, { status: 'paused_cap' });
    const region = await renderTools();
    await cutsShown(region, '10');
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Find more cuts' }));
    });
    await waitFor(() => expect(within(region).getByRole('alert').textContent).toMatch(/^Monthly limit reached/));
    expect(region.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(within(region).queryByRole('button', { name: 'Find more cuts' })).toBeNull();
  });

  it('is off for one word or past 5,000 characters, and on past 2,000, where the rewrite buttons are off', async () => {
    const region = await renderTools();
    type(region, 'word');
    expect((limitButton(region) as HTMLButtonElement).disabled).toBe(true);
    type(region, 'word '.repeat(500).trim()); // 2,499 characters
    expect((limitButton(region) as HTMLButtonElement).disabled).toBe(false);
    expect((within(region).getByRole('button', { name: 'Shorter' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(region).getByText('Only Fit a word limit works on selections this long.')).toBeTruthy();
    type(region, 'word '.repeat(1100).trim()); // 5,499 characters
    expect((limitButton(region) as HTMLButtonElement).disabled).toBe(true);
    expect(within(region).getByText('Select up to about 5,000 characters to fit a word limit.')).toBeTruthy();
  });

  it('a failed search shows its status text', async () => {
    limitAnswers.push({ status: 'paused_cap' });
    const region = await renderTools();
    type(region, SEL);
    fireEvent.click(limitButton(region));
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Find cuts' }));
    });
    await waitFor(() => expect(within(region).getByRole('alert')).toBeTruthy());
  });
});
