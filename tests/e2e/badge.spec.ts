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
const COMMA: Issue = {
  ...HAS,
  original: ',',
  replacement: ', ',
  before: 'Hello world',
  category: 'punctuation',
  kind: 'missing_space',
  reason: 'Add a space after the comma.',
};

const issuesFor =
  (pick: (text: string) => Issue[]) =>
  async (body: any): Promise<MockReply> => ({
    results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: pick(p.text) })),
  });
const textErrors = issuesFor((t) => [...(t.includes('I has a cat') ? [HAS] : []), ...(t.includes('She go home') ? [GO] : [])]);
const docsErrors = issuesFor((t) => [
  ...(t.includes('I has a cat') ? [HAS] : []),
  ...(t.includes('She go home') ? [GO] : []),
  ...(t.includes('Hello world,how') ? [COMMA] : []),
]);

const badge = (page: Page) => page.locator('.englint-badge');

/** An element's client box in the viewport (inside its border and scrollbars), and its border box. */
async function clientBox(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft;
    const top = r.top + el.clientTop;
    return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight, border: r.toJSON() as DOMRect };
  }, selector);
}

const panelOpen = (sw: Worker) => sw.evaluate(async () => (await chrome.storage.session.get('e2e:panelOpen'))['e2e:panelOpen']);

async function typeInField(page: Page, pagesURL: string, text: string): Promise<void> {
  await page.goto(`${pagesURL}/badge.html`);
  await page.locator('#ta').click();
  await page.keyboard.type(text);
}

test('a textarea with two errors shows "2" in its bottom-right corner, 6 px in, inside the field', async ({ page, pagesURL, mock }) => {
  mock.respond(textErrors);
  await typeInField(page, pagesURL, 'I has a cat. She go home.');

  await expect(badge(page)).toHaveText('2', { timeout: 5000 });
  await expect(badge(page)).toHaveAttribute('aria-label', 'EngLint: 2 errors, 0 suggestions');
  await expect(badge(page)).toHaveCSS('opacity', '0.6'); // 60% until hovered
  const box = (await badge(page).boundingBox())!;
  const field = await clientBox(page, '#ta');
  expect([box.width, box.height]).toEqual([20, 20]);
  expect(Math.abs(box.x + box.width - (field.right - 6))).toBeLessThan(1);
  expect(Math.abs(box.y + box.height - (field.bottom - 6))).toBeLessThan(1);
  // Inside the field's own box.
  expect(box.x).toBeGreaterThan(field.border.left);
  expect(box.y).toBeGreaterThan(field.border.top);
  expect(box.x + box.width).toBeLessThan(field.border.left + field.border.width);
  expect(box.y + box.height).toBeLessThan(field.border.top + field.border.height);

  await badge(page).hover();
  await expect(badge(page)).toHaveCSS('opacity', '1');
});

test('a resizable textarea: the badge sits 22 px in, leaving the resize grip to the field, which still resizes', async ({ page, pagesURL, mock }) => {
  await page.goto(`${pagesURL}/badge.html`);
  await page.locator('#grip').click();
  await page.keyboard.type('Hello.');
  await expect(badge(page)).toBeVisible({ timeout: 5000 });
  const box = (await badge(page).boundingBox())!;
  const field = await clientBox(page, '#grip');
  expect(Math.abs(box.x + box.width - (field.right - 22))).toBeLessThan(1);
  expect(Math.abs(box.y + box.height - (field.bottom - 22))).toBeLessThan(1);

  // The grip's corner (15 px each way inside the border box) is the field's, not the badge's.
  const b = field.border;
  const corner = b.left + b.width;
  const bottom = b.top + b.height;
  const hits = await page.evaluate(
    ({ corner, bottom }) => [3, 7, 11, 15].map((d) => document.elementFromPoint(corner - d, bottom - d)?.id ?? null),
    { corner, bottom },
  );
  expect(hits).toEqual(['grip', 'grip', 'grip', 'grip']);
  await page.mouse.move(corner - 3, bottom - 3);
  await page.mouse.down();
  await page.mouse.move(corner + 37, bottom + 37, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => document.querySelector('#grip')!.getBoundingClientRect().height)).toBeGreaterThan(b.height + 20);
});

