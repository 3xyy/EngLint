import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { clarityOn, expect, recordTabActivity, test } from './fixtures';
import { type MockReply, paragraphsOf } from './mock-anthropic';
import { pixelAt, underlinePainted } from './pixels';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

// Playwright can't reach real Docs: this runs both Docs content scripts against the fake Docs page
// (pages/document/d/fake/edit.html) and a fake docs list (pages/document/u/0/index.html), which the e2e
// build adds to their matches.

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

const docsErrors = issuesFor((t) => [
  ...(t.includes('I has a cat') ? [HAS] : []),
  ...(t.includes('She go home') ? [GO] : []),
  ...(t.includes('Hello world,how') ? [COMMA] : []),
]);

const FALLBACK_NOTICE = "Google Docs live checking isn't available right now.";
const errorUnderlines = (page: Page) => page.locator('.englint-underline.error');
const card = (page: Page) => page.locator('.englint-card');
/** Picks `name` from the card's "⋯" menu (its setting action, "Rewrite sentence"). */
async function pickFromMenu(page: Page, name: string): Promise<void> {
  await card(page).getByRole('button', { name: 'More actions' }).click();
  await card(page).getByRole('menuitem', { name }).click();
}
const docText = (page: Page) => page.evaluate(() => (window as any).fakeDocs.text() as string);

async function openDocs(page: Page, pagesURL: string, query = ''): Promise<void> {
  await page.goto(`${pagesURL}/document/d/fake/edit.html${query}`);
}

/**
 * The viewport box of `word` (inside `context`, its first line by default) in the fake page's visible
 * text: measured on its own DOM layout, not on the rects.
 */
async function wordBox(page: Page, word: string, context = word) {
  const box = await page.evaluate(({ word, context }) => {
    for (const div of Array.from(document.querySelectorAll('.text-layer div'))) {
      const node = div.firstChild as Text | null;
      const found = node ? node.data.indexOf(context) : -1;
      if (!node || found === -1) continue;
      const at = found + context.indexOf(word);
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const r = range.getBoundingClientRect();
      const line = div.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, lineBottom: line.bottom };
    }
    return null;
  }, { word, context });
  if (!box) throw new Error(`"${word}" in "${context}" is not in the page`);
  return box;
}

/** The error underline (or one of `underlines`) under `word`: same horizontal span (±2 px), at the bottom of its line. */
async function expectUnderlineUnder(page: Page, word: string, context = word, underlines = errorUnderlines(page)) {
  const want = await wordBox(page, word, context);
  await expect
    .poll(async () => {
      const boxes = await underlines.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
      return boxes.some(
        (b: DOMRect) =>
          Math.abs(b.left - want.left) < 2 &&
          Math.abs(b.right - want.right) < 2 &&
          b.top > want.top &&
          Math.abs(b.bottom - want.lineBottom) < 2,
      );
    })
    .toBe(true);
}

/** The viewport box of the error underline under `word` (inside `context`). */
async function underlineBoxUnder(page: Page, word: string, context = word): Promise<DOMRect> {
  const want = await wordBox(page, word, context);
  const boxes = await errorUnderlines(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
  const box = boxes.find((b: DOMRect) => Math.abs(b.left - want.left) < 2 && Math.abs(b.right - want.right) < 2);
  if (!box) throw new Error(`no underline under "${word}"`);
  return box;
}

type WordBox = { text: string; line: number; left: number; right: number; top: number; bottom: number };

/** Where `word` was painted on the fake page's tile canvas (?canvas=1), in viewport px now. */
async function paintedBox(page: Page, word: string): Promise<WordBox> {
  const boxes: WordBox[] = await page.evaluate(() => (window as any).__wordBoxes);
  const box = boxes.find((b) => b.text === word);
  if (!box) throw new Error(`"${word}" is not painted`);
  return box;
}

/** How far the error underline on `word`'s line (the one nearest the word) misses its painted box, per edge. */
async function underlineMiss(page: Page, word: string): Promise<{ left: number; right: number }> {
  const box = await paintedBox(page, word);
  const boxes: DOMRect[] = await errorUnderlines(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
  const nearest = boxes
    .filter((b) => Math.abs(b.bottom - box.bottom) < 3)
    .sort((a, b) => Math.abs(a.left - box.left) - Math.abs(b.left - box.left))[0];
  return nearest
    ? { left: Math.abs(nearest.left - box.left), right: Math.abs(nearest.right - box.right) }
    : { left: Infinity, right: Infinity };
}

/** Waits for the underline under `word` to sit on its painted box within 1 px at both ends. */
async function expectUnderlineOnPainted(page: Page, word: string): Promise<void> {
  await expect
    .poll(async () => {
      const miss = await underlineMiss(page, word);
      return Math.max(miss.left, miss.right);
    })
    .toBeLessThanOrEqual(1);
}

async function pointAt(page: Page, word: string): Promise<void> {
  const box = await wordBox(page, word);
  await page.mouse.move((box.left + box.right) / 2, box.lineBottom - 4);
}

async function tabEntries(sw: Worker): Promise<{ tabId: number; state: any }[]> {
  return sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('tab:'))
      .map(([k, state]) => ({ tabId: Number(k.slice('tab:'.length)), state }));
  });
}

