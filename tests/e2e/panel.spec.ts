import type { Page, Worker } from '@playwright/test';
import { clarityOn, expect, getKey, recordStorageChanges, recordTabActivity, setKey, test } from './fixtures';
import {
  HAIKU,
  isCritique,
  isSynonyms,
  MADE_UP_URL,
  type MockReply,
  paragraphsOf,
  SEARCH_RESULTS,
  SONNET,
  toolsResponder,
  userText,
} from './mock-anthropic';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

type Issue = {
  original: string;
  replacement: string | null;
  before: string;
  category: string;
  severity: string;
  kind: string;
  reason: string;
};

const HAS: Issue = {
  original: 'has',
  replacement: 'have',
  before: 'I',
  category: 'grammar',
  severity: 'error',
  kind: 'subject_verb_agreement',
  reason: 'Use "have" with "I".',
};
const GO: Issue = { ...HAS, original: 'go', replacement: 'goes', before: 'She', reason: 'Use "goes" with "she".' };
const WORDY: Issue = {
  original: 'In order to',
  replacement: 'To',
  before: '',
  category: 'clarity',
  severity: 'suggestion',
  kind: 'wordy_phrase',
  reason: 'This opening is longer than it needs to be.',
};

const issuesFor =
  (pick: (text: string) => Issue[]) =>
  async (body: any): Promise<MockReply> => ({
    results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: pick(p.text) })),
  });

const hasCat = issuesFor((t) => (t.includes('I has a cat') ? [HAS] : []));
const three = issuesFor((t) => [
  ...(t.includes('I has a cat') ? [HAS] : []),
  ...(t.includes('She go home') ? [GO] : []),
  ...(t.includes('In order to') ? [WORDY] : []),
]);

async function typeInTextarea(page: Page, text: string): Promise<void> {
  await page.locator('#ta').click();
  await page.keyboard.type(text);
}

async function tabEntries(sw: Worker): Promise<{ tabId: number; state: any }[]> {
  return sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('tab:'))
      .map(([k, state]) => ({ tabId: Number(k.slice('tab:'.length)), state }));
  });
}

/** The page's tab id, once its field has issues (or just once it has a tab state). */
async function pageTab(sw: Worker, withIssues = true): Promise<number> {
  let tabId = -1;
  await expect
    .poll(async () => {
      const [entry] = await tabEntries(sw);
      const ok = entry && (!withIssues || Object.values<any[]>(entry.state.fields).some((f) => f.length > 0));
      if (ok) tabId = entry!.tabId;
      return !!ok;
    })
    .toBe(true);
  return tabId;
}

async function openPanel(page: Page, extensionId: string, tabId: number): Promise<Page> {
  const panel = await page.context().newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
  return panel;
}

test('panel lists issues for the active field', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  await clarityOn(serviceWorker);
  mock.respond(three);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.\nIn order to win, we practice.');
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));

  const errors = panel.getByRole('region', { name: 'Errors' });
  const suggestions = panel.getByRole('region', { name: 'Clarity' });
  await expect(errors.locator('.item')).toHaveCount(1);
  await expect(errors).not.toContainText('Correctness');
  await expect(errors).not.toContainText('Use "have" with "I".');
  await expect(errors.locator('.item-original, .item-reason, .item-category')).toHaveCount(0);
  await expect(errors.locator('.item-fix')).toHaveText('have');
  await expect(errors.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  await expect(suggestions.locator('.item')).toHaveCount(1);
  await expect(suggestions.locator('.item-fix')).toHaveText('To');
  await expect(suggestions.locator('.item-original, .item-reason, .item-category')).toHaveCount(0);
  await expect(panel.getByText('$0.00 of $25 this month')).toBeVisible();
  await expect(panel.locator('.banner')).toHaveCount(0);
});

test('clicking the fix in the panel accepts, clicking the item jumps, Dismiss dismisses', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(issuesFor((t) => [...(t.includes('I has a cat') ? [HAS] : []), ...(t.includes('She go home') ? [GO] : [])]));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.\nShe go home.');
  await expect(page.locator('.englint-underline')).toHaveCount(2, { timeout: 3000 });
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
  await expect(panel.locator('.item')).toHaveCount(2);

  // Clicking the item (not the fix) jumps to it in the page.
  await page.locator('#far').click();
  // Click the empty part of the fix row: outside both inner buttons.
  await panel.locator('.item', { hasText: 'have' }).locator('.item-fixrow').click({ position: { x: 280, y: 4 } });
  await expect(page.locator('#ta')).toBeFocused();
  expect(await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);

  await panel.locator('.item-fix', { hasText: 'have' }).click();
  await expect(page.locator('#ta')).toHaveValue('I have a cat.\nShe go home.');
  await expect(panel.locator('.item')).toHaveCount(1);

  await panel.getByRole('button', { name: 'Dismiss' }).click();
  await expect(panel.locator('.item')).toHaveCount(0);
  await expect(page.locator('#ta')).toHaveValue('I have a cat.\nShe go home.');
});

test('a fix the page rejects, clicked in the panel, says it was copied to the clipboard', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: pagesURL });
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  await expect(page.locator('.englint-underline')).toHaveCount(1, { timeout: 3000 });
  // Like a controlled input: the page puts its own value back after every edit.
  await page.evaluate(() => {
    const ta = document.querySelector('#ta') as HTMLTextAreaElement;
    ta.addEventListener('input', () => (ta.value = 'I has a cat.'));
  });
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
  await panel.locator('.item-fix', { hasText: 'have' }).click();
  await expect(panel.locator('.notice')).toHaveText("Couldn't apply here — copied to clipboard.");
  await expect(page.locator('#ta')).toHaveValue('I has a cat.');
});

const NOTE: Issue = { ...WORDY, original: 'very unique', replacement: null, before: 'The plan is', kind: 'redundancy' };
const sentenceReply = toolsResponder({
  variants: ['The plan is unique.', 'The plan stands alone.', 'No plan is like it.'],
  issues: (t) => (t.includes('very unique') ? [NOTE] : []),
});

