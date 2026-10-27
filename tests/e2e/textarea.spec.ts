import type { Page, Worker } from '@playwright/test';
import { clarityOn, expect, test } from './fixtures';
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
const WORDY: Issue = {
  original: 'In order to',
  replacement: null,
  before: '',
  category: 'clarity',
  severity: 'suggestion',
  kind: 'wordy_phrase',
  reason: 'This opening is longer than it needs to be.',
};

/** Reply per paragraph with the issues `pick` returns for its text. */
const issuesFor =
  (pick: (text: string) => Issue[]) =>
  async (body: any): Promise<MockReply> => ({
    results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: pick(p.text) })),
  });

const hasCat = issuesFor((t) => (t.includes('I has a cat') ? [HAS] : []));

const underlines = (page: Page) => page.locator('.englint-underline');
const errorUnderline = (page: Page) => page.locator('.englint-underline.error');
const card = (page: Page) => page.locator('.englint-card');

async function openPage(page: Page, pagesURL: string): Promise<void> {
  await page.goto(`${pagesURL}/textarea.html`);
}

async function typeInTextarea(page: Page, text: string): Promise<void> {
  await page.locator('#ta').click();
  await page.keyboard.type(text);
}

/** Moves the real pointer onto the underline (it has pointer-events: none, so Playwright's hover() can't target it). */
async function pointAt(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function tabEntries(sw: Worker): Promise<{ tabId: number; state: any }[]> {
  return sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('tab:'))
      .map(([k, state]) => ({ tabId: Number(k.slice('tab:'.length)), state }));
  });
}

async function tabStates(sw: Worker): Promise<any[]> {
  return (await tabEntries(sw)).map((e) => e.state);
}

/** The one tab's state once its field has issues: tab id, field id, frame id and the field's issues. */
async function fieldWithIssues(sw: Worker) {
  let found: { tabId: number; fieldId: string; frameId: number; issues: any[] } | undefined;
  await expect
    .poll(async () => {
      const [entry] = await tabEntries(sw);
      const fieldId = Object.keys(entry?.state.fields ?? {}).find((id) => entry!.state.fields[id].length > 0);
      found = fieldId
        ? { tabId: entry!.tabId, fieldId, frameId: entry!.state.frames[fieldId], issues: entry!.state.fields[fieldId] }
        : undefined;
      return !!found;
    })
    .toBe(true);
  return found!;
}

/** A panel/popup message to one frame of the tab, in @webext-core/messaging's wire format. */
async function toContent(sw: Worker, tabId: number, frameId: number, type: string, data?: unknown): Promise<any> {
  return sw.evaluate(
    ({ tabId, frameId, type, data }) =>
      chrome.tabs.sendMessage(tabId, { id: Date.now(), type, data, timestamp: Date.now() }, { frameId }),
    { tabId, frameId, type, data },
  );
}

test('underlines a mocked error', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');

  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect(underlines(page)).toHaveCount(1);

  // The underline sits under "has": monospace 16px/24px, 1px border, 8px padding.
  const geo = await page.evaluate(() => {
    const ta = document.querySelector('#ta')!.getBoundingClientRect();
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = '16px monospace';
    return { left: ta.left, top: ta.top, prefix: ctx.measureText('I ').width, word: ctx.measureText('has').width };
  });
  const box = (await errorUnderline(page).boundingBox())!;
  expect(Math.abs(box.x - (geo.left + 1 + 8 + geo.prefix))).toBeLessThan(2);
  expect(Math.abs(box.width - geo.word)).toBeLessThan(2);
  expect(box.y).toBeGreaterThan(geo.top + 1 + 8);
  expect(box.y + box.height).toBeLessThanOrEqual(geo.top + 1 + 8 + 24 + 1);
});