async function toContent(sw: Worker, tabId: number, type: string, data?: unknown): Promise<any> {
  return sw.evaluate(
    ({ tabId, type, data }) => chrome.tabs.sendMessage(tabId, { id: Date.now(), type, data, timestamp: Date.now() }, { frameId: 0 }),
    { tabId, type, data },
  );
}

test('the e2e build runs both Docs scripts on the fake page and keeps the generic script off it', () => {
  const manifest = JSON.parse(readFileSync(resolve('.output-e2e/chrome-mv3/manifest.json'), 'utf8'));
  const scripts: any[] = manifest.content_scripts;
  const docs = scripts.filter((s) => s.matches.includes('https://docs.google.com/document/*'));
  expect(docs.map((s) => s.world ?? 'ISOLATED').sort()).toEqual(['ISOLATED', 'MAIN']);
  for (const s of docs) expect(s.matches).toContain('http://127.0.0.1/document/*');
  const generic = scripts.find((s) => s.matches.includes('<all_urls>'));
  expect(generic.exclude_matches).toEqual(['http://127.0.0.1/document/*']);
});

test('underlines a mocked error under its word', async ({ page, pagesURL, mock, serviceWorker, extensionId }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  expect(await page.evaluate(() => (window as any).fakeDocs.flag)).toBe(extensionId);

  await expect(errorUnderlines(page).first()).toBeVisible({ timeout: 5000 });
  await expectUnderlineUnder(page, 'has');
  await expectUnderlineUnder(page, ',', 'world,how');
  // The doc is one field, reported once; the generic script attached nothing.
  const [entry] = await tabEntries(serviceWorker);
  expect(Object.keys(entry!.state.fields)).toEqual(['gdocs']);
  await expect(page.locator('.englint-notice')).toBeHidden();
});

test("a heading move in the doc (a new fragment) keeps the panel's issues and page id; a reload starts a new page", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  extensionId,
}) => {
  mock.respond(docsErrors);
  const activity = await recordTabActivity(serviceWorker);
  await openDocs(page, pagesURL);
  await expect(errorUnderlines(page).first()).toBeVisible({ timeout: 5000 });
  const [entry] = await tabEntries(serviceWorker);
  const panel = await page.context().newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${entry!.tabId}`);
  await expect(panel.locator('.item').first()).toBeVisible();
  const items = await panel.locator('.item').count();

  await page.evaluate(() => history.replaceState(null, '', '#heading=h.abc123'));
  await expect.poll(() => activity.urls()).toContain(`${pagesURL}/document/d/fake/edit.html#heading=h.abc123`);
  await page.waitForTimeout(300); // a clear for the move would land by now
  await expect(panel.locator('.item')).toHaveCount(items);
  expect((await tabEntries(serviceWorker)).map((e) => e.state.pageId)).toEqual([entry!.state.pageId]);

  await page.reload();
  await expect
    .poll(async () => (await tabEntries(serviceWorker)).map((e) => e.state.pageId !== entry!.state.pageId))
    .toEqual([true]);
  // One announcement per load, from the Docs script alone (the generic script stays off Docs).
  const starts = (await activity.messages()).filter((m) => m.type === 'pageStarted');
  expect(starts.map((m) => m.frameId)).toEqual([0, 0]);
});

test('zoom 150%: the underline still sits under its word', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL, '?zoom=1.5');
  await expect(errorUnderlines(page).first()).toBeVisible({ timeout: 5000 });
  await expectUnderlineUnder(page, 'has');
});

test('justified text on the canvas: the underline sits on the painted word, where the line rect alone misses it by over 3 px', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL, '?canvas=1&justify=1');
  await expectUnderlineOnPainted(page, 'has');

  // The same pixels painted where the page-world recorder can't see them: only the line rects place the underline.
  await openDocs(page, pagesURL, '?canvas=1&justify=1&norecorder=1');
  await expect.poll(async () => (await underlineMiss(page, 'has')).left).toBeLessThan(Infinity);
  await page.waitForTimeout(300); // settled
  const svgPath = await underlineMiss(page, 'has');
  expect(svgPath.left).toBeLessThan(Infinity); // still drawn: an underline that vanished misses by Infinity
  expect(svgPath.left).toBeGreaterThan(3);
});

test('justified text on the canvas at 150%: the underline sits on the painted word', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL, '?canvas=1&justify=1&zoom=1.5');
  await expectUnderlineOnPainted(page, 'has');
});

test('scrolled 120 px with no canvas repaint, the re-measured underline still sits on the painted word', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL, '?canvas=1&justify=1');
  await expectUnderlineOnPainted(page, 'has');
  await page.waitForTimeout(300); // settled
  const counts = () =>
    page.evaluate(() => ({ paints: (window as any).fakeDocs.canvasPaints as number, reads: (window as any).fakeDocs.getTextCalls as number }));
  const before = await counts();

  // New lines come into the painted band: the rects re-render (and the underlines are re-measured); the canvas is not repainted.
  await page.locator('.kix-appview-editor').evaluate((el) => (el.scrollTop += 120));
  await expect.poll(async () => (await counts()).reads).toBeGreaterThan(before.reads);
  await page.waitForTimeout(300); // the re-measured underline is drawn
  const miss = await underlineMiss(page, 'has');
  expect(Math.max(miss.left, miss.right)).toBeLessThanOrEqual(1);
  expect((await counts()).paints).toBe(before.paints);
});

