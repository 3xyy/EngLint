import { expect, recordStorageChanges, test } from './fixtures';
import { isStyleProfile, toolsResponder, userText } from './mock-anthropic';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

const optionsUrl = (id: string) => `chrome-extension://${id}/options.html`;

test('four family switches replace Clarity notes; Engagement off writes essay and standard, casual stays off', async ({
  page,
  extensionId,
  serviceWorker,
}) => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      suggestionFamiliesByMode: {
        essay: { clarity: true, engagement: true, delivery: true, generic: false },
        standard: { clarity: true, engagement: true, delivery: false, generic: false },
        casual: { clarity: false, engagement: false, delivery: false, generic: false },
      },
    }),
  );
  await page.goto(optionsUrl(extensionId));
  await expect(page.getByLabel('Clarity notes')).toHaveCount(0);
  for (const name of ['Clarity', 'Engagement', 'Delivery', 'Generic phrasing']) {
    await expect(page.getByLabel(name, { exact: true })).toHaveCount(1);
  }
  const engagement = page.getByLabel('Engagement', { exact: true });
  await expect(engagement).toBeChecked();
  await engagement.click();
  await expect
    .poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('suggestionFamiliesByMode'))).suggestionFamiliesByMode)
    .toEqual({
      essay: { clarity: true, engagement: false, delivery: true, generic: false },
      standard: { clarity: true, engagement: false, delivery: false, generic: false },
      casual: { clarity: false, engagement: false, delivery: false, generic: false },
    });
  await expect(engagement).not.toBeChecked();
  const legacy = await serviceWorker.evaluate(() => chrome.storage.local.get('clarityByMode'));
  expect(legacy).toEqual({}); // nothing writes the old setting any more
});

test('with the shipped defaults Clarity reads on and Engagement and Delivery read mixed, "Essays only"; a click turns one on in both modes, a second click off in both', async ({
  page,
  extensionId,
  serviceWorker,
}) => {
  await page.goto(optionsUrl(extensionId));
  const engagement = page.getByLabel('Engagement', { exact: true });
  const delivery = page.getByLabel('Delivery', { exact: true });
  for (const toggle of [engagement, delivery]) {
    await expect(toggle).toHaveJSProperty('indeterminate', true);
    await expect(toggle).toHaveJSProperty('checked', false);
    await expect(toggle).toHaveAccessibleDescription('Essays only');
  }
  await expect(page.getByLabel('Clarity', { exact: true })).toHaveJSProperty('indeterminate', false);
  await expect(page.getByLabel('Clarity', { exact: true })).toBeChecked();

  const read = async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('suggestionFamiliesByMode'))).suggestionFamiliesByMode;
  await engagement.click();
  await expect.poll(async () => [(await read())?.essay.engagement, (await read())?.standard.engagement]).toEqual([true, true]);
  await expect(engagement).toHaveJSProperty('indeterminate', false);
  await expect(engagement).toBeChecked();
  await expect(page.getByText('Essays only')).toHaveCount(1); // Delivery's
  await engagement.click();
  await expect.poll(async () => [(await read())?.essay.engagement, (await read())?.standard.engagement]).toEqual([false, false]);
  await expect(engagement).toHaveJSProperty('indeterminate', false);
  await expect(engagement).not.toBeChecked();
  expect((await read()).casual.engagement).toBe(false);
});

const LOCAL_CHECKS_HELP = "Underlines from EngLint's built-in checker appear as you type and work without the API.";

test('"Instant local checks" sits with the suggestion switches, on by default with its help line; unchecking stores false', async ({
  page,
  extensionId,
  serviceWorker,
}) => {
  await page.goto(optionsUrl(extensionId));
  const suggestions = page.getByRole('region', { name: 'Suggestions' });
  const local = suggestions.getByLabel('Instant local checks', { exact: true });
  await expect(local).toBeChecked();
  await expect(local).toHaveAccessibleDescription(LOCAL_CHECKS_HELP);
  await expect(suggestions.getByText(LOCAL_CHECKS_HELP)).toBeVisible();
  await local.click();
  await expect.poll(() => serviceWorker.evaluate(() => chrome.storage.local.get('localChecks'))).toEqual({ localChecks: false });
  await expect(local).not.toBeChecked();
});