test('card shows only the fix and a Dismiss button as wide as its word', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();
  await expect(card(page)).not.toContainText('Correctness');
  await expect(card(page)).not.toContainText('Use "have" with "I".');
  await expect(card(page).locator('s, .englint-card-original, .englint-card-category, .englint-card-reason')).toHaveCount(0);
  await expect(page.locator('.englint-card-fix')).toHaveText('have');
  await expect(card(page).locator('button')).toHaveCount(2);
  await expect(card(page)).toHaveText('haveDismiss');
  await expect(page.locator('.englint-card-dismiss')).toHaveText('Dismiss');
  // Dismiss is only as wide as its label plus padding, at the left of the card's bottom row.
  const dismiss = page.locator('.englint-card-dismiss');
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // measured at full size
  const [c, d] = [(await card(page).boundingBox())!, (await dismiss.boundingBox())!];
  const fit = await dismiss.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const cs = getComputedStyle(el);
    return { label: range.getBoundingClientRect().width, padding: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) };
  });
  expect(Math.abs(d.width - fit.label - fit.padding)).toBeLessThanOrEqual(1);
  expect(d.width).toBeLessThan(c.width / 2);
  expect(Math.abs(d.x - (c.x + 1))).toBeLessThanOrEqual(1); // inside the card's 1px border
  // Same colours and hover as before.
  expect(await dismiss.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor])).toEqual([
    'rgb(95, 99, 104)',
    'rgba(0, 0, 0, 0)',
  ]);
  await dismiss.hover();
  await expect
    .poll(() => dismiss.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]))
    .toEqual(['rgb(32, 33, 36)', 'rgb(241, 243, 244)']);
});

test('clicking the fix accepts and undo restores', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();

  await page.locator('.englint-card-fix').click();
  const ta = page.locator('#ta');
  await expect(ta).toHaveValue('I have a cat.');
  await expect(ta).toBeFocused();
  await expect(card(page)).toBeHidden();
  await expect(underlines(page)).toHaveCount(0);

  await page.keyboard.press('Meta+Z');
  await expect(ta).toHaveValue('I has a cat.');
});

test('card closes after pointer leaves', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();

  // Moving onto the card keeps it open.
  await pointAt(page, '.englint-card');
  await page.waitForTimeout(700);
  await expect(card(page)).toBeVisible();

  // Leaving both closes it shortly after.
  const far = (await page.locator('#far').boundingBox())!;
  await page.mouse.move(far.x + 5, far.y + 5);
  await expect(card(page)).toBeHidden({ timeout: 1500 });
});

test('dismiss hides and survives recheck', async ({ page, pagesURL, mock }) => {
  mock.respond(
    issuesFor((t) => [...(t.includes('I has a cat') ? [HAS] : []), ...(t.includes('She go home') ? [GO] : [])]),
  );
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAt(page, '.englint-underline.error');
  await page.locator('.englint-card-dismiss').click();
  await expect(underlines(page)).toHaveCount(0);
  await expect(card(page)).toBeHidden();

  // A new paragraph triggers another check; the first paragraph keeps its hash and stays dismissed.
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type('\n\nShe go home.');
  await expect.poll(() => mock.requests.length).toBe(2);
  await expect(underlines(page)).toHaveCount(1);
  const ta = (await page.locator('#ta').boundingBox())!;
  const only = (await underlines(page).first().boundingBox())!;
  expect(only.y).toBeGreaterThan(ta.y + 1 + 8 + 2 * 24); // on the third line, under "go"

  // After a reload the stored dismissal hides it again (results come from the cache: no new request).
  await page.reload();
  await typeInTextarea(page, 'I has a cat.\n\nShe go home.');
  await expect(underlines(page)).toHaveCount(1, { timeout: 3000 });
  const again = (await underlines(page).first().boundingBox())!;
  expect(again.y).toBeGreaterThan(ta.y + 1 + 8 + 2 * 24);
  expect(mock.requests.length).toBe(2);
});

test('a comment-only note is underlined as a suggestion; its card offers "Rewrite this sentence" and no fix', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await clarityOn(serviceWorker);
  mock.respond(issuesFor((t) => (t.includes('In order to') ? [WORDY] : [])));
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'In order to win, we practice.');
  await expect(page.locator('.englint-underline.suggestion')).toHaveCount(1, { timeout: 3000 });
  const box = (await page.locator('.englint-underline').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(card(page).getByRole('button', { name: 'Rewrite this sentence' })).toBeVisible();
  await expect(card(page).locator('.englint-card-fix')).toHaveCount(0);
});