test('a bold word on the canvas is underlined on its painted box', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL, '?canvas=1&bold=1');
  await expectUnderlineOnPainted(page, 'has');
});

test('scrolled deep: only painted lines get underlines, and they follow their words', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');

  // At the bottom only the last lines are painted: their text starts far into getText().
  await page.locator('.kix-appview-editor').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expectUnderlineUnder(page, 'go');
  expect(await page.locator('svg rect[aria-label="I has a cat and she likes to sleep on the sofa."]').count()).toBe(0);
  await expect(errorUnderlines(page)).toHaveCount(1);

  await page.locator('.kix-appview-editor').evaluate((el) => (el.scrollTop = 0));
  await expectUnderlineUnder(page, 'has');
});

test('underlines scroll natively with the editor, in the same frame as the text', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  const has = await underlineBoxUnder(page, 'has');

  // Read, scroll and read again in one step: no frame runs in between, so only a native layer can follow.
  const moved = await errorUnderlines(page).evaluateAll(
    (els, has) => {
      const el = els.find((e) => Math.abs(e.getBoundingClientRect().left - has.left) < 1)!;
      const word = () => {
        for (const div of Array.from(document.querySelectorAll('.text-layer div'))) {
          const node = div.firstChild as Text | null;
          const at = node ? node.data.indexOf('I has a cat') : -1;
          if (!node || at === -1) continue;
          const range = document.createRange();
          range.setStart(node, at + 2);
          range.setEnd(node, at + 5);
          return range.getBoundingClientRect();
        }
        throw new Error('no "has"');
      };
      const [u0, t0] = [el.getBoundingClientRect(), word()];
      document.querySelector('.kix-appview-editor')!.scrollTop += 30;
      const [u1, t1] = [el.getBoundingClientRect(), word()];
      return { underline: u1.top - u0.top, text: t1.top - t0.top, x: u1.left - u0.left - (t1.left - t0.left) };
    },
    has,
  );
  expect(moved.text).toBeCloseTo(-30, 0);
  expect(Math.abs(moved.underline - moved.text)).toBeLessThanOrEqual(1);
  expect(Math.abs(moved.x)).toBeLessThanOrEqual(1);
  await expect(page.locator('.kix-appview-editor > englint-field-layer')).toHaveCount(1); // the scroller is the anchor
});

test('scrolling that paints nothing new reads no text: the underlines are not re-measured', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await page.waitForTimeout(500); // settled
  const calls = () => page.evaluate(() => (window as any).fakeDocs.getTextCalls as number);
  const before = await calls();

  // 1 px a frame: the painted lines stay the same, as in live Docs between tile repaints.
  await page.evaluate(async () => {
    const editor = document.querySelector('.kix-appview-editor')!;
    for (let i = 0; i < 5; i++) {
      editor.scrollTop += 1;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(300);
  expect(await calls()).toBe(before);
  await expectUnderlineUnder(page, 'has'); // and it still sits under its word
});

test('the editor resizes and Docs re-centres the page by style: the underline follows (editor resize observer)', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  // A side panel opens: the editor narrows and the page moves left, with no scroll and no tile repaint.
  await page.evaluate(() => {
    (document.querySelector('.kix-appview-editor') as HTMLElement).style.width = '900px';
    (document.querySelector('.kix-page-paginated') as HTMLElement).style.marginLeft = '20px';
  });
  await expectUnderlineUnder(page, 'has');
});

test('a render while the editor is hidden skips the frame: Docs never falls back to the fixed layer for good', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await page.evaluate(async () => {
    const container = document.querySelector('.kix-appview-editor-container') as HTMLElement;
    container.style.display = 'none';
    window.dispatchEvent(new Event('resize')); // a render while hidden
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    container.style.display = '';
  });
  await expectUnderlineUnder(page, 'has');
  await expect(page.locator('.kix-appview-editor > englint-field-layer')).toHaveCount(1); // still its own layer
});

test("a scroll elsewhere on the page doesn't make a later render close the card: it follows its text", async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await pointAt(page, 'has');
  await expect(card(page)).toBeVisible();
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // at rest
  const before = (await card(page).boundingBox())!;

  // A side panel scrolls: it can't move the document's text, and the Docs field doesn't re-render for it.
  await page.evaluate(async () => {
    const panel = document.createElement('div');
    Object.assign(panel.style, { position: 'fixed', right: '0', top: '0', width: '120px', height: '100px', overflow: 'auto' });
    panel.innerHTML = '<div style="height: 600px"></div>';
    document.body.append(panel);
    panel.scrollTop = 50;
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
    // Then the page moves 10px left and a render follows (a window resize).
    (document.querySelector('.kix-page-paginated') as HTMLElement).style.marginLeft = '30px';
    window.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => Math.round((await card(page).boundingBox())?.x ?? NaN)).toBe(Math.round(before.x - 10));
  await expect(card(page)).toBeVisible();
});

test("the underline paints above Docs' tile container (z-index 22, opaque pages): the layer joins that level, after the tiles", async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await page.waitForTimeout(400); // the draw-in is over
  expect(await underlinePainted(page, await underlineBoxUnder(page, 'has'))).toBe(true);
  const z = await page.locator('.kix-appview-editor > englint-field-layer').evaluate((el) => getComputedStyle(el).zIndex);
  expect(z).toBe('22'); // the tiles' own level, later in tree order: under Docs' UI above 22 (23, 41, comments 98)
});