test("a comment-only note is a Clarity item whose one button is 'Rewrite this sentence'; it opens the popover on that sentence", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  await clarityOn(serviceWorker);
  mock.respond(sentenceReply);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'First, hello there. The plan is very unique. Last one.');
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
  const suggestions = panel.getByRole('region', { name: 'Clarity' });
  await expect(suggestions.locator('.item')).toHaveCount(1);
  await expect(suggestions.locator('.item-fix')).toHaveCount(0);
  const rewrite = suggestions.getByRole('button', { name: 'Rewrite this sentence' });
  await expect(rewrite).toBeVisible();
  await expect(suggestions.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  await expect(suggestions.locator('.item-original, .item-reason, .item-category')).toHaveCount(0);

  await rewrite.click();
  await expect(page.locator('.englint-tools').getByRole('button', { name: /^Use version \d$/ }).first()).toBeVisible();
  const user = userText(sonnet(mock).at(-1));
  expect(user).toContain('<selection>\n"The plan is very unique."\n</selection>');
  expect(user).not.toContain('<selection>\n"First, hello');
});

test('Accept all errors never touches a comment-only note', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  await clarityOn(serviceWorker);
  mock.respond(
    toolsResponder({ issues: (t) => [...(t.includes('I has a cat') ? [HAS] : []), ...(t.includes('very unique') ? [NOTE] : [])] }),
  );
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.\nThe plan is very unique.');
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
  await expect(panel.locator('.item')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Accept all errors' }).click();
  await expect(page.locator('#ta')).toHaveValue('I have a cat.\nThe plan is very unique.');
  await expect(panel.getByRole('button', { name: 'Rewrite this sentence' })).toBeVisible();
});

test('panel items have a keyboard Go-to button and contextual names', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  await expect(page.locator('.englint-underline')).toHaveCount(1, { timeout: 3000 });
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
  await expect(panel.getByRole('button', { name: "Replace 'has' with 'have'" })).toHaveText('have');
  await expect(panel.getByRole('button', { name: "Dismiss 'has'" })).toHaveText('Dismiss');

  // No ARIA button may contain a real button (nested-interactive), and the item stays a list item.
  expect(await panel.locator('[role="button"] button, button button').count()).toBe(0);
  await expect(panel.locator('li.item')).toHaveCount(1);
  await expect(panel.locator('li.item')).not.toHaveAttribute('role', /.+/);

  const goto = panel.getByRole('button', { name: "Go to 'has'" });
  await expect(goto).toHaveAttribute('title', 'Show in text');
  for (const key of ['Enter', 'Space']) {
    await page.locator('#far').click();
    await goto.focus();
    await expect(goto).toBeFocused();
    await panel.keyboard.press(key);
    await expect(page.locator('#ta')).toBeFocused();
    expect(await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);
  }
});

test('Accept all errors applies errors only', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  await clarityOn(serviceWorker);
  mock.respond(three);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.\nShe go home.\nIn order to win, we practice.');
  await expect(page.locator('.englint-underline')).toHaveCount(3, { timeout: 3000 });
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
  await expect(panel.locator('.item')).toHaveCount(3);

  await panel.getByRole('button', { name: 'Accept all errors' }).click();
  await expect(page.locator('#ta')).toHaveValue('I have a cat.\nShe goes home.\nIn order to win, we practice.');
  await expect(panel.getByRole('region', { name: 'Errors' })).toHaveCount(0);
  const suggestions = panel.getByRole('region', { name: 'Clarity' });
  await expect(suggestions.locator('.item')).toHaveCount(1);
  await expect(suggestions.locator('.item-fix')).toHaveText('To');
});

test('Check everything rechecks without waiting for the pause', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'Hello.');
  await expect.poll(() => mock.requests.length).toBe(1);
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker, false));

  await page.locator('#ta').click();
  await page.keyboard.type(' I has a cat.');
  await panel.getByRole('button', { name: 'Check everything' }).click();
  await expect.poll(() => mock.requests.length, { timeout: 600, intervals: [25] }).toBe(2);
});

test('a non-ok status is visible in the panel, with a link to settings', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(async () => ({ status: 401 }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  await expect.poll(() => mock.requests.length).toBe(1);
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker, false));

  await expect(panel.locator('.banner')).toContainText('Your API key was rejected. Check it in settings.');
  await expect(panel.locator('.banner').getByRole('button', { name: 'Open settings' })).toBeVisible();
});

test('the panel survives a field whose frame is gone', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const tabId = await pageTab(serviceWorker);
  // Point the field at a frame that does not exist.
  await serviceWorker.evaluate(async (tabId) => {
    const key = `tab:${tabId}`;
    const state = (await chrome.storage.session.get(key))[key];
    const fieldId = Object.keys(state.fields)[0]!;
    await chrome.storage.session.set({ [key]: { ...state, frames: { [fieldId]: 9999 } } });
  }, tabId);
  const panel = await openPanel(page, extensionId, tabId);

  await panel.locator('.item-fix').click();
  await expect(panel.getByText("Couldn't reach that text box. Click into it and try again.")).toBeVisible();
  await expect(panel.locator('.item')).toHaveCount(1); // still alive
  await expect(page.locator('#ta')).toHaveValue('I has a cat.');
});

const NO_FIELD = 'Click into a text box to start checking.';

test("a jump within the page (replaceState, a new hash) keeps the panel's issues and page id; another page clears them", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(hasCat);
  const activity = await recordTabActivity(serviceWorker);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const tabId = await pageTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  await expect(panel.locator('.item')).toHaveCount(1);
  const { pageId } = (await tabEntries(serviceWorker))[0]!.state;

  await page.evaluate(() => history.replaceState(null, '', '#section-2'));
  await page.evaluate(() => {
    location.hash = 'x';
  });
  await expect.poll(() => activity.urls()).toContain(`${pagesURL}/textarea.html#x`);
  await page.waitForTimeout(300); // a clear for the jump would land by now
  await expect(panel.locator('.item')).toHaveCount(1);
  await expect(panel.getByText(NO_FIELD)).toHaveCount(0);
  expect((await tabEntries(serviceWorker)).map((e) => e.state.pageId)).toEqual([pageId]);

  await page.goto(`${pagesURL}/badge.html`);
  await expect(panel.getByText(NO_FIELD)).toBeVisible();
  await expect(panel.locator('.item')).toHaveCount(0);
  expect(await tabEntries(serviceWorker)).toEqual([]);
});

