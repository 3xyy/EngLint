import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { endpointBlocked } from '../../src/background/provider-gate';
import { DEFAULT_PROVIDER, PRESETS, permissionPattern, type CompatibleConfig, type KeySlot, type ProviderConfig } from '../../src/core/provider';
import { sendMessage } from '../../src/shared/messages';
import { providerItem } from '../../src/shared/settings';
import { ProviderSection } from '../../src/shared/ui/ProviderSection';

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

const send = vi.mocked(sendMessage) as unknown as ReturnType<typeof vi.fn>;
const FAST = 'Fast model (live checks, synonyms, tone)';
const SMART = 'Smart model (rewrites, reviews, chat)';
const UNPRICED = "Spending isn't tracked for this model, so your monthly limit can't protect you. Add its prices from your provider's pricing page.";
const NO_LIST = "Couldn't load the model list. Type the model names.";
const TUNED = "EngLint is tuned and tested on Claude. Other providers work, but their suggestions haven't been measured.";

/** The background as the section sees it: keys by slot, and what listModels and testKey answer. */
let keys: Partial<Record<KeySlot, string>>;
let models: { ok: true; models: string[] } | { ok: false; status: string };
let tested: object;

const OPENAI: CompatibleConfig = {
  preset: 'openai',
  baseURL: PRESETS.openai.baseURL,
  fastModel: 'gpt-a',
  smartModel: 'gpt-b',
  structuredOutputs: true,
  prices: { 'gpt-a': { input: 0.15, output: 0.6 } },
};

beforeEach(() => {
  fakeBrowser.reset();
  send.mockReset();
  vi.restoreAllMocks();
  keys = {};
  models = { ok: true, models: ['gpt-a', 'gpt-b'] };
  tested = { ok: true, status: 'ok', usage: { input_tokens: 100, output_tokens: 20 }, model: 'gpt-a' };
  send.mockImplementation(async (name: string, data: any) => {
    if (name === 'keyStatus') {
      const key = keys[(data?.slot ?? 'anthropic') as KeySlot];
      return { saved: !!key, last4: key ? key.slice(-4) : null };
    }
    if (name === 'setApiKey') return void (keys[data.slot as KeySlot] = data.key);
    if (name === 'clearApiKey') return void delete keys[data.slot as KeySlot];
    if (name === 'listModels') return models;
    if (name === 'testKey') return tested;
    throw new Error(`unexpected ${name}`);
  });
});
afterEach(cleanup);

const providerSelect = () => screen.getByLabelText('Provider') as HTMLSelectElement;
const choose = (value: string) => act(async () => fireEvent.change(providerSelect(), { target: { value } }));
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement & HTMLSelectElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const click = (name: string) => act(async () => fireEvent.click(screen.getByRole('button', { name })));
const calls = (name: string) => send.mock.calls.filter(([n]) => n === name);
const prices = (model: string) => within(screen.getByRole('group', { name: `Prices for ${model}` }));

async function renderSection(saved?: ProviderConfig) {
  if (saved) await providerItem.setValue(saved);
  render(<ProviderSection />);
  await waitFor(() => expect(providerSelect()).toBeTruthy());
}

/** Chrome's permission prompt, answered `granted`. */
function permission(granted = true) {
  return vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValue(granted as never);
}