/** Where the editor's field layer is: right after the tile branch, and what comes next (live: the z-41 UI container). */
const layerPlace = (page: Page) =>
  page.evaluate(() => {
    const layer = document.querySelector('.kix-appview-editor > englint-field-layer');
    return {
      layer: !!layer,
      afterTiles: !!layer?.previousElementSibling?.querySelector('.kix-rotatingtilemanager'),
      next: layer?.nextElementSibling?.className ?? null,
    };
  });

test("Docs' floating button (fixed, z-index 23, inside the tile branch) paints over the underlines, and hovering it opens no card", async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, ',', 'world,how');
  await page.waitForTimeout(400); // the draw-in is over
  const u = await underlineBoxUnder(page, ',', 'world,how');
  const [x, y] = [Math.round(u.left + u.width / 2), Math.floor(u.top + u.height / 2)];
  expect(await underlinePainted(page, u)).toBe(true); // control: the probe sees the underline
  // The layer joins the tiles' level (22) right after the tile branch: the button, at 23 inside that branch,
  // stays above it. (Soft checks: each of the three is reported on its own.)
  expect.soft(await layerPlace(page)).toEqual({ layer: true, afterTiles: true, next: 'kix-appview-clipped-ui-elements-container' });

  // Docs' button floats over the word.
  await page.evaluate(
    ({ x, y }) => Object.assign((document.querySelector('.docs-gm3-filled-button') as HTMLElement).style, { left: `${x - 48}px`, top: `${y - 20}px` }),
    { x, y },
  );
  const [r, g, b] = await pixelAt(page, x, y);
  expect.soft(r < 60 && g < 120 && b > 180, `pixel rgb(${r}, ${g}, ${b})`).toBe(true); // #0b57d0, not the red bar

  await page.mouse.move(x, y);
  await page.waitForTimeout(500);
  await expect.soft(card(page)).toHaveCount(0);
  await expect.soft(page.locator('.englint-underline.active')).toHaveCount(0); // no hover tint either
});

test('a layer Docs removes comes back where it was: right after the tile branch, before its z-41 UI container', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await page.evaluate(async () => {
    document.querySelector('.kix-appview-editor > englint-field-layer')!.remove();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  expect(await layerPlace(page)).toEqual({ layer: true, afterTiles: true, next: 'kix-appview-clipped-ui-elements-container' });
  await expectUnderlineUnder(page, 'has');
});

test("Docs' caret (in its z-41 UI container, after the tile branch) paints over the underline", async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await page.waitForTimeout(400); // the draw-in is over
  const u = await underlineBoxUnder(page, 'has');
  const [x, y] = [Math.round(u.left + u.width / 2), Math.floor(u.top + u.height / 2)];
  expect(await underlinePainted(page, u)).toBe(true); // control: the underline shows over the page
  // The caret lands on the underlined word (2px wide, as live).
  await page.evaluate(
    ({ x, y }) => {
      const box = document.querySelector('.kix-appview-clipped-ui-elements-container')!.getBoundingClientRect();
      Object.assign((document.querySelector('.kix-cursor') as HTMLElement).style, { left: `${x - box.left - 1}px`, top: `${y - box.top - 10}px` });
    },
    { x, y },
  );
  const [r, g, b] = await pixelAt(page, x, y);
  expect(Math.max(r, g, b), `pixel rgb(${r}, ${g}, ${b})`).toBeLessThan(60); // the caret's black, not the red bar
});

test('a Docs menu over the text covers its underline, and hovering there opens no card', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await page.waitForTimeout(400); // any drawing animation is over
  const u = await underlineBoxUnder(page, 'has');
  const [x, y] = [Math.round(u.left + u.width / 2), Math.floor(u.top + u.height / 2)];
  const red = ([r, g, b]: number[]) => r! > 150 && g! < 120 && b! < 120;
  expect(red(await pixelAt(page, x, y))).toBe(true); // control: the probe sees the underline

  // Docs' menus are popups at body level with a z-index, not children of the editor.
  await page.evaluate(
    ({ x, y }) => {
      const menu = document.createElement('div');
      menu.className = 'goog-menu';
      Object.assign(menu.style, {
        position: 'absolute',
        left: `${x - 40}px`,
        top: `${y - 20}px`,
        width: '120px',
        height: '60px',
        background: '#ffffff',
        zIndex: '1000',
      });
      document.body.append(menu);
    },
    { x, y },
  );
  const [r, g, b] = await pixelAt(page, x, y);
  expect(Math.min(r, g, b)).toBeGreaterThan(240); // the menu, not the underline

  await page.mouse.move(x, y);
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
});