test('a reload starts a new page: the panel clears, and the next report has a new page id', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const tabId = await pageTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  await expect(panel.locator('.item')).toHaveCount(1);
  const { pageId } = (await tabEntries(serviceWorker))[0]!.state;

  await page.reload();
  await expect(panel.getByText(NO_FIELD)).toBeVisible();
  expect(await tabEntries(serviceWorker)).toEqual([]);
  await page.locator('#ta').fill('');
  await typeInTextarea(page, 'I has a cat.');
  await expect(panel.locator('.item')).toHaveCount(1);
  const after = (await tabEntries(serviceWorker))[0]!.state.pageId;
  expect(after).not.toBe(pageId);
});

test('a page where no EngLint script runs (about:blank) clears the panel', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const tabId = await pageTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  await expect(panel.locator('.item')).toHaveCount(1);

  await page.goto('about:blank'); // no content script, and Chrome shows the extension no URL for it
  await expect(panel.getByText(NO_FIELD)).toBeVisible();
  await expect(panel.locator('.item')).toHaveCount(0);
  expect(await tabEntries(serviceWorker)).toEqual([]);
});

test.describe('with the back/forward cache on', () => {
  test.use({ bfcache: true });

  test("Back to a page kept in the bfcache starts it again: the panel no longer shows the other page's issues", async ({
    page,
    pagesURL,
    mock,
    serviceWorker,
    extensionId,
  }) => {
    mock.respond(hasCat);
    await page.addInitScript(() =>
      addEventListener('pageshow', (e) => {
        if (e.persisted) (window as any).__restored = ((window as any).__restored ?? 0) + 1;
      }),
    );
    await page.goto(`${pagesURL}/textarea.html`);
    await typeInTextarea(page, 'I has a cat.');
    const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
    await expect(panel.locator('.item')).toHaveCount(1);

    await page.goto(`${pagesURL}/textarea.html?b`);
    await expect(panel.getByText(NO_FIELD)).toBeVisible();
    await typeInTextarea(page, 'I has a cat too.');
    await expect(panel.locator('.item')).toHaveCount(1);

    await page.goBack({ waitUntil: 'commit' });
    // The first page came back from the bfcache (not a new load), with its script still running.
    await expect.poll(() => page.evaluate(() => (window as any).__restored ?? 0)).toBe(1);
    await expect(panel.getByText(NO_FIELD)).toBeVisible();
    await expect(panel.locator('.item')).toHaveCount(0);
  });
});

test('a page with a frame announces itself once, from its top frame', async ({ page, pagesURL, serviceWorker }) => {
  const activity = await recordTabActivity(serviceWorker);
  await page.goto(`${pagesURL}/iframe.html`);
  // The frame's content script has started: it asked for the tab's top-level host.
  await expect.poll(async () => (await activity.messages()).some((m) => m.type === 'topHost' && m.frameId !== 0)).toBe(true);
  await page.waitForTimeout(300);
  const starts = (await activity.messages()).filter((m) => m.type === 'pageStarted');
  expect(starts.map((m) => m.frameId)).toEqual([0]);
});

test('Test key shows success with usage', async ({ page, extensionId, mock, serviceWorker }) => {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const key = page.getByLabel('Claude API key');
  await expect(key).toHaveAttribute('type', 'password');
  const changes = await recordStorageChanges(serviceWorker);
  await key.fill('  sk-test-wxyz  ');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Key saved (ends in …wxyz)')).toBeVisible();
  expect(await getKey(serviceWorker)).toBe('sk-test-wxyz'); // trimmed, in the background's own store
  // Never in chrome.storage, which content scripts can read and whose change events reach them.
  expect(JSON.stringify(await serviceWorker.evaluate(() => chrome.storage.local.get(null)))).not.toContain('sk-test-wxyz');
  expect(JSON.stringify(await changes.read())).not.toContain('sk-test-wxyz');
  await expect(key).toHaveValue(''); // the saved key is never shown back
  expect(await page.content()).not.toContain('sk-test');

  await page.getByRole('button', { name: 'Test key' }).click();
  await expect(page.getByText('Key works ✓ (100 input / 20 output tokens)')).toBeVisible();
  expect(mock.requests.length).toBe(1);
  await expect(page.getByText("Turn off Google Docs' own spell check: Tools → Spelling and grammar.")).toBeVisible();
});

test('Test key shows the status text on failure', async ({ page, extensionId, mock }) => {
  mock.respond(async () => ({ status: 401 }));
  await page.goto(`${chromeExt(extensionId)}/options.html`);
  await page.getByRole('button', { name: 'Test key' }).click();
  await expect(page.getByText('Your API key was rejected. Check it in settings.')).toBeVisible();
});

test('Test key on an account with no credit says so and links to billing', async ({ page, extensionId, mock }) => {
  mock.respond(async () => ({
    status: 400,
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  }));
  await page.goto(`${chromeExt(extensionId)}/options.html`);
  await page.getByRole('button', { name: 'Test key' }).click();
  await expect(page.getByText('Your Claude account is out of API credit. Add credit in the Claude Console.')).toBeVisible();
  const link = page.getByRole('link', { name: 'Open billing' });
  await expect(link).toHaveAttribute('href', 'https://platform.claude.com/settings/billing');
  await expect(link).toHaveAttribute('target', '_blank');
});

test('a check on an account with no credit shows the $ badge and the billing banner', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(async () => ({ status: 400, message: 'Your credit balance is too low to access the Anthropic API.' }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const tabId = await pageTab(serviceWorker, false);
  await expect.poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('$');
  const popup = await page.context().newPage();
  await popup.goto(`${chromeExt(extensionId)}/popup.html?tabId=${tabId}`);
  await expect(popup.locator('.banner')).toContainText('Your Claude account is out of API credit.');
  await expect(popup.locator('.banner').getByRole('link', { name: 'Open billing' })).toHaveAttribute(
    'href',
    'https://platform.claude.com/settings/billing',
  );
});

test('options save the cap and dialect', async ({ page, extensionId, serviceWorker }) => {
  await page.goto(`${chromeExt(extensionId)}/options.html`);
  await page.getByLabel('Monthly limit (USD)').fill('12');
  await page.getByLabel('Dialect').selectOption('en-GB');
  await expect
    .poll(() =>
      serviceWorker.evaluate(() => chrome.storage.local.get(['capUsd', 'dialect'])),
    )
    .toEqual({
      capUsd: 12,
      dialect: 'en-GB',
    });
});

test('options has no Clarity notes switch any more; the family switches write both modes and casual stays off', async ({ page, extensionId, serviceWorker }) => {
  await page.goto(`${chromeExt(extensionId)}/options.html`);
  await expect(page.getByLabel('Essay sites')).toHaveCount(0);
  await expect(page.getByLabel(/Clarity notes/)).toHaveCount(0);
  const toggle = page.getByLabel('Clarity', { exact: true });
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toBeChecked(); // default: on in Essay and Standard
  const read = async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('suggestionFamiliesByMode'))).suggestionFamiliesByMode;
  await toggle.click();
  await expect.poll(async () => [(await read())?.essay.clarity, (await read())?.standard.clarity]).toEqual([false, false]);
  expect((await read()).casual.clarity).toBe(false);
  await toggle.click();
  await expect.poll(async () => [(await read())?.essay.clarity, (await read())?.standard.clarity]).toEqual([true, true]);
  expect((await read()).casual.clarity).toBe(false); // casual stays off
});