test('password and text inputs are never sent', async ({ page, pagesURL, mock }) => {
  await openPage(page, pagesURL);
  await page.locator('#pw').click();
  await page.keyboard.type('I has a secret.');
  await page.locator('#txt').click();
  await page.keyboard.type('I has a single line.');
  await page.waitForTimeout(2500); // past the 1 s debounce
  expect(mock.requests.length).toBe(0);

  // Control: the textarea on the same page is checked, so the zero above is not a dead harness.
  await typeInTextarea(page, 'Hello there.');
  await expect.poll(() => mock.requests.length).toBe(1);
  const sent = JSON.stringify(mock.requests);
  expect(sent).not.toContain('secret');
  expect(sent).not.toContain('single line');
});

test('field removed leaves no underlines', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();

  await page.evaluate(() => document.querySelector('#ta')!.remove());
  await expect(underlines(page)).toHaveCount(0);
  await expect(card(page)).toBeHidden();
  // The tab state drops the field's issues too.
  await expect
    .poll(async () => (await tabStates(serviceWorker)).map((s) => [s.fields, s.frames]))
    .toEqual([[{}, {}]]);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('typing during in-flight check', async ({ page, pagesURL, mock }) => {
  mock.respond(async (body) => {
    const ps = paragraphsOf(body);
    if (ps.some((p) => p.text.includes('I has a cat'))) await new Promise((r) => setTimeout(r, 1500));
    return { results: ps.map((p) => ({ paragraph_id: p.id, issues: p.text.includes('has') ? [HAS] : [] })) };
  });
  await openPage(page, pagesURL);
  // Record any underline that is ever drawn, even for a single frame.
  await page.evaluate(() => {
    const w = window as unknown as { sawUnderline: boolean };
    w.sawUnderline = false;
    const tick = () => {
      for (const el of document.querySelectorAll('*')) {
        if (el.shadowRoot?.querySelector('.englint-underline')) w.sawUnderline = true;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });

  await typeInTextarea(page, 'I has a cat.');
  await expect.poll(() => mock.requests.length).toBe(1);
  // Edit "has" while the check is in flight.
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 5));
  await page.keyboard.type('had');
  expect(mock.responses).toBe(0);

  await expect.poll(() => mock.responses, { timeout: 8000 }).toBe(2);
  expect(paragraphsOf(mock.requests[1]).map((p) => p.text)).toEqual(['I had a cat.']);
  await page.waitForTimeout(500);
  await expect(underlines(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { sawUnderline: boolean }).sawUnderline)).toBe(false);
});

test('401 shows key_invalid', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(async () => ({ status: 401 }));
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect.poll(() => mock.requests.length).toBe(1);
  await expect
    .poll(async () => (await tabStates(serviceWorker)).map((s) => s.status), { timeout: 5000 })
    .toEqual(['key_invalid']);
  expect((await tabStates(serviceWorker))[0].activeFieldId).toMatch(/^f-[0-9a-z]{6}-1$/); // the focused field
  await expect(underlines(page)).toHaveCount(0);
});

test('field hidden leaves no underlines', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.evaluate(() => ((document.querySelector('#ta') as HTMLElement).style.display = 'none'));
  await expect(underlines(page)).toHaveCount(0);
});

test('a fix the page rejects is copied to the clipboard instead', async ({ page, pagesURL, mock, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: pagesURL });
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  // Like a controlled input: the page puts its own value back after every edit.
  await page.evaluate(() => {
    const ta = document.querySelector('#ta') as HTMLTextAreaElement;
    ta.addEventListener('input', () => (ta.value = 'I has a cat.'));
  });
  await pointAt(page, '.englint-underline.error');
  await page.locator('.englint-card-fix').click();

  await expect(page.locator('.englint-notice')).toHaveText("Couldn't apply here — copied to clipboard.");
  await expect(page.locator('#ta')).toHaveValue('I has a cat.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('have');
});

test('a disabled site attaches nothing until re-enabled', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['127.0.0.1'] }));
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await page.waitForTimeout(2500); // past the 1 s debounce
  expect(mock.requests.length).toBe(0);
  expect(await tabStates(serviceWorker)).toEqual([]); // not even an off_site check was sent
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);
  const badge = () => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  await expect.poll(badge).toBe('off'); // the toolbar says so

  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
  await expect.poll(badge).not.toBe('off');
  await page.locator('#ta').click();
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  expect(mock.requests.length).toBe(1);
  await expect.poll(badge).toBe('1');
});

