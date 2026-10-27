import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Tools } from '../../src/entrypoints/sidepanel/Tools';
import type { Mode } from '../../src/core/types';
import { sendMessage } from '../../src/shared/messages';
import { siteModesItem } from '../../src/shared/settings';

// The side panel's Tools against a fake background (sendMessage answers rewrite).

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

const VOICE = { kind: 'preset', presetId: 'voice' } as const;
const ORIGINAL = 'It was not just a trip, it was a journey.';

let answers: Record<string, unknown>[] = [];
beforeEach(() => {
  fakeBrowser.reset();
  answers = [];
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string) => {
    if (name === 'rewrite') return answers.shift() ?? { status: 'bad_response' };
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
const voiceButton = (region: HTMLElement) => within(region).getByRole('button', { name: 'Sound like me' });
async function runVoice(region: HTMLElement, text = ORIGINAL) {
  fireEvent.change(within(region).getByLabelText('Paste or select text'), { target: { value: text } });
  await act(async () => {
    fireEvent.click(voiceButton(region));
  });
}

describe('the side panel Tools: Sound like me', () => {
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