const chromeExt = (id: string) => `chrome-extension://${id}`;

test('popup toggle disables the site', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  await expect.poll(() => mock.requests.length).toBe(1);
  const popup = await page.context().newPage();
  await popup.goto(`${chromeExt(extensionId)}/popup.html?tabId=${await pageTab(serviceWorker)}`);
  await expect(popup.getByText('127.0.0.1')).toBeVisible();
  const toggle = popup.getByLabel('EngLint on this site');
  await expect(toggle).toBeChecked();

  await toggle.click();
  await expect
    .poll(() => serviceWorker.evaluate(() => chrome.storage.local.get('disabledSites')))
    .toEqual({ disabledSites: ['127.0.0.1'] });
  const tabId = await pageTab(serviceWorker, false);
  await expect.poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('off');

  await page.bringToFront();
  await page.locator('#ta').click();
  await page.keyboard.type(' She go home.');
  await page.waitForTimeout(2500); // past the 1 s debounce
  expect(mock.requests.length).toBe(1);
});

test("the popup's switch sets the off badge even on a page with no content script running", async ({
  page,
  pagesURL,
  serviceWorker,
  extensionId,
}) => {
  // The fake docs list: the generic script is kept off it and the Docs script stops there (not the editor).
  await page.goto(`${pagesURL}/document/u/0/index.html`);
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);
  const badge = () => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  const popup = await page.context().newPage();
  await popup.goto(`${chromeExt(extensionId)}/popup.html?tabId=${tabId}`);
  const toggle = popup.getByLabel('EngLint on this site');
  await toggle.click();
  await expect.poll(badge).toBe('off');
  await toggle.click();
  await expect.poll(badge).toBe('');
});

test('popup has no mode control', async ({ page, pagesURL, serviceWorker, extensionId }) => {
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'Hello.');
  const popup = await page.context().newPage();
  await popup.goto(`${chromeExt(extensionId)}/popup.html?tabId=${await pageTab(serviceWorker, false)}`);
  await expect(popup.getByRole('button', { name: 'Open panel' })).toBeVisible();
  await expect(popup.getByText('$0.00 of $25 this month')).toBeVisible();
  await expect(popup.getByLabel('Mode')).toHaveCount(0);
  await expect(popup.locator('select')).toHaveCount(0);
  await expect(popup.getByText(/mode/i)).toHaveCount(0);
});

test('options never contain the saved key, before or after Save', async ({ page, extensionId, serviceWorker }) => {
  const SEEDED = 'sk-test-abcdefghijkl';
  await setKey(serviceWorker, SEEDED);
  await page.goto(`${chromeExt(extensionId)}/options.html`);
  await expect(page.getByText('Key saved (ends in …ijkl)')).toBeVisible();
  expect(await page.content()).not.toContain(SEEDED);
  expect(await page.content()).not.toContain('abcdefghijk');

  const NEW = 'sk-test-zyxwvutsrqpo';
  await page.getByLabel('Claude API key').fill(NEW);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Key saved (ends in …qrpo'.replace('qrpo', 'rqpo') + ')')).toBeVisible();
  expect(await page.content()).not.toContain(NEW);
  expect(await page.content()).not.toContain(SEEDED);
});

test('Remove key clears the saved key', async ({ page, extensionId, serviceWorker }) => {
  await page.goto(`${chromeExt(extensionId)}/options.html`);
  await expect(page.getByText('Key saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByText('No key saved yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove key' })).toHaveCount(0);
  expect(await getKey(serviceWorker)).toBeNull();
});

test('an open panel follows a key saved in options', async ({ page, context, serviceWorker, extensionId }) => {
  await setKey(serviceWorker, null);
  await page.goto(`${chromeExt(extensionId)}/sidepanel.html?tabId=424242`);
  await expect(page.locator('.banner')).toContainText('Add your Claude API key to start checking.');

  const options = await context.newPage();
  await options.goto(`${chromeExt(extensionId)}/options.html`);
  await options.getByLabel('Claude API key').fill('sk-test-abcdefghijkl');
  await options.getByRole('button', { name: 'Save' }).click();
  await expect(options.getByText('Key saved (ends in …ijkl)')).toBeVisible();
  await expect(page.locator('.banner')).toHaveCount(0); // refreshed by the key-change stamp, not a reload
});

test('a key an older build kept in storage.local moves to the key store when the worker starts', async ({
  page,
  context,
  serviceWorker,
  extensionId,
}) => {
  const LEGACY = 'sk-test-legacy-abcdefgh';
  await setKey(serviceWorker, null);
  await serviceWorker.evaluate((k) => chrome.storage.local.set({ apiKey: k, capUsd: 7 }), LEGACY);
  // Stop the worker; the options page's keyStatus message starts a fresh one, which migrates first.
  await page.goto('about:blank');
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.goto(`${chromeExt(extensionId)}/options.html`);
  await expect(page.getByText('Key saved (ends in …efgh)')).toBeVisible();

  const local = await page.evaluate(() => (globalThis as any).chrome.storage.local.get(null));
  expect(local).toEqual({ capUsd: 7 });
  const worker = context.serviceWorkers().at(-1)!;
  expect(await getKey(worker)).toBe(LEGACY);
});

test('short key never shows a suffix', async ({ page, extensionId }) => {
  await page.goto(`${chromeExt(extensionId)}/options.html`); // the harness key is `sk-test` (7 characters)
  await expect(page.getByText('Key saved', { exact: true })).toBeVisible();
  await expect(page.getByText('ends in')).toHaveCount(0);
});

test('popup shows key_missing banner with no key', async ({ page, pagesURL, serviceWorker, extensionId }) => {
  await page.goto(`${pagesURL}/textarea.html`); // nothing typed: no check, so no tab state says key_missing
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);
  await setKey(serviceWorker, null);
  const popup = await page.context().newPage();
  await popup.goto(`${chromeExt(extensionId)}/popup.html?tabId=${tabId}`);
  await expect(popup.locator('.banner')).toContainText('Add your Claude API key to start checking.');
  await expect(popup.getByText('Ready. EngLint checks')).toHaveCount(0);
});

test('popup with a key and nothing checked says Ready', async ({ page, pagesURL, serviceWorker, extensionId }) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);
  const popup = await page.context().newPage();
  await popup.goto(`${chromeExt(extensionId)}/popup.html?tabId=${tabId}`);
  await expect(popup.getByText('Ready. EngLint checks text boxes as you type.')).toBeVisible();
  await expect(popup.locator('.banner')).toHaveCount(0);
});