const WORDY_FIX: Issue = { ...WORDY, replacement: 'To', reason: 'Shorter.' };

test('card opens and closes after short delays', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  await pointAt(page, '.englint-underline.error');
  await page.waitForTimeout(100);
  expect(await card(page).isVisible()).toBe(false); // opens 180 ms after hover, not at once
  await expect(card(page)).toBeVisible({ timeout: 500 });

  const far = (await page.locator('#far').boundingBox())!;
  await page.mouse.move(far.x + 5, far.y + 5);
  await page.waitForTimeout(100);
  expect(await card(page).isVisible()).toBe(true); // closes 300 ms after leaving, not at once
  await expect(card(page)).toBeHidden({ timeout: 500 });
});

test('caret moving into an issue opens its card', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(400);
  await expect(card(page)).toBeHidden();

  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await page.keyboard.press('ArrowLeft'); // caret 4: inside "has"
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.englint-card-fix')).toHaveText('have');
  await page.waitForTimeout(700); // opened without the pointer: it doesn't close on the hover timer
  await expect(card(page)).toBeVisible();
});

test('Esc closes the card', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();

  await page.keyboard.press('Escape'); // the pointer stays on the underline
  await expect(card(page)).toBeHidden({ timeout: 250 });
});

test('typing closes the card', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.\nHello');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();

  // Typing in the other line keeps the issue (its line is unchanged); only the typing closes the card.
  await page.keyboard.type('!');
  await expect(card(page)).toBeHidden({ timeout: 250 });
  await expect(errorUnderline(page)).toBeVisible();
});

test('card closes when its text scrolls out of view', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await page.locator('#ta').fill('I has a cat.' + '\nFiller line.'.repeat(30));
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(0, 0);
    el.scrollTop = 0; // fill leaves the caret, and the scroll, at the end
  });
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAt(page, '.englint-underline.error');
  await expect(card(page)).toBeVisible();

  await page.locator('#ta').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(underlines(page)).toHaveCount(0);
  await expect(card(page)).toBeHidden();

  // Scrolling back brings the underline back, but not the card.
  await page.locator('#ta').evaluate((el) => (el.scrollTop = 0));
  await expect(errorUnderline(page)).toBeVisible();
  await page.waitForTimeout(600);
  await expect(card(page)).toBeHidden();
});

test('panel applyFix fixes the text', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  const f = await fieldWithIssues(serviceWorker);
  expect(f.frameId).toBe(0);

  const reply = await toContent(serviceWorker, f.tabId, f.frameId, 'applyFix', { fieldId: f.fieldId, issueId: f.issues[0].id });
  expect(reply).toEqual({ res: { ok: true } });
  await expect(page.locator('#ta')).toHaveValue('I have a cat.');
  await expect(underlines(page)).toHaveCount(0);
});

test('panel dismissIssue removes the underline', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  const f = await fieldWithIssues(serviceWorker);

  await toContent(serviceWorker, f.tabId, f.frameId, 'dismissIssue', { fieldId: f.fieldId, issueId: f.issues[0].id });
  await expect(underlines(page)).toHaveCount(0);
  await expect(page.locator('#ta')).toHaveValue('I has a cat.');
});

test('panel acceptAllErrors fixes errors only', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  mock.respond(issuesFor((t) => [...(t.includes('I has a cat') ? [HAS] : []), ...(t.includes('In order to') ? [WORDY_FIX] : [])]));
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.\nIn order to win, we practice.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.englint-underline.suggestion')).toBeVisible();
  const f = await fieldWithIssues(serviceWorker);

  const reply = await toContent(serviceWorker, f.tabId, f.frameId, 'acceptAllErrors', { fieldId: f.fieldId });
  expect(reply).toEqual({ res: { applied: 1, failed: 0 } });
  await expect(page.locator('#ta')).toHaveValue('I have a cat.\nIn order to win, we practice.');
  await expect(errorUnderline(page)).toHaveCount(0);
  await expect(page.locator('.englint-underline.suggestion')).toBeVisible();
});

