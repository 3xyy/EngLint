import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { tabIsOff } from '../../src/background/tab-site';
import { applyIssuesUpdate, setTabOff } from '../../src/background/tab-state';
import { disabledSitesItem } from '../../src/shared/settings';

const at = (url: string | null) => ({ tabUrl: async () => url });
beforeEach(() => fakeBrowser.reset());

describe('tabIsOff', () => {
  it('is true for a tab URL whose host is switched off, false otherwise', async () => {
    await disabledSitesItem.setValue(['example.com']);
    expect(await tabIsOff(1, at('https://example.com/a'))).toBe(true);
    expect(await tabIsOff(1, at('https://other.example/a'))).toBe(false);
  });
  it('falls back to the host the tab reported when its URL is hidden', async () => {
    await disabledSitesItem.setValue(['mail.example.com']);
    await applyIssuesUpdate(7, { fieldId: 'f', host: 'mail.example.com', mode: 'standard', status: 'ok', focused: true, issues: [] }, 0);
    expect(await tabIsOff(7, at(null))).toBe(true);
  });
  it('with no host at all, asks whether the tab said its site is off', async () => {
    expect(await tabIsOff(7, at(null))).toBe(false);
    await setTabOff(7, true);
    expect(await tabIsOff(7, at(null))).toBe(true);
  });
});