describe('ProviderSection', () => {
  it('offers Claude first, then the presets, under the AI provider heading, with the note on Claude', async () => {
    await renderSection();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('AI provider');
    expect(Array.from(providerSelect().options).map((o) => o.textContent)).toEqual([
      'Claude (recommended)',
      'OpenAI',
      'Google Gemini',
      'OpenRouter',
      'Groq',
      'Ollama (on this computer)',
      'LM Studio (on this computer)',
      'Custom endpoint',
    ]);
    expect(providerSelect().value).toBe('anthropic');
    expect(screen.getByText(TUNED)).toBeTruthy();
    expect(field('Claude API key').type).toBe('password'); // today's key UI
    expect(screen.getByRole('button', { name: 'Test key' })).toBeTruthy();
  });

  it('choosing Gemini shows its read-only endpoint and fills the model selects from listModels', async () => {
    keys['compatible:gemini'] = 'g-key-1234';
    models = { ok: true, models: ['gemini-fast', 'gemini-pro'] };
    await renderSection();
    await choose('gemini');
    expect(field('Endpoint').value).toBe(PRESETS.gemini.baseURL);
    expect(field('Endpoint').readOnly).toBe(true);
    expect(screen.queryByLabelText('This endpoint supports JSON schema')).toBeNull();
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    expect(calls('listModels')).toEqual([['listModels', { slot: 'compatible:gemini', baseURL: PRESETS.gemini.baseURL }]]);
    expect(Array.from(field(FAST).options).map((o) => o.value)).toEqual(['', 'gemini-fast', 'gemini-pro']);
    expect(Array.from(field(SMART).options).map((o) => o.value)).toEqual(['', 'gemini-fast', 'gemini-pro']);
    expect(screen.getByText('Key saved (ends in …1234)')).toBeTruthy();
    expect(screen.getByText(TUNED)).toBeTruthy();
  });

  it('a listModels failure shows text fields and the message', async () => {
    keys['compatible:gemini'] = 'g-key';
    models = { ok: false, status: 'offline' };
    await renderSection();
    await choose('gemini');
    await waitFor(() => expect(screen.getByText(NO_LIST)).toBeTruthy());
    expect(field(FAST).tagName).toBe('INPUT');
    expect(field(SMART).tagName).toBe('INPUT');
    type(FAST, 'gemini-typed');
    expect(field(FAST).value).toBe('gemini-typed');
  });

  it('Save with http://example.com shows the URL error and stores nothing', async () => {
    const request = permission();
    await renderSection();
    await choose('custom');
    expect(field('Endpoint').readOnly).toBe(false);
    expect(field('This endpoint supports JSON schema').type).toBe('checkbox');
    type('Endpoint', 'http://example.com');
    type('API key', 'sk-custom');
    await click('Load models');
    expect(screen.getByRole('alert').textContent).toBe('Use an https address (http is allowed only for this computer).');
    expect(await providerItem.getValue()).toEqual(DEFAULT_PROVIDER);
    expect(request).not.toHaveBeenCalled();
    expect(calls('setApiKey')).toEqual([]);
  });

  it('Save asks Chrome for https://api.openai.com/* for OpenAI, the pattern the background checks, and stores the config', async () => {
    const request = permission();
    keys['compatible:openai'] = 'sk-open';
    await renderSection();
    await choose('openai');
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    fireEvent.change(field(FAST), { target: { value: 'gpt-a' } });
    fireEvent.change(field(SMART), { target: { value: 'gpt-b' } });
    await click('Save');
    expect(request.mock.calls).toEqual([[{ origins: ['https://api.openai.com/*'] }]]);
    const saved = await providerItem.getValue();
    expect(saved).toEqual({
      active: 'compatible',
      compatible: { preset: 'openai', baseURL: PRESETS.openai.baseURL, fastModel: 'gpt-a', smartModel: 'gpt-b', structuredOutputs: true, prices: {} },
    });
    expect(screen.getByRole('status').textContent).toBe('Saved. EngLint now uses OpenAI.');

    // The background asks Chrome about the very pattern Save requested.
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(true as never);
    await endpointBlocked({}, saved);
    expect(contains.mock.calls).toEqual([[{ origins: [permissionPattern(saved.compatible!)] }]]);
    expect(contains.mock.calls[0]![0]).toEqual(request.mock.calls[0]![0]);
  });

  it('Save stores a typed key in the preset\'s own slot, and the prices typed for each model', async () => {
    permission();
    await renderSection();
    await choose('custom');
    type('Endpoint', 'http://127.0.0.1:4011/v1');
    type('API key', '  sk-custom-9876  ');
    await click('Load models'); // no models yet: the list loads with the typed key, and nothing is stored
    expect(calls('setApiKey')).toEqual([]);
    expect(await providerItem.getValue()).toEqual(DEFAULT_PROVIDER);
    expect(screen.getByRole('status').textContent).toBe('Choose a fast model and a smart model, then click Save.');
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    expect(calls('listModels').at(-1)).toEqual(['listModels', { slot: 'compatible:custom', baseURL: 'http://127.0.0.1:4011/v1', key: 'sk-custom-9876' }]);
    expect(field('API key').value).toBe('  sk-custom-9876  '); // kept for the Save that stores it with the config
    fireEvent.change(field(FAST), { target: { value: 'gpt-a' } });
    fireEvent.change(field(SMART), { target: { value: 'gpt-b' } });
    fireEvent.change(prices('gpt-a').getByLabelText('Input price ($ per million tokens)'), { target: { value: '0.15' } });
    fireEvent.change(prices('gpt-a').getByLabelText('Output price ($ per million tokens)'), { target: { value: '0.6' } });
    fireEvent.change(prices('gpt-b').getByLabelText('Input price ($ per million tokens)'), { target: { value: '2' } }); // no output price: unpriced
    fireEvent.click(field('This endpoint supports JSON schema'));
    await click('Save');
    expect(calls('setApiKey')).toEqual([['setApiKey', { slot: 'compatible:custom', key: 'sk-custom-9876', baseURL: 'http://127.0.0.1:4011/v1' }]]);
    expect(keys['compatible:custom']).toBe('sk-custom-9876');
    expect(field('API key').value).toBe(''); // a saved key is never shown back
    expect((await providerItem.getValue()).compatible).toEqual({
      preset: 'custom',
      baseURL: 'http://127.0.0.1:4011/v1',
      fastModel: 'gpt-a',
      smartModel: 'gpt-b',
      structuredOutputs: true,
      prices: { 'gpt-a': { input: 0.15, output: 0.6 } },
    });
  });

  it('an unpriced model shows the warning, until both its prices are in', async () => {
    keys['compatible:openai'] = 'sk-open';
    await renderSection();
    await choose('openai');
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    fireEvent.change(field(FAST), { target: { value: 'gpt-a' } });
    expect(prices('gpt-a').getByText(UNPRICED)).toBeTruthy();
    fireEvent.change(prices('gpt-a').getByLabelText('Input price ($ per million tokens)'), { target: { value: '0.15' } });
    expect(prices('gpt-a').getByText(UNPRICED)).toBeTruthy();
    fireEvent.change(prices('gpt-a').getByLabelText('Output price ($ per million tokens)'), { target: { value: '0.6' } });
    expect(prices('gpt-a').queryByText(UNPRICED)).toBeNull();
  });

  it('shows the saved config, its prices and no warning for a priced model', async () => {
    keys['compatible:openai'] = 'sk-open';
    await renderSection({ active: 'compatible', compatible: OPENAI });
    expect(providerSelect().value).toBe('openai');
    await waitFor(() => expect(field(FAST).value).toBe('gpt-a'));
    expect(field(SMART).value).toBe('gpt-b');
    expect((prices('gpt-a').getByLabelText('Input price ($ per million tokens)') as HTMLInputElement).value).toBe('0.15');
    expect(prices('gpt-a').queryByText(UNPRICED)).toBeNull();
    expect(prices('gpt-b').getByText(UNPRICED)).toBeTruthy();
  });

  it('switching back to Claude keeps the compatible config and both keys', async () => {
    keys = { anthropic: 'sk-ant-1111', 'compatible:openai': 'sk-open-2222' };
    await renderSection({ active: 'compatible', compatible: OPENAI });
    await choose('anthropic');
    await waitFor(async () => expect(await providerItem.getValue()).toEqual({ active: 'anthropic', compatible: OPENAI }));
    expect(calls('clearApiKey')).toEqual([]);
    expect(keys).toEqual({ anthropic: 'sk-ant-1111', 'compatible:openai': 'sk-open-2222' });
    await waitFor(() => expect(screen.getByText('Key saved (ends in …1111)')).toBeTruthy());
    expect(field('Claude API key')).toBeTruthy();

    await choose('openai'); // set up already: back at once
    await waitFor(async () => expect(await providerItem.getValue()).toEqual({ active: 'compatible', compatible: OPENAI }));
  });

  it('choosing a preset that isn\'t set up changes nothing until Save', async () => {
    await renderSection();
    await choose('groq');
    expect(await providerItem.getValue()).toEqual(DEFAULT_PROVIDER);
    expect(screen.getByText('EngLint keeps using Claude until you click Save.')).toBeTruthy();
    expect(screen.getByText('Enter your API key and click Load models.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load models' })).toBeTruthy();
    expect(calls('listModels')).toEqual([]); // no key yet
  });

  it('hides the key field for a local server, and lists its models without one', async () => {
    await renderSection();
    await choose('ollama');
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(field('Endpoint').value).toBe('http://localhost:11434/v1');
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    expect(calls('listModels')).toEqual([['listModels', { slot: 'compatible:ollama', baseURL: 'http://localhost:11434/v1' }]]);
  });

  it('a Save Chrome refuses keeps the provider in use, stores nothing, and asks again', async () => {
    permission(false);
    keys['compatible:openai'] = 'sk-open';
    await renderSection();
    await choose('openai');
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    fireEvent.change(field(FAST), { target: { value: 'gpt-a' } });
    fireEvent.change(field(SMART), { target: { value: 'gpt-a' } });
    await click('Save');
    expect(await providerItem.getValue()).toEqual(DEFAULT_PROVIDER); // still Claude: every check would be blocked otherwise
    expect(screen.getByRole('status').textContent).toBe('EngLint needs permission to reach OpenAI. Click Save again and choose Allow.');
    expect(calls('testKey')).toEqual([]);
  });

  it('a refused Save never hands the single compatible slot to the endpoint Chrome refused', async () => {
    const GROQ: CompatibleConfig = { ...OPENAI, preset: 'groq', baseURL: PRESETS.groq.baseURL };
    permission(false);
    keys = { 'compatible:groq': 'gsk', 'compatible:openai': 'sk-open' };
    await renderSection({ active: 'compatible', compatible: GROQ });
    await choose('openai');
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    fireEvent.change(field(FAST), { target: { value: 'gpt-a' } });
    fireEvent.change(field(SMART), { target: { value: 'gpt-b' } });
    await click('Test');
    expect(await providerItem.getValue()).toEqual({ active: 'compatible', compatible: GROQ });
    expect(screen.getByRole('status').textContent).toBe('EngLint needs permission to reach OpenAI. Click Save again and choose Allow.');
    expect(calls('testKey')).toEqual([]);
  });

  it('a refused first click names the button the writer sees', async () => {
    permission(false);
    await renderSection();
    await choose('custom');
    type('Endpoint', 'https://llm.example.org/v1');
    type('API key', 'sk-custom');
    await click('Load models');
    expect(screen.getByRole('status').textContent).toBe('EngLint needs permission to reach llm.example.org. Click Load models again and choose Allow.');
    expect(await providerItem.getValue()).toEqual(DEFAULT_PROVIDER);
  });

  it('the first button reads Load models until the model list shows, then Save', async () => {
    permission();
    await renderSection();
    await choose('openai');
    expect(screen.getByRole('button', { name: 'Load models' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    type('API key', 'sk-open');
    await click('Load models');
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load models' })).toBeNull();
    // A fixed preset's typed key also lists without being stored, and is stored by the Save, with no address.
    expect(calls('listModels').at(-1)).toEqual(['listModels', { slot: 'compatible:openai', baseURL: PRESETS.openai.baseURL, key: 'sk-open' }]);
    expect(calls('setApiKey')).toEqual([]);
    fireEvent.change(field(FAST), { target: { value: 'gpt-a' } });
    fireEvent.change(field(SMART), { target: { value: 'gpt-b' } });
    await click('Save');
    expect(calls('setApiKey')).toEqual([['setApiKey', { slot: 'compatible:openai', key: 'sk-open' }]]);
  });

  it('a custom address is never asked for its models while it is typed, with a key saved for Custom', async () => {
    permission();
    keys['compatible:custom'] = 'sk-custom-saved';
    await renderSection();
    await choose('custom');
    // Types each address, then pauses longer than any typing debounce, on a fake clock (testing-library's waits
    // need the real one, so it is put back after).
    const typeAndPause = async (...urls: string[]) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        for (const url of urls) {
          type('Endpoint', url);
          await act(() => vi.advanceTimersByTimeAsync(2000));
        }
      } finally {
        vi.useRealTimers();
      }
    };
    await typeAndPause('https://a', 'https://api.openai.com', 'https://api.openai.com/v1');
    expect(calls('listModels')).toEqual([]);
    // The saved key belongs to no address the writer saved with it: this one needs its own.
    expect(screen.getByText('Enter the API key for this address, then click Load models.')).toBeTruthy();
    type('API key', 'sk-for-v1');
    await click('Load models');
    await waitFor(() => expect(calls('listModels')).toEqual([['listModels', { slot: 'compatible:custom', baseURL: 'https://api.openai.com/v1', key: 'sk-for-v1' }]]));
    expect(keys['compatible:custom']).toBe('sk-custom-saved'); // the typed key is only stored with the config
    // A change after the click is a new address: no request until the next click.
    await typeAndPause('https://api.openai.com/v2');
    expect(calls('listModels')).toHaveLength(1);
  });

  describe('a Custom key and the address it was saved for', () => {
    const SAVED_A: CompatibleConfig = { ...OPENAI, preset: 'custom', baseURL: 'https://a.example/v1', structuredOutputs: false };

    it('a click Chrome refuses stores no key: the address in use keeps its own', async () => {
      const request = permission(false);
      keys['compatible:custom'] = 'KEY-FOR-A';
      await renderSection({ active: 'compatible', compatible: SAVED_A });
      await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
      type('Endpoint', 'https://b.example/v1');
      type('API key', 'KEY-FOR-B');
      await click('Load models');
      expect(request).toHaveBeenCalledTimes(1);
      expect(calls('setApiKey')).toEqual([]);
      expect(keys['compatible:custom']).toBe('KEY-FOR-A'); // the next check on A still carries A's key
      expect(await providerItem.getValue()).toEqual({ active: 'compatible', compatible: SAVED_A });
      expect(screen.getByRole('status').textContent).toBe('EngLint needs permission to reach b.example. Click Load models again and choose Allow.');
      expect(field('API key').value).toBe('KEY-FOR-B'); // kept for the next try
    });

    it('a changed address with no key typed is asked for nothing, and never gets the saved key', async () => {
      const request = permission();
      keys['compatible:custom'] = 'KEY-FOR-A';
      await renderSection({ active: 'compatible', compatible: SAVED_A });
      await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
      type('Endpoint', 'https://b.example/v1');
      await click('Load models');
      await act(async () => {});
      expect(calls('listModels')).toEqual([['listModels', { slot: 'compatible:custom', baseURL: 'https://a.example/v1' }]]); // A's, on opening
      expect(request).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toBe('Enter the API key for this address.');
      expect(screen.getByText('Enter the API key for this address, then click Load models.')).toBeTruthy();
      expect(await providerItem.getValue()).toEqual({ active: 'compatible', compatible: SAVED_A });
    });

    it('a new address and key, with both models cleared and access allowed, stores nothing until Save, then both together', async () => {
      permission(true);
      keys['compatible:custom'] = 'KEY-FOR-A';
      await renderSection({ active: 'compatible', compatible: SAVED_A });
      await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
      fireEvent.change(field(FAST), { target: { value: '' } });
      fireEvent.change(field(SMART), { target: { value: '' } });
      type('Endpoint', 'https://b.example/v1');
      type('API key', 'KEY-FOR-B');
      await click('Load models');
      await waitFor(() => expect(calls('listModels').at(-1)).toEqual(['listModels', { slot: 'compatible:custom', baseURL: 'https://b.example/v1', key: 'KEY-FOR-B' }]));
      expect(calls('setApiKey')).toEqual([]);
      expect(keys['compatible:custom']).toBe('KEY-FOR-A'); // A, still in use, keeps its key
      expect(await providerItem.getValue()).toEqual({ active: 'compatible', compatible: SAVED_A });
      await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
      fireEvent.change(field(FAST), { target: { value: 'gpt-a' } });
      fireEvent.change(field(SMART), { target: { value: 'gpt-b' } });
      await click('Save');
      expect(calls('setApiKey')).toEqual([['setApiKey', { slot: 'compatible:custom', key: 'KEY-FOR-B', baseURL: 'https://b.example/v1' }]]);
      expect((await providerItem.getValue()).compatible?.baseURL).toBe('https://b.example/v1');
    });

    it('the saved address itself needs no new key', async () => {
      permission();
      keys['compatible:custom'] = 'KEY-FOR-A';
      await renderSection({ active: 'compatible', compatible: SAVED_A });
      await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
      type('Endpoint', 'https://b.example/v1');
      type('Endpoint', 'https://a.example/v1');
      await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
      await click('Save');
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved. EngLint now uses a.example.'));
    });
  });

  it('a saved custom endpoint lists the models of its saved address when the form opens', async () => {
    const CUSTOM: CompatibleConfig = { ...OPENAI, preset: 'custom', baseURL: 'https://llm.example.org/v1', structuredOutputs: false };
    keys['compatible:custom'] = 'sk-custom';
    await renderSection({ active: 'compatible', compatible: CUSTOM });
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    expect(calls('listModels')).toEqual([['listModels', { slot: 'compatible:custom', baseURL: 'https://llm.example.org/v1' }]]);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('Test saves, then shows which model answered', async () => {
    const request = permission();
    keys['compatible:openai'] = 'sk-open';
    await renderSection({ active: 'compatible', compatible: OPENAI });
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    await click('Test');
    expect(request).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Works: gpt-a answered.'));
    expect(calls('testKey')).toHaveLength(1);
  });

  it('Test names a model the endpoint doesn\'t know, and shows the status copy otherwise', async () => {
    permission();
    keys['compatible:openai'] = 'sk-open';
    tested = { ok: false, status: 'bad_response', model: 'gpt-a', modelNotFound: true };
    await renderSection({ active: 'compatible', compatible: OPENAI });
    await waitFor(() => expect(field(FAST).tagName).toBe('SELECT'));
    await click('Test');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Model not found: gpt-a.'));
    tested = { ok: false, status: 'key_invalid' };
    await click('Test');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Your API key was rejected. Check it in settings.'));
  });

  it('Remove key clears only the preset\'s slot', async () => {
    keys = { anthropic: 'sk-ant', 'compatible:openai': 'sk-open-2222' };
    await renderSection({ active: 'compatible', compatible: OPENAI });
    await waitFor(() => expect(screen.getByText('Key saved (ends in …2222)')).toBeTruthy());
    await click('Remove key');
    expect(calls('clearApiKey')).toEqual([['clearApiKey', { slot: 'compatible:openai' }]]);
    expect(keys).toEqual({ anthropic: 'sk-ant' });
  });
});