test('panel jumpTo selects the issue', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  const f = await fieldWithIssues(serviceWorker);
  await page.locator('#far').click(); // focus leaves the field

  await toContent(serviceWorker, f.tabId, f.frameId, 'jumpTo', { fieldId: f.fieldId, issueId: f.issues[0].id });
  await expect(page.locator('#ta')).toBeFocused();
  expect(await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(700); // opened without the pointer: it doesn't close on the hover timer
  await expect(card(page)).toBeVisible();
});

test('panel recheckAll checks without waiting for the pause', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await openPage(page, pagesURL);
  await typeInTextarea(page, 'Hello.'); // attaches the field and registers the frame's handlers
  await expect.poll(() => mock.requests.length).toBe(1);
  const [entry] = await tabEntries(serviceWorker);

  await page.keyboard.type(' I has a cat.');
  const typedAt = Date.now();
  await toContent(serviceWorker, entry!.tabId, 0, 'recheckAll');
  await expect.poll(() => mock.requests.length, { timeout: 600, intervals: [25] }).toBe(2);
  expect(Date.now() - typedAt).toBeLessThan(900); // sooner than the 1 s debounce would have sent it
  expect(paragraphsOf(mock.requests[1]).map((p) => p.text)).toEqual(['Hello. I has a cat.']);
});

test('a textarea in an iframe is checked and fixed through its frame', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/iframe.html`);
  // A field in the top frame too: both frames number their first field 1, so only the token tells them apart.
  await page.locator('#top').click();
  await page.keyboard.type('Hello.');
  const child = page.frameLocator('#child');
  await child.locator('#ta').click();
  await page.keyboard.type('I has a cat.');
  await expect(child.locator('.englint-underline.error')).toBeVisible({ timeout: 3000 });

  const f = await fieldWithIssues(serviceWorker);
  expect(f.fieldId).toMatch(/^f-[0-9a-z]{6}-1$/);
  expect(f.frameId).toBeGreaterThan(0);
  const [entry] = await tabEntries(serviceWorker);
  expect(Object.keys(entry!.state.frames)).toHaveLength(2); // two fields, two distinct ids
  expect(new Set(Object.values(entry!.state.frames))).toEqual(new Set([0, f.frameId]));

  const reply = await toContent(serviceWorker, f.tabId, f.frameId, 'applyFix', { fieldId: f.fieldId, issueId: f.issues[0].id });
  expect(reply).toEqual({ res: { ok: true } });
  await expect(child.locator('#ta')).toHaveValue('I have a cat.');
});

/**
 * The top page on `localhost` embeds the textarea page from `127.0.0.1` (the same server, another host).
 * The e2e build has a host permission for 127.0.0.1 only, so the top host can only come from the
 * content-script message's `sender.tab.url`, as in production.
 */
async function openCrossFrame(page: Page, pagesURL: string) {
  const top = pagesURL.replace('127.0.0.1', 'localhost');
  await page.goto(`${top}/cross-frame.html?child=${encodeURIComponent(`${pagesURL}/textarea.html`)}`);
  const child = page.frameLocator('#child');
  await expect(child.locator('#ta')).toBeVisible();
  return child;
}

test('switching the top site off stops checks in its frames from other hosts', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  const child = await openCrossFrame(page, pagesURL);
  await child.locator('#ta').click();
  await page.keyboard.type('I has a cat.');
  await expect(child.locator('.englint-underline.error')).toBeVisible({ timeout: 3000 });
  expect(mock.requests.length).toBe(1);

  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['localhost'] }));
  await expect(child.locator('.englint-underline')).toHaveCount(0); // the frame's field detached
  await child.locator('#ta').click();
  await page.keyboard.type(' She go home.');
  await page.waitForTimeout(2500); // past the 1 s debounce
  expect(mock.requests.length).toBe(1);
});

test('a frame inside a site that is already off attaches nothing', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(hasCat);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['localhost'] }));
  const child = await openCrossFrame(page, pagesURL);
  await child.locator('#ta').click();
  await page.keyboard.type('I has a cat.');
  await page.waitForTimeout(2500);
  expect(mock.requests.length).toBe(0);
  expect(await tabStates(serviceWorker)).toEqual([]);

  // Switching the top site back on starts checking in the frame.
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
  await child.locator('#ta').click();
  await expect(child.locator('.englint-underline.error')).toBeVisible({ timeout: 3000 });
});