test('a repaint that drops and re-adds an underline does not replay its draw-in', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  // Count every underline that gets the draw-in class, from before the first one: the editor's field layer
  // (its shadow root is open in the e2e build) is watched as soon as it is added.
  await page.evaluate(() => {
    const w = window as any;
    w.__draws = 0;
    const note = (records: MutationRecord[]) => {
      for (const m of records) {
        for (const el of m.type === 'attributes' ? [m.target] : Array.from(m.addedNodes)) {
          if (!(el instanceof Element) || !el.matches('.englint-underline.draw')) continue;
          if (m.type === 'attributes' && /\bdraw\b/.test(m.oldValue ?? '')) continue;
          w.__draws++;
        }
      }
    };
    const watched = new WeakSet<ShadowRoot>();
    new MutationObserver(() => {
      const root = document.querySelector('englint-field-layer')?.shadowRoot;
      if (!root || watched.has(root)) return;
      watched.add(root);
      new MutationObserver(note).observe(root, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  await expectUnderlineUnder(page, 'has');
  const drawsNow = () => page.evaluate(() => (window as any).__draws as number);
  await expect.poll(drawsNow).toBe(2); // "has" and the comma, each once

  // Deep: line 1 is no longer painted (its rects go); "go" is shown for the first time and draws in.
  await page.locator('.kix-appview-editor').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expectUnderlineUnder(page, 'go');
  await expect.poll(drawsNow).toBe(3);
  // Back up: Docs repaints line 1 and its rects come back, but "has" was shown before.
  await page.locator('.kix-appview-editor').evaluate((el) => (el.scrollTop = 0));
  await expectUnderlineUnder(page, 'has');
  await page.waitForTimeout(300);
  expect(await drawsNow()).toBe(3);
});

test('accepting from the card pastes the fix through the text-event iframe', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');

  await pointAt(page, 'has');
  await expect(card(page)).toBeVisible();
  await page.locator('.englint-card-accept').click();

  await expect.poll(() => docText(page)).toContain('I have a cat');
  expect(await page.evaluate(() => (window as any).fakeDocs.pastes)).toEqual(['have']);
  await expect(errorUnderlines(page)).toHaveCount(1); // the comma's remains
  await expect(page.locator('.englint-notice')).toBeHidden(); // no "Couldn't apply here"
});

test('a fix with an edge space is pasted with NBSP, which Docs keeps as a space', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, ',', 'world,how');
  const [entry] = await tabEntries(serviceWorker);
  const comma = entry!.state.fields.gdocs.find((i: any) => i.original === ',');

  const reply = await toContent(serviceWorker, entry!.tabId, 'applyFix', { fieldId: 'gdocs', issueId: comma.id });
  expect(reply).toEqual({ res: { ok: true } });
  expect(await page.evaluate(() => (window as any).fakeDocs.pastes)).toEqual([',\u00a0']);
  expect(await docText(page)).toContain('Hello world, how are you.'); // live Docs: NBSP lands as a plain space
});

test('panel acceptAllErrors fixes every Docs error', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  const [entry] = await tabEntries(serviceWorker);

  const reply = await toContent(serviceWorker, entry!.tabId, 'acceptAllErrors', { fieldId: 'gdocs' });
  expect(reply).toEqual({ res: { applied: 3, failed: 0 } });
  const text = await docText(page);
  expect(text).toContain('I have a cat');
  expect(text).toContain('Hello world, how');
  expect(text).toContain('She goes home');
  await expect(errorUnderlines(page)).toHaveCount(0);
});

test('fallback: a paint that does not match shows the notice and the D badge; the next click recovers', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL, '?paint=mismatch');

  await expect(page.locator('.englint-notice')).toHaveText(FALLBACK_NOTICE, { timeout: 10_000 });
  const [entry] = await tabEntries(serviceWorker);
  expect(entry!.state.status).toBe('docs_fallback');
  const badge = await serviceWorker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), entry!.tabId);
  expect(badge).toBe('D');
  await expect(errorUnderlines(page)).toHaveCount(0);

  // Docs starts painting properly; the user's next interaction re-asks.
  await page.evaluate(() => (window as any).fakeDocs.setPaint('ok'));
  await page.mouse.click(600, 300);
  await expect(page.locator('.englint-notice')).toBeHidden({ timeout: 10_000 });
  await expectUnderlineUnder(page, 'has');
  await expect
    .poll(() => serviceWorker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), entry!.tabId))
    .not.toBe('D');
  expect((await tabEntries(serviceWorker))[0]!.state.status).not.toBe('docs_fallback');
});

test('a slow cold load (no line rects for 8 s) ends up live with no click, and the fallback notice never shows', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL, '?paintDelay=8000');
  await expect.poll(() => page.evaluate(() => typeof (window as any)._docs_annotate_getAnnotatedText)).toBe('function');

  // No interaction at all: the page is left alone while Docs takes its time to paint.
  const deadline = Date.now() + 20_000;
  while ((await errorUnderlines(page).count()) === 0) {
    expect(await page.locator('.englint-notice').isVisible(), 'the fallback notice showed while Docs was still painting').toBe(false);
    if (Date.now() > deadline) throw new Error('no underline 20 s after load');
    await page.waitForTimeout(250);
  }
  await expectUnderlineUnder(page, 'has');
  await expect(page.locator('.englint-notice')).toBeHidden();
  expect((await tabEntries(serviceWorker))[0]!.state.status).not.toBe('docs_fallback');
});

test('a switched-off Docs site shows the off badge and sends nothing', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(docsErrors);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['127.0.0.1'] }));
  await openDocs(page, pagesURL);
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);
  await expect.poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('off');
  await page.waitForTimeout(2500);
  expect(mock.requests).toEqual([]);
  await expect(errorUnderlines(page)).toHaveCount(0);
});

