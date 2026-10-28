import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { expect, setKey, test } from './fixtures';
import { paragraphsOf } from './mock-anthropic';

// The local Harper checker for real: the background creates the offscreen document on the first harperCheck,
// which compiles the slim WebAssembly and answers through the background. Messages go from the content
// script's own world on a page, as the content side sends them.

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

type Paragraph = { hash: string; text: string };
type HarperIssue = { ruleId: string; original: string; replacement: string | null; at?: number; suggestionCount?: number };
type HarperResponse = { status: string; results: Record<string, HarperIssue[]> };

/** Sends messages from the extension's content-script world on `page`, in @webext-core/messaging's format. */
async function contentWorld(page: Page, extensionId: string): Promise<(type: string, data: unknown) => Promise<any>> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const worlds: { id: number; origin: string; auxData?: { type?: string } }[] = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
  await cdp.send('Runtime.enable');
  const origin = `chrome-extension://${extensionId}`;
  await expect.poll(() => worlds.some((w) => w.origin === origin && w.auxData?.type === 'isolated')).toBe(true);
  const world = worlds.find((w) => w.origin === origin && w.auxData?.type === 'isolated')!;
  return async (type, data) => {
    const message = { id: Date.now(), type, data, timestamp: Date.now() };
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      contextId: world.id,
      expression: `chrome.runtime.sendMessage(${JSON.stringify(message)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
}

const offscreenDocuments = (sw: import('@playwright/test').Worker) =>
  sw.evaluate(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).map((c: { documentUrl: string }) => c.documentUrl),
  );

test('Harper flags "a apple" and "the the" from an offscreen document, with no API request', async ({
  page,
  pagesURL,
  extensionId,
  serviceWorker,
  mock,
}) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const send = await contentWorld(page, extensionId);
  const harperCheck = async (paragraphs: Paragraph[]): Promise<HarperResponse> => {
    const reply = await send('harperCheck', { host: '127.0.0.1', mode: 'standard', paragraphs });
    if (reply?.err) throw new Error(JSON.stringify(reply.err));
    return reply.res;
  };
  expect(await offscreenDocuments(serviceWorker)).toEqual([]);

  // Cold: the document is created and compiles the WebAssembly. A first answer slower than the 4 s deadline comes
  // back empty, so ask until the issues arrive.
  const paragraphs = [
    { hash: 'p1', text: 'This is a apple.' },
    { hash: 'p2', text: 'I saw the the cat.' },
  ];
  const coldStart = Date.now();
  let cold: HarperResponse = { status: '', results: {} };
  await expect
    .poll(async () => (cold = await harperCheck(paragraphs)).results.p1?.length ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const coldMs = Date.now() - coldStart;

  expect(cold.status).toBe('ok');
  expect(cold.results.p1).toEqual([
    expect.objectContaining({ ruleId: 'harper:AnA', original: 'a', replacement: 'an', at: 8, suggestionCount: 1 }),
  ]);
  expect(cold.results.p2).toEqual([
    expect.objectContaining({ ruleId: 'harper:RepeatedWords', original: 'the the', replacement: 'the', at: 6 }),
  ]);

  const warmStart = Date.now();
  const warm = await harperCheck([{ hash: 'p3', text: 'She bought a orange.' }]);
  const warmMs = Date.now() - warmStart;
  expect(warm.results.p3).toEqual([expect.objectContaining({ ruleId: 'harper:AnA', original: 'a', replacement: 'an' })]);
  console.info('EngLint: harper', { coldMs, warmMs });

  expect(await offscreenDocuments(serviceWorker)).toEqual([`chrome-extension://${extensionId}/offscreen.html`]);
  expect(mock.requests).toHaveLength(0);
});

test("the Harper worker ships as one file of the extension, without harper.js's own blob: worker inside it", () => {
  const dir = resolve('.output-e2e/chrome-mv3/assets');
  const files = readdirSync(dir).filter((f) => /^harper\.worker-.+\.js$/.test(f));
  expect(files).toHaveLength(1);
  const source = readFileSync(join(dir, files[0]!), 'utf8');
  expect(source).not.toContain('URL.revokeObjectURL(import.meta.url)'); // the start of WorkerLinter's inline source
  expect(source.length).toBeLessThan(100_000);
});

