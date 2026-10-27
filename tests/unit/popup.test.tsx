import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../../src/entrypoints/popup/App';
import { PRESETS, type CompatibleConfig, type ProviderConfig } from '../../src/core/provider';
import { sendMessage } from '../../src/shared/messages';
import { providerItem } from '../../src/shared/settings';

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

const OPENAI: CompatibleConfig = {
  preset: 'openai',
  baseURL: PRESETS.openai.baseURL,
  fastModel: 'gpt-a',
  smartModel: 'gpt-b',
  structuredOutputs: true,
  prices: { 'gpt-a': { input: 0.15, output: 0.6 }, 'gpt-b': { input: 2, output: 8 } },
};

beforeEach(async () => {
  fakeBrowser.reset();
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string) => {
    if (name === 'keyStatus') return { saved: true, last4: '1234' };
    throw new Error(`unexpected ${name}`);
  }) as never);
  // The popup follows ?tabId= when it is given (as the e2e tests open it).
  const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/essay', active: true });
  window.history.replaceState(null, '', `/popup.html?tabId=${tab.id}`);
});
afterEach(cleanup);

async function renderPopup(provider: ProviderConfig) {
  await providerItem.setValue(provider);
  render(<App />);
  await waitFor(() => expect(screen.getByText('example.com')).toBeTruthy());
  await waitFor(() => expect(screen.getByLabelText('EngLint on this site')).toBeTruthy());
}

describe('the popup\'s spending meter', () => {
  it('shows "Spending not tracked" in place of the meter when the active fast model is unpriced', async () => {
    const { 'gpt-b': smart } = OPENAI.prices;
    await renderPopup({ active: 'compatible', compatible: { ...OPENAI, prices: { 'gpt-b': smart! } } });
    expect(screen.getByText('Spending not tracked')).toBeTruthy();
    expect(screen.queryByText(/this month$/)).toBeNull();
  });

  it('does the same when only the smart model is unpriced', async () => {
    const { 'gpt-a': fast } = OPENAI.prices;
    await renderPopup({ active: 'compatible', compatible: { ...OPENAI, prices: { 'gpt-a': fast! } } });
    expect(screen.getByText('Spending not tracked')).toBeTruthy();
  });

  it('shows the meter when both models are priced, and on Claude', async () => {
    await renderPopup({ active: 'compatible', compatible: OPENAI });
    expect(screen.getByText('$0.00 of $25 this month')).toBeTruthy();
    expect(screen.queryByText('Spending not tracked')).toBeNull();
    cleanup();
    await renderPopup({ active: 'anthropic', compatible: { ...OPENAI, prices: {} } });
    expect(screen.getByText('$0.00 of $25 this month')).toBeTruthy();
  });
});
