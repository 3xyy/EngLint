import { readFileSync } from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { expect, setKey, test } from './fixtures';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

const ext = (id: string) => `chrome-extension://${id}`;
const optionsUrl = (id: string) => `${ext(id)}/options.html`;

/** Runs `act`, then resolves with the options.html page that is open afterwards (the popup may close itself). */
async function optionsTabOpenedBy(context: BrowserContext, id: string, act: () => Promise<void>): Promise<Page> {
  await act();
  let found: Page | undefined;
  await expect
    .poll(() => {
      found = context.pages().find((p) => p.url() === optionsUrl(id));
      return !!found;
    })
    .toBe(true);
  return found!;
}

test('the built manifest opens options in a full tab', () => {
  const manifest = JSON.parse(readFileSync('.output-e2e/chrome-mv3/manifest.json', 'utf8'));
  expect(manifest.options_ui.page).toBe('options.html');
  expect(manifest.options_ui.open_in_tab).toBe(true);
});

test("popup shows Settings on a page EngLint can't run on", async ({ page, extensionId, context }) => {
  // No ?tabId: the popup's own tab is a chrome-extension:// page, which EngLint can't run on.
  await page.goto(`${ext(extensionId)}/popup.html`);
  await expect(page.getByText("EngLint can't run on this page")).toBeVisible();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  const opened = await optionsTabOpenedBy(context, extensionId, () => settings.click());
  expect(opened.url()).toBe(optionsUrl(extensionId));
});

async function pageTabId(sw: Worker): Promise<number> {
  return sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);
}

test('popup key_missing shows Add your API key button that opens options', async ({ page, pagesURL, serviceWorker, extensionId, context }) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await pageTabId(serviceWorker);
  await setKey(serviceWorker, null);
  const popup = await context.newPage();
  await popup.goto(`${ext(extensionId)}/popup.html?tabId=${tabId}`);
  await expect(popup.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Open settings' })).toHaveCount(0); // one main control, not three
  const add = popup.getByRole('button', { name: 'Add your API key' });
  await expect(add).toBeVisible();
  const opened = await optionsTabOpenedBy(context, extensionId, () => add.click());
  expect(opened.url()).toBe(optionsUrl(extensionId));
});

test('popup with a key still has Settings but no Add your API key button', async ({ page, pagesURL, serviceWorker, extensionId, context }) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await pageTabId(serviceWorker);
  const popup = await context.newPage();
  await popup.goto(`${ext(extensionId)}/popup.html?tabId=${tabId}`);
  await expect(popup.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Add your API key' })).toHaveCount(0);
});

test('options focuses the key input when no key is saved', async ({ page, serviceWorker, extensionId }) => {
  await setKey(serviceWorker, null);
  await page.goto(optionsUrl(extensionId));
  await expect(page.getByLabel('Claude API key')).toBeFocused();
  const steps = page.getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveText('Get a key at platform.claude.com → API keys');
  await expect(steps.nth(1)).toHaveText('Paste it here and click Save');
  await expect(steps.nth(2)).toHaveText('Click Test key');
  const link = page.getByRole('link', { name: 'platform.claude.com' });
  await expect(link).toHaveAttribute('href', 'https://platform.claude.com/settings/keys');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // the key section comes first, under the AI provider
  const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
  expect(headings[0]).toBe('AI provider');
  await expect(page.getByRole('heading', { level: 3, name: 'Claude API key' })).toBeVisible();
});

test('options with a saved key shows no onboarding hint and no autofocus', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await expect(page.getByText('Key saved', { exact: true })).toBeVisible();
  await expect(page.getByText('Paste it here and click Save')).toHaveCount(0);
  await expect(page.getByLabel('Claude API key')).not.toBeFocused();
});

for (const mode of ['never resolves', 'rejects'] as const) {
  test(`popup still shows Settings when keyStatus ${mode}`, async ({ page, pagesURL, serviceWorker, extensionId, context }) => {
    await page.goto(`${pagesURL}/textarea.html`);
    const tabId = await pageTabId(serviceWorker);
    const popup = await context.newPage();
    await popup.addInitScript((m) => {
      const c = (globalThis as any).chrome;
      const orig = c.runtime.sendMessage.bind(c.runtime);
      // @webext-core/messaging calls sendMessage(msg, callback): never calling back = a sleeping background;
      // calling back with nothing = "No response".
      c.runtime.sendMessage = (msg: any, cb: any, ...rest: any[]) => {
        if (msg?.type !== 'keyStatus') return orig(msg, cb, ...rest);
        if (m === 'rejects') cb(undefined);
      };
    }, mode);
    await popup.goto(`${ext(extensionId)}/popup.html?tabId=${tabId}`);
    const settings = popup.getByRole('button', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    if (mode === 'rejects') await expect(popup.getByText("Couldn't reach EngLint's background. Try reopening the popup.")).toBeVisible();
    const opened = await optionsTabOpenedBy(context, extensionId, () => settings.click());
    expect(opened.url()).toBe(optionsUrl(extensionId));
  });
}

test('popup still shows Settings while the tab lookup is pending', async ({ page, pagesURL, serviceWorker, extensionId, context }) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await pageTabId(serviceWorker);
  const popup = await context.newPage();
  await popup.addInitScript(() => {
    (globalThis as any).chrome.tabs.get = () => new Promise(() => {}); // never answers
  });
  await popup.goto(`${ext(extensionId)}/popup.html?tabId=${tabId}`);
  await expect(popup.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});
