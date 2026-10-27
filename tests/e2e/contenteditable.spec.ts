import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { type MockReply, paragraphsOf } from './mock-anthropic';

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
const A_APPLE: Issue = {
  ...HAS,
  original: 'a apple',
  replacement: 'an apple',
  before: 'I have',
  kind: 'article',
  reason: 'Use "an" before a vowel sound.',
};

const issuesFor =
  (pick: (text: string) => Issue[]) =>
  async (body: any): Promise<MockReply> => ({
    results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: pick(p.text) })),
  });

const hasCat = issuesFor((t) => (t.includes('I has a cat') ? [HAS] : []));
const sheGo = issuesFor((t) => (t.includes('She go home') ? [GO] : []));

const underlines = (page: Page) => page.locator('.englint-underline');
const errorUnderline = (page: Page) => page.locator('.englint-underline.error');
const card = (page: Page) => page.locator('.englint-card');

async function openPage(page: Page, pagesURL: string, query = ''): Promise<void> {
  await page.goto(`${pagesURL}/contenteditable.html${query}`);
}

/** Moves the real pointer onto the underline (it has pointer-events: none, so Playwright's hover() can't target it). */
async function pointAt(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function acceptFromCard(page: Page): Promise<void> {
  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();
  await page.locator('.englint-card-fix').click();
}

/** The viewport rect of `word` inside the editor `selector`, measured on the page's own DOM. */
async function wordRect(page: Page, selector: string, word: string, nth = 0) {
  return page.evaluate(
    ({ selector, word, nth }) => {
      const walker = document.createTreeWalker(document.querySelector(selector)!, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        for (let at = n.data.indexOf(word); at !== -1; at = n.data.indexOf(word, at + 1)) {
          if (seen++ < nth) continue;
          const range = document.createRange();
          range.setStart(n, at);
          range.setEnd(n, at + word.length);
          const r = range.getBoundingClientRect();
          return { left: r.left, right: r.right, bottom: r.bottom };
        }
      }
      throw new Error(`${word} not found in ${selector}`);
    },
    { selector, word, nth },
  );
}

/** The underline sits along the bottom of the word's own rect. */
async function expectUnderlineUnder(page: Page, selector: string, word: string, nth = 0): Promise<void> {
  const want = await wordRect(page, selector, word, nth);
  const box = (await errorUnderline(page).boundingBox())!;
  expect(Math.abs(box.x - want.left)).toBeLessThan(1);
  expect(Math.abs(box.x + box.width - want.right)).toBeLessThan(1);
  expect(Math.abs(box.y + box.height - want.bottom)).toBeLessThan(1);
}

async function tabEntries(sw: Worker): Promise<{ tabId: number; state: any }[]> {
  return sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('tab:'))
      .map(([k, state]) => ({ tabId: Number(k.slice('tab:'.length)), state }));
  });
}

/** The one tab's field that has issues: tab id, field id and the field's issues. */
async function fieldWithIssues(sw: Worker) {
  let found: { tabId: number; fieldId: string; issues: any[] } | undefined;
  await expect
    .poll(async () => {
      const [entry] = await tabEntries(sw);
      const fieldId = Object.keys(entry?.state.fields ?? {}).find((id) => entry!.state.fields[id].length > 0);
      found = fieldId ? { tabId: entry!.tabId, fieldId, issues: entry!.state.fields[fieldId] } : undefined;
      return !!found;
    })
    .toBe(true);
  return found!;
}

/** A panel/popup message to the top frame, in @webext-core/messaging's wire format. */
async function toContent(sw: Worker, tabId: number, type: string, data?: unknown): Promise<any> {
  return sw.evaluate(
    ({ tabId, type, data }) =>
      chrome.tabs.sendMessage(tabId, { id: Date.now(), type, data, timestamp: Date.now() }, { frameId: 0 }),
    { tabId, type, data },
  );
}

/** Accepts the field's first issue the way the panel does; the reply carries the adapter's own verdict. */
async function applyFirstFix(sw: Worker): Promise<any> {
  const f = await fieldWithIssues(sw);
  return toContent(sw, f.tabId, 'applyFix', { fieldId: f.fieldId, issueId: f.issues[0].id });
}

test('underline in contenteditable', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await page.locator('#ce').click();
  await page.keyboard.type('I has a cat.');

  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect(underlines(page)).toHaveCount(1);
  await expectUnderlineUnder(page, '#ce', 'has');
  expect(paragraphsOf(mock.requests[0]).map((p) => p.text)).toEqual(['I has a cat.']);
});

test('accept + undo', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  const ce = page.locator('#ce');
  await ce.click();
  await page.keyboard.type('I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  await acceptFromCard(page);
  await expect(ce).toHaveText('I have a cat.');
  await expect(ce).toBeFocused();
  await expect(card(page)).toBeHidden();
  await expect(underlines(page)).toHaveCount(0);

  await page.keyboard.press('Meta+Z');
  await expect(ce).toHaveText('I has a cat.');
});

