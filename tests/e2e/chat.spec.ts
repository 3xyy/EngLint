import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { chatMessage, isChat, toolsResponder } from './mock-anthropic';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

const EMPTY = 'Ask anything about this text. In essays, EngLint coaches rather than writes.';
const NO_FIELD = 'Click into a text box or document, then ask.';

/** The tab id of the page whose field has reported (its tab state exists). */
async function pageTab(sw: Worker): Promise<number> {
  let tabId = -1;
  await expect
    .poll(async () => {
      const all = await sw.evaluate(() => chrome.storage.session.get(null));
      const key = Object.keys(all).find((k) => k.startsWith('tab:') && Object.keys(all[k].fields ?? {}).length > 0);
      if (key) tabId = Number(key.slice('tab:'.length));
      return !!key;
    })
    .toBe(true);
  return tabId;
}

const activeTab = (sw: Worker) => sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);

/** The keys of the tab's stored chats. */
const chatKeys = (sw: Worker, tabId: number) =>
  sw.evaluate(async (tabId) => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith(`chat:${tabId}:`)), tabId);

async function openChat(page: Page, extensionId: string, tabId: number): Promise<Page> {
  const panel = await page.context().newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
  await panel.getByRole('tab', { name: 'Chat' }).click();
  return panel;
}

const chatRegion = (panel: Page) => panel.getByRole('region', { name: 'Chat' });
const chatBox = (panel: Page) => chatRegion(panel).getByPlaceholder('Ask about your writing…');

async function typeInTextarea(page: Page, text: string): Promise<void> {
  await page.locator('#ta').click();
  await page.keyboard.type(text);
}

async function ask(panel: Page, message: string): Promise<void> {
  const box = chatBox(panel);
  await expect(box).toBeEnabled();
  await box.fill(message);
  await box.press('Enter');
}

