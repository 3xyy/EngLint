import type { Page, Worker } from '@playwright/test';
import { expect, test as base } from './fixtures';
import { paragraphsOf } from './mock-anthropic';
import { compatResponder, type CompatRequest, startMockCompatible } from './mock-compatible';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

const COMPAT_PORT = 4011;
const FAST = 'mock-fast';
const SMART = 'mock-smart';
const SENTENCE = 'I has a cat and she go home.';

const issue = (original: string, replacement: string, before: string) => ({
  original,
  replacement,
  before,
  category: 'grammar',
  severity: 'error',
  kind: 'subject_verb_agreement',
  reason: `Use "${replacement}" here.`,
});
// Each endpoint flags a different word, so the underline shows which one answered.
const HAS = issue('has', 'have', 'I');
const GO = issue('go', 'goes', 'she');

const test = base.extend<{ compat: { readonly requests: CompatRequest[] } }>({
  compat: async ({}, use) => {
    const server = await startMockCompatible(COMPAT_PORT, [FAST, SMART], compatResponder({
      fast: FAST,
      smart: SMART,
      issues: (text) => (text.includes('I has a cat') ? [HAS] : []),
      variants: ['have a cat', 'own a cat', 'have one cat'],
    }));
    await use({
      get requests() {
        return server.requests;
      },
    });
    await server.close();
  },
});

const optionsUrl = (id: string) => `chrome-extension://${id}/options.html`;
const underlines = (page: Page) => page.locator('.englint-underline.error');
const popover = (page: Page) => page.locator('.englint-tools');

/** The originals of every issue the background holds for the page's tab. */
async function flagged(sw: Worker): Promise<string[]> {
  return sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('tab:'))
      .flatMap(([, state]: [string, any]) => Object.values<any[]>(state.fields).flat().map((i) => i.original as string));
  });
}

async function tabOf(sw: Worker, url: string): Promise<number> {
  return sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id as number, url);
}

async function typeSentence(page: Page, pagesURL: string): Promise<void> {
  await page.goto(`${pagesURL}/textarea.html`);
  await page.locator('#ta').click();
  await page.keyboard.type(SENTENCE);
}

test('a custom endpoint answers live checks and rewrites, the Citation finder hides, and Claude answers again after switching back', async ({
  page,
  context,
  pagesURL,
  mock,
  compat,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(async (body) => ({ results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: p.text.includes('she go home') ? [GO] : [] })) }));

  // Settings: a custom endpoint, its key, then the two models it lists.
  const options = await context.newPage();
  // Records what Save asks Chrome for (the e2e build already holds http://127.0.0.1/*, so Chrome says yes at once).
  await options.addInitScript(() => {
    const c = (globalThis as any).chrome;
    const request = c.permissions.request.bind(c.permissions);
    (globalThis as any).__asked = [];
    c.permissions.request = (p: unknown) => {
      (globalThis as any).__asked.push(p);
      return request(p);
    };
  });
  await options.goto(optionsUrl(extensionId));
  await options.getByLabel('Provider', { exact: true }).selectOption({ label: 'Custom endpoint' });
  await options.getByLabel('Endpoint', { exact: true }).fill(`http://127.0.0.1:${COMPAT_PORT}/v1`);
  await options.getByLabel('API key', { exact: true }).fill('test-key-e2e');
  // Typing the address asks it for nothing, however long the writer pauses: the list waits for the click.
  await options.waitForTimeout(1000);
  expect(compat.requests.filter((r) => r.path === '/v1/models')).toHaveLength(0);
  await options.getByRole('button', { name: 'Load models', exact: true }).click();
  await expect(options.getByRole('status')).toHaveText('Choose a fast model and a smart model, then click Save.');
  await expect(options.getByText('No key saved yet.')).toBeVisible(); // the typed key listed the models; Save stores it
  const fast = options.getByLabel('Fast model (live checks, synonyms, tone)');
  await expect(fast.locator('option')).toHaveText(['Choose a model', FAST, SMART]);
  expect(compat.requests.find((r) => r.path === '/v1/models')?.authorization).toBe('Bearer test-key-e2e');
  await fast.selectOption(FAST);
  await options.getByLabel('Smart model (rewrites, reviews, chat)').selectOption(SMART);
  await options.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(options.getByRole('status')).toHaveText(`Saved. EngLint now uses 127.0.0.1:${COMPAT_PORT}.`); // Chrome allowed the endpoint
  await expect(options.getByText('Key saved (ends in …-e2e)')).toBeVisible();
  const pattern = { origins: [`http://127.0.0.1:${COMPAT_PORT}/*`] };
  expect(await options.evaluate(() => (globalThis as any).__asked)).toEqual([pattern, pattern]); // each click asks
  expect((await serviceWorker.evaluate(() => chrome.storage.local.get('provider'))).provider).toMatchObject({
    active: 'compatible',
    compatible: { preset: 'custom', baseURL: `http://127.0.0.1:${COMPAT_PORT}/v1`, fastModel: FAST, smartModel: SMART },
  });

  // A flagged sentence is underlined from the compatible endpoint, asked with the saved key.
  await typeSentence(page, pagesURL);
  await expect(underlines(page)).toHaveCount(1, { timeout: 5000 });
  await expect.poll(() => flagged(serviceWorker)).toEqual(['has']);
  const check = compat.requests.find((r) => r.body?.model === FAST);
  expect(check?.authorization).toBe('Bearer test-key-e2e');
  expect(mock.requests).toHaveLength(0);

  // A Rewrite returns the smart model's versions.
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 11)); // "has a cat"
  await page.locator('.englint-select-btn').click();
  await popover(page).getByRole('button', { name: 'Rewrite', exact: true }).click();
  await expect(popover(page).getByRole('button', { name: /^Use version \d$/ })).toHaveCount(3);
  expect(compat.requests.some((r) => r.body?.model === SMART)).toBe(true);
  await page.keyboard.press('Escape');

  // The side panel's Review tab has no Citation finder off Claude.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${await tabOf(serviceWorker, `${pagesURL}/textarea.html`)}`);
  await panel.getByRole('tab', { name: 'Review' }).click();
  await expect(panel.getByRole('region', { name: 'Deep check' })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Citation finder' })).toHaveCount(0);
  await panel.close();

  // Back to Claude: the same sentence is checked again, by the Anthropic mock (results never cross providers).
  await options.getByLabel('Provider', { exact: true }).selectOption({ label: 'Claude (recommended)' });
  await expect(options.getByLabel('Claude API key')).toBeVisible();
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('provider'))).provider.active).toBe('anthropic');
  const compatChecks = compat.requests.length;
  await typeSentence(page, pagesURL);
  await expect(underlines(page)).toHaveCount(1, { timeout: 5000 });
  await expect.poll(() => flagged(serviceWorker)).toEqual(['go']);
  expect(mock.requests.length).toBeGreaterThan(0);
  expect(compat.requests).toHaveLength(compatChecks);
});
