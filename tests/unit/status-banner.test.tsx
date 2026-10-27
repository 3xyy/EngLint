import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { PRESETS } from '../../src/core/provider';
import { providerItem } from '../../src/shared/settings';
import { StatusBanner } from '../../src/shared/ui/StatusBanner';

afterEach(() => {
  cleanup();
  fakeBrowser.reset();
});

describe('StatusBanner', () => {
  it('out of credit links to the Console billing page in a new tab', () => {
    const { container, getByRole } = render(<StatusBanner status="out_of_credit" />);
    expect(container.textContent).toContain('Your Claude account is out of API credit. Add credit in the Claude Console.');
    const link = getByRole('link', { name: 'Open billing' });
    expect(link.getAttribute('href')).toBe('https://platform.claude.com/settings/billing');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('button')).toBeNull(); // no "Open settings": the key is fine
  });

  it('other statuses have no billing link', () => {
    const { container } = render(<StatusBanner status="key_invalid" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('Open settings');
  });

  it('names the saved provider, and a local server that refuses is not told its key was rejected', async () => {
    await providerItem.setValue({
      active: 'compatible',
      compatible: { preset: 'ollama', baseURL: PRESETS.ollama.baseURL, fastModel: 'llama', smartModel: 'llama', structuredOutputs: false, prices: {} },
    });
    render(<StatusBanner status="key_invalid" />);
    expect(await screen.findByText(/Ollama refused the request\. Check that it accepts requests from browser extensions\./)).toBeTruthy();
    expect(screen.queryByText(/API key was rejected/)).toBeNull();
  });
});