test('popup shows paused_cap before any check once the cap is reached', async ({ page, pagesURL, serviceWorker, extensionId }) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ capUsd: 1 }));
  const popup = await page.context().newPage();
  await popup.goto(`${chromeExt(extensionId)}/popup.html?tabId=${tabId}`);
  await expect(popup.getByText('$0.00 of $1 this month')).toBeVisible();
  await serviceWorker.evaluate(() => chrome.storage.local.set({ capUsd: 0 }));
  await expect(popup.locator('.banner')).toContainText('Monthly limit reached ($0.00 of $0). Live checks are paused.');
});

test('panel shows key_missing banner with no tab state', async ({ page, serviceWorker, extensionId }) => {
  await setKey(serviceWorker, null);
  await page.goto(`${chromeExt(extensionId)}/sidepanel.html?tabId=424242`);
  await expect(page.locator('.banner')).toContainText('Add your Claude API key to start checking.');
  await expect(page.locator('.banner').getByRole('button', { name: 'Open settings' })).toBeVisible();
});

// ---- the panel's Tools (text no field holds: canvas apps, page text, Docs in fallback) ----

const activeTab = (sw: Worker) => sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);

/** What the background writes for the panel after a menu click or the shortcut (`session:tools:<tabId>`). */
const stashFor = (sw: Worker, tabId: number, stash: { text: string; request?: object }) =>
  sw.evaluate(([tabId, stash]) => chrome.storage.session.set({ [`tools:${tabId}`]: { ...stash, at: Date.now() } }), [tabId, stash] as const);

const sonnet = (mock: { requests: any[] }) => mock.requests.filter((r) => r.model === SONNET);

/** The panel page records what Copy writes (the side panel's clipboard can't be read back here). */
const recordCopies = (panel: Page) =>
  panel.evaluate(() => {
    const w = window as any;
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => void w.__copied.push(text) },
      configurable: true,
    });
  });

test('the panel shows Issues, Tools, Chat and Review as tabs: Issues first, a fresh stash shows Tools, and the arrow keys move between them', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder());
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  const tab = (name: string) => panel.getByRole('tab', { name });
  await expect(panel.getByRole('tab')).toHaveText(['Issues', 'Tools', 'Chat', 'Review']);
  await expect(tab('Issues')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Click into a text box to start checking.')).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Tools' })).toHaveCount(0); // hidden
  await expect(panel.getByRole('region', { name: 'Chat' })).toHaveCount(0);

  await tab('Issues').focus();
  await panel.keyboard.press('ArrowRight');
  await expect(tab('Tools')).toBeFocused();
  await expect(tab('Tools')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('region', { name: 'Tools' })).toBeVisible();
  await expect(panel.getByText('Click into a text box to start checking.')).toBeHidden();
  await panel.keyboard.press('ArrowRight');
  await expect(tab('Chat')).toBeFocused();
  await expect(panel.getByRole('region', { name: 'Chat' })).toBeVisible();
  await panel.keyboard.press('End');
  await expect(tab('Review')).toBeFocused();
  await expect(panel.getByRole('region', { name: 'Review' })).toBeVisible();
  await panel.keyboard.press('ArrowRight'); // wraps round
  await expect(tab('Issues')).toBeFocused();
  await panel.keyboard.press('ArrowLeft');
  await expect(tab('Review')).toHaveAttribute('aria-selected', 'true');

  await stashFor(serviceWorker, tabId, { text: 'I has a cat.' });
  await expect(tab('Tools')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('region', { name: 'Tools' }).getByLabel('Paste or select text')).toHaveValue('I has a cat.');
});

test("the panel's Tools take the stashed text, run its request (Shorter), and offer Copy on each version", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder({ variants: ['I have a cat.', 'I own a cat.', 'A cat is mine.'] }));
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  await stashFor(serviceWorker, tabId, { text: 'I has a cat.', request: { kind: 'preset', presetId: 'shorter' } });
  const panel = await openPanel(page, extensionId, tabId);
  const tools = panel.getByRole('region', { name: 'Tools' });

  await expect(tools.getByLabel('Paste or select text')).toHaveValue('I has a cat.');
  await expect(tools.getByRole('button', { name: /^Copy version \d$/ })).toHaveCount(3);
  expect(sonnet(mock)).toHaveLength(1);
  const user = userText(sonnet(mock)[0]);
  expect(user).toContain('<before>\n""\n</before>'); // no field: no context around it
  expect(user).toContain('<selection>\n"I has a cat."\n</selection>');
  expect(user).toContain('Make this shorter.');
  // Each version shows as a diff against the text; there's no field to apply to, so Copy only.
  const second = tools.locator('.tools-result').nth(1);
  await expect(second.locator('del')).toHaveText('has');
  await expect(second.locator('ins')).toHaveText('own');
  // "has" then "own" with no space at the joint: a visible gap keeps them apart.
  const joint = await second.locator('del + ins').evaluate((ins) => ({
    gap: ins.getBoundingClientRect().left - ins.previousElementSibling!.getBoundingClientRect().right,
    margin: parseFloat(getComputedStyle(ins).marginInlineStart),
  }));
  expect(joint.margin).toBeGreaterThan(0);
  expect(joint.gap).toBeGreaterThanOrEqual(2);
  await expect(tools.getByRole('button', { name: /^Use / })).toHaveCount(0);

  await recordCopies(panel);
  await tools.getByRole('button', { name: 'Copy version 2' }).click();
  expect(await panel.evaluate(() => (window as any).__copied)).toEqual(['I own a cat.']);
  await expect(tools.getByRole('button', { name: 'Copy version 2' })).toHaveText('Copied');

  // The stash's request runs once: reopening the panel keeps the text and sends nothing.
  await panel.reload();
  await expect(panel.getByLabel('Paste or select text')).toHaveValue('I has a cat.');
  await panel.waitForTimeout(500);
  expect(sonnet(mock)).toHaveLength(1);
});