test('a Docs page that is not the editor (the docs list) gets no checking and no fallback', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(docsErrors);
  await page.goto(`${pagesURL}/document/u/0/index.html`);
  // The flag is set and the API answers there, so the old gate fell back after its 5 s paint wait.
  await expect.poll(() => page.evaluate(() => typeof (window as any)._docs_annotate_getAnnotatedText)).toBe('function');
  await page.waitForTimeout(7000);
  await expect(page.locator('.englint-notice')).toHaveCount(0);
  expect(await tabEntries(serviceWorker)).toEqual([]);
  expect(mock.requests).toEqual([]);
});

test('typing in the doc re-checks the changed paragraph', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  const sent = () => mock.requests.flatMap((body) => paragraphsOf(body).map((p) => p.text));

  const line = await wordBox(page, 'sofa.');
  await page.mouse.click(line.right + 20, line.lineBottom - 8); // the caret goes to the end of that line
  await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toContain('docs-texteventtarget-iframe');
  await page.keyboard.type(' Yes');
  await expect.poll(() => docText(page)).toContain('on the sofa. Yes\n');
  await expect.poll(sent).toContain('I has a cat and she likes to sleep on the sofa. Yes');
  await expectUnderlineUnder(page, 'has');
});

test('a typed character costs at most 18 text reads through the bridge with the badge showing, its check included', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  const line = await wordBox(page, 'sofa.');
  await page.mouse.click(line.right + 20, line.lineBottom - 8); // the caret goes to the end of that line
  await expect(page.locator('.englint-badge')).toBeVisible();
  await page.waitForTimeout(1500); // settled: the click's selection settle has measured the caret's line
  const calls = () => page.evaluate(() => (window as any).fakeDocs.getTextCalls as number);
  const checks = mock.requests.length;
  const before = await calls();

  await page.keyboard.type('s');
  // The edit's frames, its selection settle (150 ms), the check 1 s later, its answer and the redraw after it.
  await page.waitForTimeout(1500);
  expect(mock.requests).toHaveLength(checks + 1); // the check ran inside the window
  // Observed 16, or 17 when the keyup lands after the edit's frame (one more change-detection read); the bound leaves
  // one read of headroom for load. The old path read 19. The badge's caret line is
  // measured after the edit, after the selection settles, and after the answer: three reads each. Docs redrawing its
  // lines doesn't measure it (that would add three).
  expect((await calls()) - before).toBeLessThanOrEqual(18);
});

/** Opens the card of "has" (19..22) with a caret key, as a user would: pinned, no pointer involved. */
async function openHasCardAtCaret(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).fakeDocs.selection = { start: 20, end: 20 };
    (document.querySelector('iframe.docs-texteventtarget-iframe') as HTMLIFrameElement).contentDocument!
      .querySelector<HTMLElement>('[contenteditable="true"]')!
      .focus();
  });
  await page.keyboard.press('ArrowRight');
  await expect(card(page)).toBeVisible();
}

test('a caret key inside an issue opens its card', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await openHasCardAtCaret(page);
  await expect(page.locator('.englint-card-preview ins')).toHaveText('have');
});

test('Esc in the doc closes the card', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await openHasCardAtCaret(page);

  await page.keyboard.press('Escape'); // lands in the text-event iframe, like every key in Docs
  await expect(card(page)).toBeHidden();
  await expectUnderlineUnder(page, 'has'); // the issue is still there: only the card closed
});

test('typing elsewhere in the doc closes the card', async ({ page, pagesURL, mock }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');
  await openHasCardAtCaret(page);

  // The caret moves to another paragraph (as a click would), and the user types there.
  await page.evaluate(() => {
    const at = (window as any).fakeDocs.text().indexOf('Filler paragraph 3') + 'Filler'.length;
    (window as any).fakeDocs.selection = { start: at, end: at };
  });
  await page.keyboard.type('s');
  await expect(card(page)).toBeHidden();
  await expect.poll(() => docText(page)).toContain('Fillers paragraph 3');
  await expectUnderlineUnder(page, 'has');
});

test('the undo chip in the doc: typing leaves it, Esc closes it (both keys land in the text-event iframe)', async ({ page, pagesURL, mock, serviceWorker }) => {
  const CAT: Issue = { ...HAS, original: 'cat', replacement: 'cot', before: 'I has a', category: 'spelling', kind: 'spelling', reason: 'r' };
  mock.respond(issuesFor((t) => (t.includes('I has a cat') ? [CAT] : [])));
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'cat');
  await pointAt(page, 'cat');
  await pickFromMenu(page, 'Add “cat” to dictionary');
  const chip = page.locator('.englint-undo');
  await expect(chip).toHaveText('Added “cat” to your dictionary.Undo');
  await expect(errorUnderlines(page)).toHaveCount(0);
  expect(await serviceWorker.evaluate(() => chrome.storage.local.get('dictionary'))).toEqual({ dictionary: ['cat'] });

  // Typing in another paragraph, with focus in the text-event iframe as while editing: the chip stays.
  await page.evaluate(() => {
    const at = (window as any).fakeDocs.text().indexOf('Filler paragraph 3') + 'Filler'.length;
    (window as any).fakeDocs.selection = { start: at, end: at };
    (document.querySelector('iframe.docs-texteventtarget-iframe') as HTMLIFrameElement).contentDocument!
      .querySelector<HTMLElement>('[contenteditable="true"]')!
      .focus();
  });
  await page.keyboard.type('s');
  await expect.poll(() => docText(page)).toContain('Fillers paragraph 3');
  await expect(chip).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(chip).toHaveCount(0);
  expect(await serviceWorker.evaluate(() => chrome.storage.local.get('dictionary'))).toEqual({ dictionary: ['cat'] }); // closed, not undone
});