test("another extension's 20 px badge on that corner pushes the badge 28 px left; it moves back once that is gone", async ({
  page,
  pagesURL,
  mock,
}) => {
  await typeInField(page, pagesURL, 'Hello.');
  await expect(badge(page)).toHaveAttribute('aria-label', 'EngLint: no issues', { timeout: 5000 });
  const corner = (await badge(page).boundingBox())!;

  // The other badge lands exactly on the spot (under ours: EngLint's overlay paints on top).
  await page.evaluate(({ x, y }) => {
    const el = document.createElement('div');
    el.id = 'foreign';
    Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
    document.body.append(el);
  }, corner);
  await page.keyboard.type(' More.'); // an edit redraws the badge
  await expect.poll(async () => Math.round((await badge(page).boundingBox())?.x ?? -1)).toBe(Math.round(corner.x - 28));
  expect(Math.round((await badge(page).boundingBox())!.y)).toBe(Math.round(corner.y));

  await page.evaluate(() => document.querySelector('#foreign')!.remove());
  await page.keyboard.type(' Done.');
  await expect.poll(async () => Math.round((await badge(page).boundingBox())?.x ?? -1)).toBe(Math.round(corner.x));
});

test("typing on the last line hides it while the caret's line overlaps it; the caret moving up a line brings it back", async ({
  page,
  pagesURL,
  mock,
}) => {
  await typeInField(page, pagesURL, 'one\ntwo\nthree\nfour\nfive');
  await expect(badge(page)).toBeVisible({ timeout: 5000 }); // the fifth line is clear of it

  await page.keyboard.type('\nsix'); // the sixth line runs under the badge
  await expect(badge(page)).toBeHidden();
  await page.waitForTimeout(1500); // the check runs: its spinner and answer redraw the badge, still hidden
  await expect(badge(page)).toBeHidden();

  await page.keyboard.press('ArrowUp');
  await expect(badge(page)).toBeVisible();
});

test('"Show the EngLint badge" off removes it; on brings it back', async ({ page, pagesURL, serviceWorker, mock }) => {
  await typeInField(page, pagesURL, 'Hello.');
  // Settled: the check answered and nothing else is due to redraw the badge, so only the switch can change it.
  await expect.poll(() => mock.responses, { timeout: 5000 }).toBeGreaterThan(0);
  await expect(badge(page)).toHaveAttribute('aria-label', 'EngLint: no issues');
  await page.waitForTimeout(300);

  await serviceWorker.evaluate(() => chrome.storage.local.set({ showBadge: false }));
  await expect(badge(page)).toHaveCount(0);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ showBadge: true }));
  await expect(badge(page)).toBeVisible();
});

test("the user's click opens the side panel (the background records opened: true), and focus stays in the field; a page script's click does nothing", async ({
  page,
  pagesURL,
  serviceWorker,
  mock,
}) => {
  await typeInField(page, pagesURL, 'Hello.');
  await expect(badge(page)).toBeVisible({ timeout: 5000 });

  // A page script can reach the badge in the e2e build's open root; its click isn't trusted.
  await page.evaluate(() => (document.querySelector('englint-overlay')!.shadowRoot!.querySelector('.englint-badge') as HTMLElement).click());
  await page.waitForTimeout(500);
  expect(await panelOpen(serviceWorker)).toBeUndefined();

  await badge(page).click(); // trusted: through the browser's input pipeline
  await expect.poll(() => panelOpen(serviceWorker)).toEqual({ opened: true });
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('ta');
  await expect(badge(page)).toBeVisible();
});

test('a switched-off site shows no badge; switched on, the focused field gets one; off again, it goes', async ({
  page,
  pagesURL,
  serviceWorker,
  mock,
}) => {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['127.0.0.1'] }));
  await typeInField(page, pagesURL, 'Hello.');
  await page.waitForTimeout(1500);
  await expect(badge(page)).toHaveCount(0);
  await expect(page.locator('englint-overlay')).toHaveCount(0); // nothing of EngLint's on the page

  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
  await expect(badge(page)).toBeVisible({ timeout: 5000 }); // the same field, with the site on
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['127.0.0.1'] }));
  await expect(badge(page)).toHaveCount(0);
});

test("fake Docs: the badge sits in the editor viewport's bottom-right corner, 12 px in", async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await page.goto(`${pagesURL}/document/d/fake/edit.html`);
  await expect(page.locator('.englint-underline.error').first()).toBeVisible({ timeout: 5000 });
  await expect(badge(page)).toHaveCount(0); // focus isn't in the document yet

  await page.mouse.click(700, 130); // focus goes to the text-event iframe, as live
  await expect(badge(page)).toBeVisible();
  await expect(badge(page)).toHaveText(/^[1-9]\d*$/);
  const box = (await badge(page).boundingBox())!;
  const editor = await clientBox(page, '.kix-appview-editor');
  expect(Math.abs(box.x + box.width - (editor.right - 12))).toBeLessThan(1);
  expect(Math.abs(box.y + box.height - (editor.bottom - 12))).toBeLessThan(1);
});