test("the side panel's Settings show the same switch, on by default, and unchecking it stores false", async ({
  page,
  extensionId,
  serviceWorker,
}) => {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=424242`);
  const settings = page.locator('details.panel-settings');
  await settings.locator('summary').click();
  const local = settings.getByLabel('Instant local checks', { exact: true });
  await expect(local).toBeChecked();
  await expect(local).toHaveAccessibleDescription(LOCAL_CHECKS_HELP);
  await expect(settings.getByLabel('Generic phrasing', { exact: true })).toBeVisible(); // next to the family switches
  await local.click();
  await expect.poll(() => serviceWorker.evaluate(() => chrome.storage.local.get('localChecks'))).toEqual({ localChecks: false });
});

test('the dialect select offers five English dialects and saves the choice', async ({ page, extensionId, serviceWorker }) => {
  await page.goto(optionsUrl(extensionId));
  const select = page.getByLabel('Dialect');
  await expect(select.locator('option')).toHaveText([
    'English (US)',
    'English (UK)',
    'English (Canada)',
    'English (Australia)',
    'English (India)',
  ]);
  await select.selectOption('en-IN');
  await expect.poll(() => serviceWorker.evaluate(() => chrome.storage.local.get('dialect'))).toEqual({ dialect: 'en-IN' });
});

test('Your rules lists a rule and a word, and Remove deletes each', async ({ page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ rules: [{ mode: 'essay', kind: 'wordy_phrase' }], dictionary: ['kubernetes'] }),
  );
  await page.goto(optionsUrl(extensionId));
  const rules = page.getByRole('region', { name: 'Your rules' });
  await expect(rules).toContainText('wordy phrases in essays');
  await expect(rules).toContainText('kubernetes');
  await rules.getByRole('button', { name: /^Remove wordy phrases/ }).click();
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('rules'))).rules).toEqual([]);
  await rules.getByRole('button', { name: /^Remove .kubernetes/ }).click();
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('dictionary'))).dictionary).toEqual([]);
  await expect(rules).toContainText('Nothing here yet. Use “Stop suggesting” or “Add to dictionary” on a card.');
});

test('Your writing style: paste pieces, build, see the profile, edit and save; only the profile is stored', async ({
  page,
  extensionId,
  serviceWorker,
  mock,
}) => {
  mock.respond(toolsResponder({ styleProfile: { profile: 'Short, plain sentences. Leans on concrete nouns.' } }));
  const changes = await recordStorageChanges(serviceWorker);
  await page.goto(optionsUrl(extensionId));
  const section = page.getByRole('region', { name: 'Your writing style' });
  const pieces = 'The harbour woke slowly, and I watched it from the pier. '.repeat(8);
  await section.getByLabel('Your writing (one to three pieces)').fill(pieces);
  await expect(section.getByRole('button', { name: /^Build my style profile · (under|about) / })).toBeEnabled();
  await section.getByRole('button', { name: /^Build my style profile/ }).click();

  const box = section.getByLabel('How you write (edit freely)');
  await expect(box).toHaveValue('Short, plain sentences. Leans on concrete nouns.');
  const request = mock.requests.find(isStyleProfile);
  expect(request.model).toBe('claude-sonnet-5-5');
  expect(userText(request)).toContain('harbour woke slowly');
  await expect(section.getByLabel('Your writing (one to three pieces)')).toHaveValue('');

  await box.fill('Short, plain sentences. Dry humour.');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('status')).toHaveText('Profile saved.');
  await expect
    .poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('styleProfile'))).styleProfile?.text)
    .toBe('Short, plain sentences. Dry humour.');
  expect(JSON.stringify(await changes.read())).not.toContain('harbour');
  expect(JSON.stringify(await serviceWorker.evaluate(() => chrome.storage.local.get(null)))).not.toContain('harbour');

  await page.reload();
  await expect(page.getByLabel('How you write (edit freely)')).toHaveValue('Short, plain sentences. Dry humour.');
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('styleProfile'))).styleProfile ?? null).toBeNull();
  await expect(page.getByLabel('How you write (edit freely)')).toHaveCount(0);
});