/** A rule-eligible clarity suggestion on the second line: its card has Accept, Dismiss and "Stop suggesting wordy phrases" in its menu. */
const SLEEP: Issue = {
  original: 'likes to sleep',
  replacement: 'sleeps',
  before: 'I has a cat and she',
  category: 'clarity',
  severity: 'suggestion',
  kind: 'wordy_phrase',
  reason: 'r',
};
const suggestionUnderlines = (page: Page) => page.locator('.englint-underline.fam-clarity');
const settled = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));
/** Card.tsx: the gap between the text and the card, and the card's margin from the viewport's edges. */
const CARD_GAP = 6;
const CARD_MARGIN = 8;

test('the card keeps the side it opened on: near the bottom edge, moving onto it neither moves nor closes it', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  mock.respond(issuesFor((t) => (t.includes('likes to sleep') ? [SLEEP] : [])));
  await openDocs(page, pagesURL);
  await expect(suggestionUnderlines(page)).toHaveCount(1, { timeout: 5000 });

  // Its full height, from an open with room below.
  await pointAt(page, 'sleep');
  await expect(card(page)).toBeVisible();
  await settled(page, '.englint-card');
  const roomy = (await card(page).boundingBox())!;
  const height = await card(page).evaluate((el) => (el as HTMLElement).offsetHeight); // what Card.tsx places by (a fraction rounded)
  expect(await card(page).getAttribute('data-side')).toBe('below');
  const textBottom = roomy.y - CARD_GAP;
  await page.mouse.move(1200, 60);
  await expect(card(page)).toHaveCount(0);

  // A viewport just 1 px too short for the card below its text.
  await page.setViewportSize({ width: 1280, height: Math.ceil(textBottom + CARD_GAP + height + CARD_MARGIN) - 1 });
  await pointAt(page, 'sleep');
  await expect(card(page)).toBeVisible();
  const opened = await card(page).evaluate((el) => ({ side: el.dataset.side, top: el.style.top }));

  // The pointer heads for the card where it opened, and rests on its bottom row.
  const bar = (await card(page).locator('.englint-card-actions').boundingBox())!;
  await page.mouse.move(bar.x + 20, bar.y + bar.height / 2, { steps: 4 });
  await page.waitForTimeout(400); // past the close delay
  await expect(card(page)).toBeVisible();
  expect(await card(page).evaluate((el) => ({ side: el.dataset.side, top: el.style.top }))).toEqual(opened);
  expect(opened.side).toBe('above'); // it never fit below, at any point of its enter animation
});

test('Undo in the doc: "Stop suggesting …" hides the underline, and Undo on the chip brings it back', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  mock.respond(issuesFor((t) => (t.includes('likes to sleep') ? [SLEEP] : [])));
  await openDocs(page, pagesURL);
  await expect(suggestionUnderlines(page)).toHaveCount(1, { timeout: 5000 });
  const requests = mock.requests.length;

  await pointAt(page, 'sleep');
  await pickFromMenu(page, 'Stop suggesting wordy phrases');
  await expect(suggestionUnderlines(page)).toHaveCount(0);
  const chip = page.locator('.englint-undo');
  await expect(chip).toHaveText('Stopped suggesting wordy phrases.Undo');
  expect(await serviceWorker.evaluate(() => chrome.storage.local.get('rules'))).toEqual({ rules: [{ mode: 'standard', kind: 'wordy_phrase' }] });

  await chip.getByRole('button', { name: 'Undo' }).click();
  await expect(chip).toHaveCount(0);
  await expectUnderlineUnder(page, 'likes to sleep', 'likes to sleep', suggestionUnderlines(page));
  expect(await serviceWorker.evaluate(() => chrome.storage.local.get('rules'))).toEqual({ rules: [] });
  expect(mock.requests.length).toBe(requests); // re-filtered from the held results
});

test('near the bottom of the viewport the card opens above its text, and the undo chip takes its place there', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  mock.respond(issuesFor((t) => (t.includes('likes to sleep') ? [SLEEP] : [])));
  await openDocs(page, pagesURL);
  await expect(suggestionUnderlines(page)).toHaveCount(1, { timeout: 5000 });
  // Room below the text for the short chip, not for the card.
  const word = await wordBox(page, 'likes to sleep');
  await page.setViewportSize({ width: 1280, height: Math.round(word.lineBottom + CARD_GAP + CARD_MARGIN + 60) });

  await pointAt(page, 'sleep');
  await expect(card(page)).toBeVisible();
  await settled(page, '.englint-card');
  expect(await card(page).getAttribute('data-side')).toBe('above');
  const cardBox = (await card(page).boundingBox())!;

  await pickFromMenu(page, 'Stop suggesting wordy phrases');
  const chip = page.locator('.englint-undo');
  await expect(chip).toBeVisible();
  await settled(page, '.englint-undo');
  const chipBox = (await chip.boundingBox())!;
  expect(await chip.getAttribute('data-side')).toBe('above');
  // Where the card was: its left edge, and its edge nearest the text (the bottom, above the text).
  expect(Math.abs(chipBox.x - cardBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(chipBox.y + chipBox.height - (cardBox.y + cardBox.height))).toBeLessThanOrEqual(1);
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(word.top);
});

