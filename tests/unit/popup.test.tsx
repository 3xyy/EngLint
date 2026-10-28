import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../../src/entrypoints/popup/App';
import { PRESETS, type CompatibleConfig, type ProviderConfig } from '../../src/core/provider';
import { sendMessage } from '../../src/shared/messages';
import { disabledSitesItem, essaySitesItem, providerItem, siteModesItem } from '../../src/shared/settings';

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

const OPENAI: CompatibleConfig = {
  preset: 'openai',
  baseURL: PRESETS.openai.baseURL,
  fastModel: 'gpt-a',
  smartModel: 'gpt-b',
  structuredOutputs: true,
  prices: { 'gpt-a': { input: 0.15, output: 0.6 }, 'gpt-b': { input: 2, output: 8 } },
};

let tabId: number;

beforeEach(async () => {
  fakeBrowser.reset();
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string, data: any) => {
    if (name === 'keyStatus') return { saved: true, last4: '1234' };
    // As the background answers them: the setting is written, and the popup follows it.
    if (name === 'setSiteMode') return void (await siteModesItem.setValue({ ...(await siteModesItem.getValue()), [data.host]: data.mode }));
    if (name === 'setSiteEnabled') {
      const others = (await disabledSitesItem.getValue()).filter((h) => h !== data.host);
      return void (await disabledSitesItem.setValue(data.enabled ? others : [...others, data.host]));
    }
    throw new Error(`unexpected ${name}`);
  }) as never);
  // The popup follows ?tabId= when it is given (as the e2e tests open it).
  const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/essay', active: true });
  tabId = tab.id!;
  window.history.replaceState(null, '', `/popup.html?tabId=${tab.id}`);
});
afterEach(cleanup);

async function renderPopup(provider: ProviderConfig) {
  await providerItem.setValue(provider);
  render(<App />);
  await waitFor(() => expect(screen.getByText('example.com')).toBeTruthy());
  await waitFor(() => expect(screen.getByLabelText('Check this site')).toBeTruthy());
}

const CLAUDE: ProviderConfig = { active: 'anthropic', compatible: null };
const sent = (name: string) => vi.mocked(sendMessage).mock.calls.filter(([n]) => n === name).map(([, data]) => data);
const checked = (name: string) => screen.getByRole('radio', { name }).getAttribute('aria-checked') === 'true';

describe('the popup', () => {
  it('heads with the wordmark, the site and a status pill, and offers Open panel first, then Settings', async () => {
    await renderPopup(CLAUDE);
    const header = within(document.querySelector('header')!);
    expect(header.getByRole('heading', { level: 1 }).textContent).toBe('EngLint');
    expect(header.getByText('example.com')).toBeTruthy();
    expect(header.getByText('Ready')).toBeTruthy(); // no text box has reported yet
    expect(screen.getByText('EngLint checks text boxes as you type.')).toBeTruthy();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.slice(-2)).toEqual(['Open panel', 'Settings']);
    expect(screen.getByRole('button', { name: 'Open panel' }).className).toContain('el-btn-primary');
  });

  it('the switch "Check this site" turns the site off and back on with setSiteEnabled', async () => {
    await renderPopup(CLAUDE);
    const sw = () => screen.getByRole('switch', { name: 'Check this site' });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await act(async () => fireEvent.click(sw()));
    expect(sent('setSiteEnabled')).toEqual([{ host: 'example.com', enabled: false, tabId }]);
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('false'));
    expect(screen.getByText('Off for this site')).toBeTruthy();
    await act(async () => fireEvent.click(sw()));
    expect(sent('setSiteEnabled').at(-1)).toEqual({ host: 'example.com', enabled: true, tabId });
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'));
  });

  it("the mode control shows this site's mode and sets it with setSiteMode", async () => {
    await renderPopup(CLAUDE);
    const group = screen.getByRole('radiogroup', { name: 'Mode' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Essay', 'Standard', 'Casual']);
    expect(checked('Standard')).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Essay' })));
    expect(sent('setSiteMode')).toEqual([{ host: 'example.com', mode: 'essay' }]);
    await waitFor(() => expect(checked('Essay')).toBe(true));
    expect(checked('Standard')).toBe(false);
  });

  it('the mode control follows a mode saved for the site, then the essay sites', async () => {
    await essaySitesItem.setValue(['example.com']);
    await renderPopup(CLAUDE);
    expect(checked('Essay')).toBe(true);
    await act(async () => siteModesItem.setValue({ 'example.com': 'casual' }));
    await waitFor(() => expect(checked('Casual')).toBe(true));
    expect(sent('setSiteMode')).toEqual([]); // showing a mode saves nothing
  });
});

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