test("the panel's Tools on an Essay site ask for the critique first, then Show 3 rewrites", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ siteModes: { '127.0.0.1': 'essay' } }));
  mock.respond(
    toolsResponder({
      variants: ['I have a cat.', 'I own a cat.', 'A cat is mine.'],
      critique: { weakness: 'The verb does not agree with "I".', light_fix: 'I have a cat.' },
    }),
  );
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  await stashFor(serviceWorker, tabId, { text: 'I has a cat.' }); // no request: nothing runs by itself
  const panel = await openPanel(page, extensionId, tabId);
  const tools = panel.getByRole('region', { name: 'Tools' });
  await expect(tools.getByLabel('Paste or select text')).toHaveValue('I has a cat.');
  await panel.waitForTimeout(300);
  expect(sonnet(mock)).toHaveLength(0);

  await tools.getByRole('button', { name: 'Rewrite', exact: true }).click();
  await expect(tools.getByText('The verb does not agree with "I".')).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Copy this version' })).toBeVisible();
  await expect(tools.getByRole('button', { name: /^Copy version/ })).toHaveCount(0);
  expect(sonnet(mock).map(isCritique)).toEqual([true]);

  await tools.getByRole('button', { name: 'Show 3 rewrites' }).click();
  await expect(tools.getByRole('button', { name: /^Copy version \d$/ })).toHaveCount(3);
  expect(sonnet(mock).map(isCritique)).toEqual([true, false]);
});

test("the panel's Tools offer Expand on a Standard site, and not on an Essay site (where a stashed Expand shows the notice)", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder({ variants: ['I have a cat.', 'I own a cat.', 'A cat is mine.'] }));
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  await panel.getByRole('tab', { name: 'Tools' }).click();
  const tools = panel.getByRole('region', { name: 'Tools' });
  for (const name of ['More confident', 'Friendlier', 'More casual', 'Simpler', 'Expand', 'Sound like me']) {
    await expect(tools.getByRole('button', { name, exact: true })).toBeVisible();
  }

  await serviceWorker.evaluate(() => chrome.storage.local.set({ siteModes: { '127.0.0.1': 'essay' } }));
  await expect(tools.getByRole('button', { name: 'Expand', exact: true })).toHaveCount(0);
  await expect(tools.getByRole('button', { name: 'Simpler', exact: true })).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Sound like me', exact: true })).toBeVisible();

  await stashFor(serviceWorker, tabId, { text: 'I has a cat.', request: { kind: 'preset', presetId: 'expand' } });
  await expect(tools.getByRole('alert')).toHaveText("Expand isn't offered for essays.");
  expect(sonnet(mock)).toHaveLength(0);
});

test("the panel's Synonyms run for 1 to 4 words only, with Copy on each option", async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(toolsResponder({ options: [{ text: 'large', nuance: 'neutral' }, { text: 'huge', nuance: 'much bigger' }] }));
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  await panel.getByRole('tab', { name: 'Tools' }).click();
  const tools = panel.getByRole('region', { name: 'Tools' });
  const box = tools.getByLabel('Paste or select text');
  const synonyms = tools.getByRole('button', { name: 'Synonyms', exact: true });
  await expect(synonyms).toBeDisabled(); // nothing pasted yet
  await box.fill('one two three four five');
  await expect(synonyms).toBeDisabled();
  await box.fill(' big ');
  await expect(synonyms).toBeEnabled();
  await synonyms.click();
  await expect(tools.getByRole('button', { name: /^Copy "/ })).toHaveCount(2);
  await expect(tools.getByText('much bigger')).toBeVisible();
  const asked = mock.requests.filter((r) => r.model === HAIKU && isSynonyms(r));
  expect(asked).toHaveLength(1);
  expect(userText(asked[0])).toContain('"target":"big"');

  await recordCopies(panel);
  await tools.getByRole('button', { name: 'Copy "huge"' }).click();
  expect(await panel.evaluate(() => (window as any).__copied)).toEqual(['huge']);
});

test("the panel's Tools say when the text is too long, and show a failed request in the tools wording", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(async (body) => (body.model === SONNET ? { variants: [] } : toolsResponder()(body)));
  await page.goto(`${pagesURL}/textarea.html`);
  const panel = await openPanel(page, extensionId, await activeTab(serviceWorker));
  await panel.getByRole('tab', { name: 'Tools' }).click();
  const tools = panel.getByRole('region', { name: 'Tools' });
  const box = tools.getByLabel('Paste or select text');
  await box.fill('word '.repeat(420).trim()); // 2,099 characters
  await expect(tools.getByText('Select up to about 2,000 characters.')).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Shorter', exact: true })).toBeDisabled();

  await box.fill('I has a cat.');
  await expect(tools.getByText('Select up to about 2,000 characters.')).toHaveCount(0);
  await tools.getByRole('button', { name: 'Shorter', exact: true }).click();
  await expect(tools.getByRole('alert')).toHaveText("Couldn't get a usable answer from Claude. Try again.");

  // The custom box sends its instruction outside the selection data.
  const custom = tools.getByPlaceholder('Or tell EngLint what to do…');
  await custom.fill('make it vivid');
  await custom.press('Enter');
  await expect.poll(() => sonnet(mock).length).toBe(2);
  expect(userText(sonnet(mock)[1])).toContain('<instruction>\nmake it vivid\n</instruction>');
});

test('a stash that arrives while the panel is open fills the text and runs its request once', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder({ variants: ['I have a cat.', 'I own a cat.', 'A cat is mine.'] }));
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  await panel.getByRole('tab', { name: 'Tools' }).click();
  const tools = panel.getByRole('region', { name: 'Tools' });
  await tools.getByLabel('Paste or select text').fill('my own draft');
  await stashFor(serviceWorker, tabId, { text: 'I has a cat.', request: { kind: 'preset', presetId: 'rewrite' } }); // a menu click
  await expect(tools.getByLabel('Paste or select text')).toHaveValue('I has a cat.');
  await expect(tools.getByRole('button', { name: /^Copy version \d$/ })).toHaveCount(3);
  await panel.waitForTimeout(300);
  expect(sonnet(mock)).toHaveLength(1);
});