test('a deletion pastes a neighbouring character over a widened range', async ({ page, pagesURL, mock, serviceWorker }) => {
  const ONE: Issue = {
    ...HAS,
    original: 'one ',
    replacement: '',
    before: 'This line starts with',
    category: 'word_choice',
    kind: 'extra_word',
    reason: 'Not needed.',
  };
  mock.respond(issuesFor((t) => (t.includes('starts with one leading') ? [ONE] : [])));
  await openDocs(page, pagesURL);
  await expect(errorUnderlines(page).first()).toBeVisible({ timeout: 5000 });
  const [entry] = await tabEntries(serviceWorker);
  const issue = entry!.state.fields.gdocs.find((i: any) => i.original === 'one ');

  const reply = await toContent(serviceWorker, entry!.tabId, 'applyFix', { fieldId: 'gdocs', issueId: issue.id });
  expect(reply).toEqual({ res: { ok: true } });
  // The fake ignores an empty paste: "one l" is replaced with the "l" that followed it.
  expect(await page.evaluate(() => (window as any).fakeDocs.pastes)).toEqual(['l']);
  expect(await docText(page)).toContain('This line starts with leading space');
  await expect(errorUnderlines(page)).toHaveCount(0);
});

test('when Docs replaces its editor element, checking re-attaches to the new one', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(docsErrors);
  await openDocs(page, pagesURL);
  await expectUnderlineUnder(page, 'has');

  await page.evaluate(() => (window as any).fakeDocs.replaceEditor());
  await expect(page.locator('.kix-appview-editor')).toHaveCount(1);
  // The old field finds out on its next update (its element left the page) and detaches; a new one attaches.
  const line = await wordBox(page, 'sofa.');
  await page.mouse.click(line.right + 20, line.lineBottom - 8);
  await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toContain('docs-texteventtarget-iframe');
  await page.keyboard.type(' Yes');
  await expect.poll(() => docText(page)).toContain('on the sofa. Yes\n');
  await expectUnderlineUnder(page, 'has');

  // The new adapter follows the new editor's scrolling.
  await page.locator('.kix-appview-editor').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expectUnderlineUnder(page, 'go');
  const [entry] = await tabEntries(serviceWorker);
  expect(Object.keys(entry!.state.fields)).toEqual(['gdocs']);
});

const selectionBar = (page: Page) => page.locator('.englint-bar');
/** Selection bar geometry: its gap from the selection. */
const BAR_GAP = 6;

type HighlightBox = { left: number; right: number; top: number; bottom: number };
const highlightBox = (page: Page): Promise<HighlightBox | null> => page.evaluate(() => (window as any).__highlightBox);

async function doubleClickWord(page: Page, word: string): Promise<void> {
  const box = await paintedBox(page, word);
  await page.mouse.dblclick((box.left + box.right) / 2, (box.top + box.bottom) / 2);
}

/** How far the bar misses sitting just above `box` (or just below it, when there's no room above). */
async function barMiss(page: Page, box: HighlightBox): Promise<{ x: number; y: number; side: string }> {
  const bar = (await selectionBar(page).boundingBox())!;
  const side = (await selectionBar(page).getAttribute('data-side')) ?? '';
  const y = side === 'below' ? bar.y - (box.bottom + BAR_GAP) : bar.y + bar.height + BAR_GAP - box.top;
  return { x: bar.x - box.left, y, side };
}

test('a double-clicked word on the canvas gets the selection bar just above its painted highlight', async ({ page, pagesURL }) => {
  await openDocs(page, pagesURL, '?canvas=1&justify=1');
  await expect(page.locator('.kix-appview-editor')).toBeVisible();
  await doubleClickWord(page, 'cat');
  await expect(selectionBar(page)).toBeVisible({ timeout: 3000 });

  const highlight = (await highlightBox(page))!;
  expect(highlight).not.toBeNull();
  const miss = await barMiss(page, highlight);
  expect(Math.abs(miss.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(miss.y)).toBeLessThanOrEqual(1);
});

test('collapsing the selection hides the bar placed from the highlight', async ({ page, pagesURL }) => {
  await openDocs(page, pagesURL, '?canvas=1&justify=1');
  await doubleClickWord(page, 'cat');
  await expect(selectionBar(page)).toBeVisible({ timeout: 3000 });
  const line = await paintedBox(page, 'sofa.');
  await page.mouse.click(line.right + 20, (line.top + line.bottom) / 2);
  await expect.poll(() => highlightBox(page)).toBeNull(); // Docs repainted the tile without the highlight
  await page.waitForTimeout(500); // past the selection debounce: a bar for a stale selection would be up by now
  await expect(selectionBar(page)).toHaveCount(0);
});

test('when the highlight is not visible to the page (no recorder), the bar is still placed from the range', async ({ page, pagesURL }) => {
  await openDocs(page, pagesURL, '?canvas=1&norecorder=1');
  await doubleClickWord(page, 'cat');
  await expect(selectionBar(page)).toBeVisible({ timeout: 3000 });
  const highlight = (await highlightBox(page))!;
  const miss = await barMiss(page, highlight);
  expect(Math.abs(miss.x)).toBeLessThanOrEqual(12);
  expect(Math.abs(miss.y)).toBeLessThanOrEqual(12);
});
