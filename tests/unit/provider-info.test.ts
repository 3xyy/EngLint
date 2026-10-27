import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { PRESETS } from '../../src/core/provider';
import { providerItem } from '../../src/shared/settings';

beforeEach(() => {
  fakeBrowser.reset();
  vi.resetModules(); // the content side keeps what it read in module state
});

describe('providerInfoNow (content scripts)', () => {
  it('is Claude until the settings are read, then the saved provider, kept current', async () => {
    await providerItem.setValue({
      active: 'compatible',
      compatible: { preset: 'lmstudio', baseURL: PRESETS.lmstudio.baseURL, fastModel: 'm', smartModel: 'm', structuredOutputs: false, prices: {} },
    });
    const { providerInfoNow } = await import('../../src/content/provider-info');
    expect(providerInfoNow()).toEqual({ name: 'Claude', keyless: false });
    await vi.waitFor(() => expect(providerInfoNow()).toEqual({ name: 'LM Studio', keyless: true }));
    await providerItem.setValue({ active: 'anthropic', compatible: null });
    await vi.waitFor(() => expect(providerInfoNow()).toEqual({ name: 'Claude', keyless: false }));
  });
});