test("a stashed request the panel finds late only fills the text: it isn't sent", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder());
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  await serviceWorker.evaluate(
    (tabId) =>
      chrome.storage.session.set({
        [`tools:${tabId}`]: { text: 'I has a cat.', request: { kind: 'preset', presetId: 'shorter' }, at: Date.now() - 60_000 },
      }),
    tabId,
  );
  const panel = await openPanel(page, extensionId, tabId);
  await expect(panel.getByLabel('Paste or select text')).toHaveValue('I has a cat.');
  await expect(panel.getByRole('tab', { name: 'Issues' })).toHaveAttribute('aria-selected', 'true'); // not brought forward
  await panel.waitForTimeout(500);
  expect(sonnet(mock)).toHaveLength(0);
});

test('a stashed Synonyms request on more than 4 words fills the text and sends nothing (as the button)', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder());
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  await stashFor(serviceWorker, tabId, { text: 'one two three four five', request: { kind: 'synonyms' } });
  const panel = await openPanel(page, extensionId, tabId);
  await expect(panel.getByLabel('Paste or select text')).toHaveValue('one two three four five');
  await panel.waitForTimeout(500);
  expect(mock.requests.filter(isSynonyms)).toHaveLength(0);
  await expect(panel.getByRole('button', { name: 'Synonyms', exact: true })).toBeDisabled();
});

test('a stash over the limit while an answer is on its way leaves that answer to arrive (no stuck loading)', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  let answer!: () => void;
  const released = new Promise<void>((resolve) => (answer = resolve));
  const reply = toolsResponder({ variants: ['I have a cat.', 'I own a cat.', 'A cat is mine.'] });
  mock.respond(async (body) => {
    if (body.model === SONNET) await released;
    return reply(body);
  });
  await page.goto(`${pagesURL}/textarea.html`);
  const tabId = await activeTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  const tools = panel.getByRole('region', { name: 'Tools' });
  await stashFor(serviceWorker, tabId, { text: 'I has a cat.', request: { kind: 'preset', presetId: 'shorter' } });
  await expect(tools.locator('.tools-loading')).toHaveText('Rewriting…');
  await stashFor(serviceWorker, tabId, { text: 'word '.repeat(420).trim(), request: { kind: 'preset', presetId: 'shorter' } });
  await expect(tools.getByText('Select up to about 2,000 characters.')).toBeVisible();
  answer();
  await expect(tools.getByRole('button', { name: /^Copy version \d$/ })).toHaveCount(3);
  expect(sonnet(mock)).toHaveLength(1);
});

const VAGUE: Issue = { original: 'very good', replacement: null, before: 'It is', category: 'engagement', severity: 'suggestion', kind: 'vague_word', reason: 'r' };
const CHAIRMAN: Issue = { original: 'chairman', replacement: 'chair', before: 'Ask the', category: 'delivery', severity: 'suggestion', kind: 'inclusive_language', reason: 'r' };
const TESTAMENT: Issue = { original: 'stands as a testament to', replacement: 'shows', before: 'The bridge', category: 'delivery', severity: 'suggestion', kind: 'generic_phrasing', reason: 'r' };

test('panel groups Errors, Clarity, Engagement and Delivery with counts; generic phrasing sits under Delivery; empty groups are hidden', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      suggestionFamiliesByMode: {
        essay: { clarity: true, engagement: true, delivery: true, generic: true },
        standard: { clarity: true, engagement: true, delivery: true, generic: true },
        casual: { clarity: false, engagement: false, delivery: false, generic: false },
      },
    }),
  );
  mock.respond(
    issuesFor((t) => [
      ...(t.includes('I has a cat') ? [HAS] : []),
      ...(t.includes('In order to') ? [WORDY] : []),
      ...(t.includes('very good') ? [VAGUE] : []),
      ...(t.includes('chairman') ? [CHAIRMAN] : []),
      ...(t.includes('testament') ? [TESTAMENT] : []),
    ]),
  );
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.\nIn order to win, we practice.\nIt is very good.\nAsk the chairman first.\nThe bridge stands as a testament to their skill.');
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker));
  await expect(panel.locator('.item')).toHaveCount(5);
  await expect(panel.locator('section.group > h2')).toHaveText(['Errors (1)', 'Clarity (1)', 'Engagement (1)', 'Delivery (2)']);
  await expect(panel.getByRole('region', { name: 'Delivery (2)' }).locator('.item')).toHaveCount(2);
  await expect(panel.getByRole('region', { name: /Suggestions/ })).toHaveCount(0);

  await panel.getByRole('button', { name: 'Accept all errors' }).click();
  await expect(panel.getByRole('region', { name: /^Errors/ })).toHaveCount(0); // an empty group is hidden
  await expect(panel.locator('section.group > h2')).toHaveText(['Clarity (1)', 'Engagement (1)', 'Delivery (2)']);
});

test("the Review tab shows the text's word count, and revealText selects a quoted passage in the textarea", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder({ tones: ['earnest', 'plain'], issues: (t) => (t.includes('I has a cat') ? [HAS] : []) }));
  await page.goto(`${pagesURL}/textarea.html`);
  const filler = Array.from({ length: 53 }, (_, i) => `word${i}`).join(' ');
  await typeInTextarea(page, `I has a cat. She runs home. ${filler}.`);
  const tabId = await pageTab(serviceWorker);
  const panel = await openPanel(page, extensionId, tabId);
  await panel.getByRole('tab', { name: 'Review' }).click();
  const review = panel.getByRole('region', { name: 'Review' });
  await expect(review.locator('.stat').filter({ has: panel.getByText('Words', { exact: true }) }).locator('dd')).toHaveText('60');
  await expect(review.locator('.stat').filter({ has: panel.getByText('Sentences', { exact: true }) }).locator('dd')).toHaveText('3');
  await expect(review.locator('.tone-line')).toHaveText('Tone: earnest, plain', { timeout: 20_000 });
  expect(mock.requests.some((b: any) => JSON.stringify(b.system ?? '').includes('tn-1'))).toBe(true);

  const { state } = (await tabEntries(serviceWorker))[0]!;
  const fieldId = state.activeFieldId ?? Object.keys(state.fields)[0];
  const reveal = (quote: string) =>
    serviceWorker.evaluate(
      ([tabId, fieldId, quote]) =>
        chrome.tabs.sendMessage(tabId, { id: Date.now(), type: 'revealText', data: { fieldId, quote }, timestamp: Date.now() }, { frameId: 0 }),
      [tabId, fieldId, quote] as const,
    );
  const selection = () => page.locator('#ta').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);

  expect(await reveal('She runs')).toMatchObject({ res: { found: true } });
  expect(await selection()).toEqual([13, 21]);
  expect(await reveal('a dog')).toMatchObject({ res: { found: false } });
  expect(await selection()).toEqual([13, 21]);
});