test('offsets correct in the third paragraph', async ({ page, pagesURL, mock }) => {
  mock.respond(sheGo);
  await openPage(page, pagesURL);
  await page.locator('#three p').nth(2).click(); // attaching is enough: the first check needs no typing

  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect(underlines(page)).toHaveCount(1);
  expect(paragraphsOf(mock.requests[0]).map((p) => p.text)).toEqual([
    'First paragraph is fine.',
    'The second one too.',
    'She go home.',
  ]);
  await expectUnderlineUnder(page, '#three', 'go'); // the only "go" is in "She go home."

  await acceptFromCard(page);
  const ps = page.locator('#three p');
  await expect(ps.nth(2)).toHaveText('She goes home.');
  await expect(ps.nth(0)).toHaveText('First paragraph is fine.');
  await expect(page.locator('#three b')).toHaveText('fine');
  await expect(ps.nth(1)).toHaveText('The second one too.');
  await expect(underlines(page)).toHaveCount(0);
});

test('one session per editing host, even with focus inside it', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await page.locator('#chip').focus(); // a focusable element inside the host takes focus itself
  await expect(page.locator('#chip')).toBeFocused();

  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expectUnderlineUnder(page, '#nested', 'has');
  expect(mock.requests).toHaveLength(1);
  expect(paragraphsOf(mock.requests[0]).map((p) => p.text)).toEqual(['Outer text here.', 'I has a cat.']);
  const [entry] = await tabEntries(serviceWorker);
  const ids = Object.keys(entry!.state.frames);
  expect(ids).toHaveLength(1);
  expect(entry!.state.activeFieldId).toBe(ids[0]); // focus on the chip still counts as the host's
});

test('caret moving into an issue opens its card', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await page.locator('#ce').click();
  await page.keyboard.type('I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(400);
  await expect(card(page)).toBeHidden();

  await page.keyboard.press('Home'); // caret 0
  await expect(card(page)).toBeHidden();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); // caret 4: inside "has"
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.englint-card-fix')).toHaveText('have');
});

test('panel jumpTo selects the issue', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(sheGo);
  await openPage(page, pagesURL);
  await page.locator('#three p').nth(2).click();
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  const f = await fieldWithIssues(serviceWorker);
  await page.locator('#far').click(); // focus leaves the field
  await expect(page.locator('#three')).not.toBeFocused();

  await toContent(serviceWorker, f.tabId, 'jumpTo', { fieldId: f.fieldId, issueId: f.issues[0].id });
  await expect(page.locator('#three')).toBeFocused();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe('go');
  await expect(card(page)).toBeVisible();
});

test('an editor that applies the fix itself, later, gets it exactly once', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL, '?accept=beforeinput&delay=20');
  await page.locator('#model').click();
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  expect(await applyFirstFix(serviceWorker)).toEqual({ res: { ok: true } }); // confirmed, not given up on
  await expect(page.locator('#model')).toHaveText('I have a cat.');
  await expect(underlines(page)).toHaveCount(0);
  await page.waitForTimeout(300); // a stacked fallback would land by now
  expect(await page.evaluate(() => (window as unknown as { applied: number }).applied)).toBe(1);
  await expect(page.locator('#model')).toHaveText('I have a cat.');
});

test('an editor that only takes pastes gets the fix through paste', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL, '?accept=paste');
  await page.locator('#model').click();
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  expect(await applyFirstFix(serviceWorker)).toEqual({ res: { ok: true } });
  await expect(page.locator('#model')).toHaveText('I have a cat.');
  expect(await page.evaluate(() => (window as unknown as { applied: number }).applied)).toBe(1);
});

test('a fix no route can apply is copied to the clipboard instead', async ({ page, pagesURL, mock, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: pagesURL });
  mock.respond(hasCat);
  await openPage(page, pagesURL, '?accept=none');
  await page.locator('#model').click();
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  await acceptFromCard(page);
  await expect(page.locator('.englint-notice')).toHaveText("Couldn't apply here — copied to clipboard.");
  await expect(page.locator('#model')).toHaveText('I has a cat.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('have');
});

test('a slow editor that takes beforeinput gets the fix once, never a paste as well', async ({ page, pagesURL, mock, serviceWorker, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: pagesURL }); // so a failure would show
  mock.respond(hasCat);
  await openPage(page, pagesURL, '?accept=beforeinput,paste&delay=200');
  await page.locator('#model').click();
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  expect(await applyFirstFix(serviceWorker)).toEqual({ res: { ok: true } });
  await expect(page.locator('#model')).toHaveText('I have a cat.');
  await page.waitForTimeout(600); // a paste sent as well would land by now
  expect(await page.evaluate(() => (window as unknown as { applied: number }).applied)).toBe(1);
  await expect(page.locator('#model')).toHaveText('I have a cat.');
  await expect(page.locator('.englint-notice')).toBeHidden();
});

test('an issue spanning an NBSP is located, underlined and fixed', async ({ page, pagesURL, mock }) => {
  mock.respond(issuesFor((t) => (t.includes('apple') ? [A_APPLE] : [])));
  await openPage(page, pagesURL);
  await page.locator('#nbsp p').click();

  // Harper's own "a" shows first; Claude's answer then covers it with "a apple".
  await expect.poll(() => mock.responses, { timeout: 3000 }).toBe(1);
  expect(paragraphsOf(mock.requests[0]).map((p) => p.text)).toEqual(['I have a apple.']); // plain spaces reach the model
  await expect(async () => expectUnderlineUnder(page, '#nbsp', 'a\u00a0apple')).toPass({ timeout: 3000 });

  await acceptFromCard(page);
  await expect(page.locator('#nbsp')).toHaveText('I have an apple.');
  await expect(underlines(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.locator('.englint-notice')).toBeHidden();
});