test("Harper starts in a worker: an open side panel never stalls while it builds the dictionary", async ({
  page,
  pagesURL,
  extensionId,
  serviceWorker,
}) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const send = await contentWorld(page, extensionId);
  // The extension's pages share one main thread: the panel's 10 ms timer measures how long it was held up.
  const panel = await page.context().newPage();
  await panel.addInitScript(() => {
    const w = window as any;
    let last = performance.now();
    w.__longest = 0;
    const tick = () => {
      const now = performance.now();
      w.__longest = Math.max(w.__longest, now - last);
      last = now;
      setTimeout(tick, 10);
    };
    tick();
  });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=424242`);
  await expect(panel.getByRole('tab', { name: 'Issues' })).toBeVisible();
  await panel.waitForTimeout(300); // past the panel's own start
  await panel.evaluate(() => ((window as any).__longest = 0));
  expect(await offscreenDocuments(serviceWorker)).toEqual([]);

  // The first check creates the document, which builds Harper (hundreds of milliseconds of WebAssembly).
  const found = async () => {
    const reply = await send('harperCheck', { host: '127.0.0.1', mode: 'standard', paragraphs: [{ hash: 'p1', text: 'I ate a apple.' }] });
    return (reply?.res as HarperResponse | undefined)?.results?.p1?.length ?? 0;
  };
  await expect.poll(found, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await panel.evaluate(() => (window as any).__longest)).toBeLessThan(150);
});

test('Harper answers off_site on a switched-off site and creates no document', async ({ page, pagesURL, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['127.0.0.1'] }));
  await page.goto(`${pagesURL}/textarea.html`);
  const send = await contentWorld(page, extensionId);
  const reply = await send('harperCheck', { host: '127.0.0.1', mode: 'standard', paragraphs: [{ hash: 'p1', text: 'This is a apple.' }] });
  expect(reply.res).toEqual({ status: 'off_site', results: {}, dismissed: [] });
  expect(await offscreenDocuments(serviceWorker)).toEqual([]);
});

test('turning "Instant local checks" off closes the offscreen document', async ({ page, pagesURL, extensionId, serviceWorker }) => {
  await page.goto(`${pagesURL}/textarea.html`);
  const send = await contentWorld(page, extensionId);
  const paragraphs = [{ hash: 'p1', text: 'This is a apple.' }];
  await expect
    .poll(async () => (await send('harperCheck', { host: '127.0.0.1', mode: 'standard', paragraphs })).res?.results?.p1?.length ?? 0, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  expect(await offscreenDocuments(serviceWorker)).toEqual([`chrome-extension://${extensionId}/offscreen.html`]);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ localChecks: false }));
  await expect.poll(() => offscreenDocuments(serviceWorker)).toEqual([]);
});

// ---- in the live pipeline: a textarea's session asks Harper 150 ms after typing ----

const underlines = (page: Page) => page.locator('.englint-underline');
const errorUnderline = (page: Page) => page.locator('.englint-underline.error');

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

const tabStatuses = (sw: import('@playwright/test').Worker) =>
  sw.evaluate(async () =>
    Object.entries(await chrome.storage.session.get(null))
      .filter(([k]) => k.startsWith('tab:'))
      .map(([, state]) => (state as { status: string }).status),
  );

test('with no key saved, "I ate a apple." gets an underline whose fix is "an", and nothing reaches the API', async ({
  page,
  pagesURL,
  serviceWorker,
  mock,
}) => {
  await setKey(serviceWorker, null);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I ate a apple.');
  await expect(errorUnderline(page)).toHaveCount(1, { timeout: 15_000 });
  await pointAt(page, '.englint-underline.error');
  await expect(page.locator('.englint-card-preview ins')).toHaveText('an');
  await expect.poll(() => tabStatuses(serviceWorker)).toEqual(['key_missing']);
  expect(mock.requests).toHaveLength(0);
});

test('a Harper spelling underline shows first, then goes when Claude answers the paragraph with nothing', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(async (body) => {
    await new Promise((r) => setTimeout(r, 6000)); // Claude answers late
    return { results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: [] })) };
  });
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I will see you tommorow.');
  await expect(errorUnderline(page)).toHaveCount(1, { timeout: 5000 });
  expect(mock.responses).toBe(0); // shown before Claude's answer
  await pointAt(page, '.englint-underline.error');
  await expect(page.locator('.englint-card-preview ins')).toHaveText('tomorrow');
  await expect.poll(() => mock.requests.length, { timeout: 5000 }).toBe(1);
  expect(paragraphsOf(mock.requests[0]).map((p) => p.text)).toEqual(['I will see you tommorow.']);
  await expect.poll(() => mock.responses, { timeout: 15_000 }).toBe(1);
  await expect(underlines(page)).toHaveCount(0);
});

test('with local checks off and no key, nothing underlines and the checker never starts', async ({
  page,
  pagesURL,
  serviceWorker,
  mock,
}) => {
  await setKey(serviceWorker, null);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ localChecks: false }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeInTextarea(page, 'I ate a apple.');
  // Claude's check has answered, long after a Harper tick (150 ms) would have been sent.
  await expect.poll(() => tabStatuses(serviceWorker), { timeout: 10_000 }).toEqual(['key_missing']);
  await page.waitForTimeout(1500);
  await expect(underlines(page)).toHaveCount(0);
  expect(await offscreenDocuments(serviceWorker)).toEqual([]);
  expect(mock.requests).toHaveLength(0);
});