test('Reader reactions from the Review tab show the cost, and a quoted passage selects its place in the textarea', async ({
  page,
  pagesURL,
  mock,
  extensionId,
  serviceWorker,
}) => {
  mock.respond(
    toolsResponder({
      readers: {
        first_impression: 'A plain, friendly start.',
        remember: ['The short sentences'],
        questions: ['What happens next?'],
        lost: [{ quote: 'a dragon in the sky', why: 'Not here.' }],
        strength: { quote: 'She runs home', why: 'It moves.' },
      },
    }),
  );
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'The rain stopped. She runs home. Then the street was quiet again.');
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker, false));
  await panel.getByRole('tab', { name: 'Review' }).click();
  const card = panel.getByRole('region', { name: 'Reader reactions' });
  await expect(card.getByRole('button', { name: 'Get reactions · about $0.02' })).toBeVisible();
  await card.getByRole('button', { name: /^Get reactions/ }).click();
  await expect(card.getByText('A plain, friendly start.')).toBeVisible();
  expect(mock.requests.some((b: any) => JSON.stringify(b.system ?? '').includes('rr-1'))).toBe(true);
  await expect(card.getByRole('button', { name: /a dragon/ })).toHaveCount(0);

  await card.getByRole('button', { name: /She runs home/ }).click();
  await expect
    .poll(() => page.locator('#ta').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([18, 31]);
});

test('Deep check from the Review tab lists a seeded typo, and Apply fixes it in the textarea', async ({
  page,
  pagesURL,
  mock,
  extensionId,
  serviceWorker,
}) => {
  mock.respond(
    toolsResponder({
      deep: {
        issues: (text) =>
          text.includes('recieved')
            ? [{ original: 'recieved', replacement: 'received', before: 'She', kind: 'spelling', category: 'spelling', severity: 'error', reason: 'Misspelled.' }]
            : [],
        notes: [{ type: 'overused_word', text: 'You lean on "the".', quotes: ['the news'], count: 6 }],
      },
    }),
  );
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'The rain stopped. She recieved the news. Then the street was quiet again.');
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker, false));
  await panel.getByRole('tab', { name: 'Review' }).click();
  const card = panel.getByRole('region', { name: 'Deep check' });
  await expect(card.getByRole('button', { name: /^Check the whole text · about \$0\.\d\d$/ })).toBeVisible();
  await card.getByRole('button', { name: /^Check the whole text/ }).click();
  await expect(card.getByText('Issues (1)')).toBeVisible();
  await expect(card.getByText('About the whole text')).toBeVisible();
  await expect(card.getByText(/used 6 times/)).toBeVisible();
  expect(mock.requests.some((b: any) => JSON.stringify(b.system ?? '').includes('dc-1'))).toBe(true);

  await card.getByRole('button', { name: 'Apply fix 1' }).click();
  await expect(card.getByRole('button', { name: 'Fix 1 applied' })).toBeVisible();
  await expect(page.locator('#ta')).toHaveValue('The rain stopped. She received the news. Then the street was quiet again.');
});

test('the Citation finder finds sources for a claim selected in the textarea, shows only pages the search returned, and bills the searches', async ({
  page,
  pagesURL,
  mock,
  extensionId,
  serviceWorker,
}) => {
  mock.respond(toolsResponder());
  await page.goto(`${pagesURL}/textarea.html`);
  const claim = 'Sleep helps people remember what they learned.';
  const lead = 'The rain stopped. ';
  await typeInTextarea(page, `${lead}${claim} Then the street was quiet again.`);
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement, [a, b]) => el.setSelectionRange(a, b), [lead.length, lead.length + claim.length] as const);
  const panel = await openPanel(page, extensionId, await pageTab(serviceWorker, false));
  await panel.getByRole('tab', { name: 'Review' }).click();
  const card = panel.getByRole('region', { name: 'Citation finder' });
  const spent = async () => Object.values<number>((await serviceWorker.evaluate(() => chrome.storage.local.get('spend'))).spend ?? {}).reduce((a, b) => a + b, 0);
  const before = await spent();

  const find = card.getByRole('button', { name: /^Find sources · about \$0\.\d\d$/ });
  await expect(find).toBeEnabled();
  await find.click();
  await expect(card.getByRole('link', { name: SEARCH_RESULTS[0].title })).toBeVisible();
  await expect(card.getByRole('link', { name: SEARCH_RESULTS[1].title })).toBeVisible();
  await expect(card.getByRole('link')).toHaveCount(2);
  await expect(card.getByRole('link', { name: SEARCH_RESULTS[0].title })).toHaveAttribute('href', SEARCH_RESULTS[0].url);
  await expect(
    card.getByText(/^“Sleep and Memory Consolidation\.” example\.org, 30 Apr\. 2025, www\.example\.org\/sleep-memory\. Accessed \d{1,2} [A-Z][a-z]+\.? \d{4}\.$/),
  ).toBeVisible();
  expect(await card.innerHTML()).not.toContain(MADE_UP_URL);

  const sent = mock.requests.find((b: any) => JSON.stringify(b.system ?? '').includes('cf-1'));
  expect(sent.model).toBe(SONNET);
  expect(sent.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] }]);
  expect(sent.output_config?.format).toBeUndefined();
  expect(userText(sent)).toContain(`<claim>\n${JSON.stringify(claim)}\n</claim>`);
  // 100 input and 20 output tokens on Sonnet, plus 2 searches at $0.01.
  await expect.poll(async () => (await spent()) - before).toBeGreaterThanOrEqual(0.0204 - 1e-9);
  expect((await spent()) - before).toBeLessThan(0.021);
});