test('the Chat streams its answer about the focused text; Apply changes the field and Cmd+Z restores it', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(
    toolsResponder({
      chat: { chunks: ['Use "have" ', 'with "I".', '\n@@EDITS@@\n', '[{"original":"I has","replacement":"I have"}]'], delayMs: 300 },
    }),
  );
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const panel = await openChat(page, extensionId, await pageTab(serviceWorker));
  const chat = chatRegion(panel);
  await expect(chat.getByText(EMPTY)).toBeVisible();

  // Every text the answer shows on its way, in order.
  await panel.evaluate(() => {
    const w = window as any;
    w.__seen = [];
    new MutationObserver(() => {
      const live = document.querySelector('[data-testid="chat-live"]');
      const text = live?.textContent ?? null;
      if (text !== null && w.__seen.at(-1) !== text) w.__seen.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await ask(panel, 'Is the grammar right?');
  await expect(chatBox(panel)).toBeDisabled();
  await expect(chat.getByRole('button', { name: 'Apply edit 1' })).toBeVisible();
  await expect(chatBox(panel)).toBeEnabled();
  await expect(chat.getByText('Use "have" with "I".')).toBeVisible();
  const seen: string[] = await panel.evaluate(() => (window as any).__seen);
  expect(seen).toContain('Use "have"'); // the first piece, alone
  expect(seen.join('\n')).not.toContain('@@');
  await expect(chat).not.toContainText('@@EDITS@@');

  const asked = mock.requests.filter(isChat);
  expect(asked).toHaveLength(1);
  expect(chatMessage(asked[0])).toBe('Is the grammar right?');
  expect(JSON.stringify(asked[0].system)).toContain('I has a cat.');

  await chat.getByRole('button', { name: 'Apply edit 1' }).click();
  await expect(page.locator('#ta')).toHaveValue('I have a cat.');
  await expect(chat.getByRole('button', { name: 'Apply edit 1' })).toHaveText('Applied');
  await page.bringToFront();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#ta')).toHaveValue('I has a cat.');
});

test('an edit whose original appears twice shows Copy; Apply on text changed since the answer says so and writes nothing', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  const edits = [
    { original: 'the cat', replacement: 'the dog' },
    { original: 'I saw', replacement: 'I spotted' },
  ];
  mock.respond(toolsResponder({ chat: { chunks: [`Two ideas.\n@@EDITS@@\n${JSON.stringify(edits)}`] } }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I saw the cat. Then the cat left.');
  const panel = await openChat(page, extensionId, await pageTab(serviceWorker));
  const chat = chatRegion(panel);
  await ask(panel, 'Any changes?');

  await expect(chat.getByRole('button', { name: 'Copy edit 1' })).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Apply edit 1' })).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Apply edit 2' })).toBeVisible();

  // The writer changes "I saw" in the page before applying.
  await page.locator('#ta').fill('We saw the cat. Then the cat left.');
  await chat.getByRole('button', { name: 'Apply edit 2' }).click();
  await expect(chat.getByText('The text changed. Ask again.')).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Copy edit 2' })).toBeVisible();
  await expect(page.locator('#ta')).toHaveValue('We saw the cat. Then the cat left.');
});

test('a stream that breaks mid-answer leaves the partial text with a status line, and keeps nothing', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder({ chat: { chunks: ['Part of an ', 'answer'], closeEarly: true } }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const tabId = await pageTab(serviceWorker);
  const panel = await openChat(page, extensionId, tabId);
  const chat = chatRegion(panel);
  await ask(panel, 'Is this clear?');

  await expect(chat.getByText("Can't reach Claude. Check your connection.")).toBeVisible();
  await expect(chat).toContainText('Part of an answer');
  await expect(chatBox(panel)).toBeEnabled();
  expect(await chatKeys(serviceWorker, tabId)).toEqual([]);
});

test('reloading the page ends its chat: nothing stored, and the panel shows none', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(toolsResponder({ chat: { chunks: ['It reads clearly.'] } }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I has a cat.');
  const tabId = await pageTab(serviceWorker);
  const panel = await openChat(page, extensionId, tabId);
  const chat = chatRegion(panel);
  await ask(panel, 'Is this clear?');
  await expect(chat.getByText('It reads clearly.')).toBeVisible();
  expect(await chatKeys(serviceWorker, tabId)).toHaveLength(1);

  await page.reload();
  await expect.poll(() => chatKeys(serviceWorker, tabId)).toEqual([]);
  await expect(chat.getByText(NO_FIELD)).toBeVisible();
  await typeInTextarea(page, 'I has a dog.');
  await expect(chat.getByText(EMPTY)).toBeVisible();
  await expect(chat).not.toContainText('Is this clear?');
  await expect(chat).not.toContainText('It reads clearly.');
});

test("New chat on a second text box leaves the first box's answer streaming: it is kept and shown on coming back", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(toolsResponder({ chat: { chunks: ['About ', 'the ', 'first ', 'box ', 'only.'], delayMs: 600 } }));
  await page.goto(`${pagesURL}/badge.html`);
  await page.locator('#ta').click();
  await page.keyboard.type('The first box.');
  const tabId = await pageTab(serviceWorker);
  const panel = await openChat(page, extensionId, tabId);
  const chat = chatRegion(panel);
  await ask(panel, 'About the first?');
  await expect(chat).toContainText('About');

  await page.locator('#grip').click(); // the panel follows the second box
  await page.keyboard.type('The second box.');
  const elsewhere = chat.getByText('Answering about another text box…');
  await expect(elsewhere).toBeVisible();
  await expect(chatBox(panel)).toBeDisabled();
  await expect(chat).not.toContainText('About the first?');
  await chat.getByRole('button', { name: 'New chat' }).click();

  await expect(elsewhere).toHaveCount(0, { timeout: 10_000 }); // the first box's answer finished
  await expect(chatBox(panel)).toBeEnabled();
  const stored = await serviceWorker.evaluate(
    async (tabId) => Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith(`chat:${tabId}:`)),
    tabId,
  );
  expect(stored).toHaveLength(1);
  expect((stored[0]![1] as { text: string }[]).map((t) => t.text)).toEqual(['About the first?', 'About the first box only.']);

  await page.locator('#ta').click(); // back to the first box
  await expect(chat).toContainText('About the first?');
  await expect(chat).toContainText('About the first box only.');
});

test('with no focused field the Chat says where to click, and asks nothing', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(toolsResponder());
  await page.goto(`${pagesURL}/textarea.html`);
  const panel = await openChat(page, extensionId, await activeTab(serviceWorker));
  const chat = chatRegion(panel);
  await expect(chat.getByText(NO_FIELD)).toBeVisible();
  await expect(chatBox(panel)).toBeDisabled();
  await expect(chat.getByRole('button', { name: 'New chat' })).toBeDisabled();
  expect(mock.requests.filter(isChat)).toHaveLength(0);
});
