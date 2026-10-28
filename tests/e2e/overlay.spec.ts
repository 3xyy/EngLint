import type { Locator, Page } from '@playwright/test';
import { clarityOn, expect, test } from './fixtures';
import { type MockReply, paragraphsOf } from './mock-anthropic';
import { rgba, underlinePainted } from './pixels';

// The underline layer (overlay/anchor.ts, overlay/field-layer.ts): each field's underlines live inside the
// page's scrolled content, so the browser scrolls them with the text in the same frame. pages/scroll.html
// has a field per anchor case. The e2e build opens the field layer's shadow root so locators reach it.

const HAS = {
  original: 'has',
  replacement: 'have',
  before: 'I',
  category: 'grammar',
  severity: 'error',
  kind: 'subject_verb_agreement',
  reason: 'Use "have" with "I".',
};

const hasCat = async (body: any): Promise<MockReply> => ({
  results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: p.text.includes('I has a cat') ? [HAS] : [] })),
});

const underlines = (page: Page) => page.locator('.englint-underline');
const errorUnderline = (page: Page) => page.locator('.englint-underline.error');

async function typeIn(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).click();
  await page.keyboard.type(text);
}

/** How the text moves in a sync-scroll probe: its element's box, or (contenteditable) the word's own range. */
type TextProbe = { selector: string; word?: string };

/**
 * In one synchronous step: reads the underline's and the text's boxes, scrolls `scroller` (a selector, or
 * 'window') by `by` px, and reads both again. No frame runs in between, so only an underline the browser
 * scrolls itself (native) can have moved.
 */
async function scrollInOneStep(underline: Locator, text: TextProbe, scroller: string, by: number) {
  return underline.evaluate(
    (el, { text, scroller, by }) => {
      const textBox = () => {
        const host = document.querySelector(text.selector)!;
        if (!text.word) return host.getBoundingClientRect();
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          const at = n.data.indexOf(text.word);
          if (at === -1) continue;
          const range = document.createRange();
          range.setStart(n, at);
          range.setEnd(n, at + text.word.length);
          return range.getBoundingClientRect();
        }
        throw new Error(`${text.word} not found`);
      };
      const u0 = el.getBoundingClientRect();
      const t0 = textBox();
      if (scroller === 'window') window.scrollBy(0, by);
      else document.querySelector(scroller)!.scrollTop += by;
      const u1 = el.getBoundingClientRect();
      const t1 = textBox();
      return { underline: { x: u1.left - u0.left, y: u1.top - u0.top }, text: { x: t1.left - t0.left, y: t1.top - t0.top } };
    },
    { text, scroller, by },
  );
}

/**
 * The underline sits under "has" of "I has a cat." in a 16px/24px monospace field with 1px border, 8px
 * padding: at the word's x, at the bottom of its glyph box inside the first 24px line.
 */
async function expectUnderHas(page: Page, field: string): Promise<void> {
  const want = await page.evaluate((field) => {
    const box = document.querySelector(field)!.getBoundingClientRect();
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = '16px monospace';
    return { left: box.left + 9 + ctx.measureText('I ').width, width: ctx.measureText('has').width, lineBottom: box.top + 9 + 24 };
  }, field);
  const u = (await errorUnderline(page).boundingBox())!;
  expect(Math.abs(u.x - want.left)).toBeLessThan(2);
  expect(Math.abs(u.width - want.width)).toBeLessThan(2);
  expect(u.y + u.height).toBeLessThanOrEqual(want.lineBottom + 1);
  expect(u.y + u.height).toBeGreaterThan(want.lineBottom - 8);
}

async function expectMovesWithText(underline: Locator, text: TextProbe, scroller: string, by = 40) {
  const moved = await scrollInOneStep(underline, text, scroller, by);
  expect(moved.text.y).toBeCloseTo(-by, 0); // the scroll happened
  expect(Math.abs(moved.underline.y - moved.text.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(moved.underline.x - moved.text.x)).toBeLessThanOrEqual(1);
}

test.describe('underlines scroll natively with the text', () => {
  test('a textarea inside a positioned, scrollable box', async ({ page, pagesURL, mock }) => {
    mock.respond(hasCat);
    await page.goto(`${pagesURL}/scroll.html`);
    await typeIn(page, '#pos-ta', 'I has a cat.');
    await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
    await expectUnderHas(page, '#pos-ta');
    await expectMovesWithText(errorUnderline(page), { selector: '#pos-ta' }, '#pos-ta-box');
    await expectUnderHas(page, '#pos-ta');
    await expect(page.locator('#pos-ta-box > englint-field-layer')).toHaveCount(1); // the box is the anchor
  });

  test('a contenteditable inside a positioned, scrollable box', async ({ page, pagesURL, mock }) => {
    mock.respond(hasCat);
    await page.goto(`${pagesURL}/scroll.html`);
    await typeIn(page, '#pos-ce', 'I has a cat.');
    await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
    await expectUnderHas(page, '#pos-ce');
    await expectMovesWithText(errorUnderline(page), { selector: '#pos-ce', word: 'has' }, '#pos-ce-box');
    await expectUnderHas(page, '#pos-ce');
    await expect(page.locator('#pos-ce-box > englint-field-layer')).toHaveCount(1);
  });

  test('a textarea on a plain long page (document scroll)', async ({ page, pagesURL, mock }) => {
    mock.respond(hasCat);
    await page.goto(`${pagesURL}/scroll.html`);
    await typeIn(page, '#doc-ta', 'I has a cat.');
    await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
    await expectUnderHas(page, '#doc-ta');
    await expectMovesWithText(errorUnderline(page), { selector: '#doc-ta' }, 'window', 60);
    await expectUnderHas(page, '#doc-ta');
    await expect(page.locator('html > englint-field-layer')).toHaveCount(1); // the document is the anchor
  });
});

test('fallback: in a scrollable box that is not positioned, the underline is redrawn in place after the scroll', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#static-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect(page.locator('englint-field-layer')).toHaveCount(0); // no anchor: the fixed layer, as before

  const offset = async () => {
    const [u, t] = [await errorUnderline(page).boundingBox(), await page.locator('#static-ta').boundingBox()];
    return { x: u!.x - t!.x, y: u!.y - t!.y };
  };
  const before = await offset();
  const textBefore = (await page.locator('#static-ta').boundingBox())!.y;
  await page.evaluate(async () => {
    document.querySelector('#static-box')!.scrollTop += 40;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  expect((await page.locator('#static-ta').boundingBox())!.y).toBeCloseTo(textBefore - 40, 0);
  const after = await offset();
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
});

test('a field slotted through a closed shadow root into a static scroller there: the fixed-layer fallback', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#slot-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expectUnderHas(page, '#slot-ta');
  await expect(page.locator('englint-field-layer')).toHaveCount(0); // none anywhere we can see
  expect(await page.evaluate(() => document.querySelector('#slot-host')!.children.length)).toBe(1); // nothing of ours in the host
});

test('a layer the page removed comes back on the next render', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  const before = (await errorUnderline(page).boundingBox())!;

  // An SPA re-render throws our element away (checked in the same step: the parent watch puts it back fast).
  const removed = await page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('englint-field-layer'));
    hosts.forEach((h) => h.remove());
    return { count: hosts.length, gone: hosts.every((h) => !h.isConnected) };
  });
  expect(removed).toEqual({ count: 1, gone: true });

  await page.evaluate(() => window.dispatchEvent(new Event('resize'))); // any render
  await expect(errorUnderline(page)).toBeVisible();
  await expect(page.locator('#pos-ta-box > englint-field-layer')).toHaveCount(1);
  const after = (await errorUnderline(page).boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
});

const card = (page: Page) => page.locator('.englint-card');

/** Moves the real pointer onto the middle of the first error underline. */
async function pointAtUnderline(page: Page): Promise<void> {
  const box = (await errorUnderline(page).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test('text scrolled out of its box keeps its underline, but hovering where it is hidden opens no card', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });

  await page.locator('#pos-ta-box').evaluate((el) => (el.scrollTop = 140));
  const u = (await errorUnderline(page).boundingBox())!;
  const boxTop = (await page.locator('#pos-ta-box').boundingBox())!.y;
  expect(u.y + u.height).toBeLessThan(boxTop); // above the box's view: drawn, and clipped by the box
  await page.mouse.move(u.x + u.width / 2, u.y + u.height / 2);
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);

  // Back in view, the same hover opens the card.
  await page.locator('#pos-ta-box').evaluate((el) => (el.scrollTop = 0));
  await pointAtUnderline(page);
  await expect(card(page)).toBeVisible();
});

test('an open card closes when a scroll moves its text', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAtUnderline(page);
  await expect(card(page)).toBeVisible();

  await page.locator('#pos-ta-box').evaluate((el) => (el.scrollTop += 10));
  await expect(card(page)).toBeHidden({ timeout: 500 });
});

test('a card with focus in it follows its text when the page scrolls', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAtUnderline(page);
  await expect(card(page)).toBeVisible();
  await page.locator('.englint-card-accept').focus(); // a keyboard user in the card
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // at rest
  const before = (await card(page).boundingBox())!;

  await page.locator('#pos-ta-box').evaluate((el) => (el.scrollTop += 10));
  await expect.poll(async () => Math.round((await card(page).boundingBox())?.y ?? NaN)).toBe(Math.round(before.y - 10));
  await expect(card(page)).toBeVisible();
});

test('a hover whose text scrolls away before the delay opens no card', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAtUnderline(page);
  await page.locator('#pos-ta-box').evaluate((el) => (el.scrollTop += 20)); // the word leaves the pointer
  await page.waitForTimeout(600);
  await expect(card(page)).toHaveCount(0);
});

// ---- Part B: bolder, animated underlines with instant hover feedback ----

/**
 * In the page: records, per class, when an element with it first appeared in any of our shadow roots (the
 * overlay's and the field layers', open in the e2e build), and every time an underline got `draw`.
 */
async function recordOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__first = {} as Record<string, number>;
    w.__boxes = {} as Record<string, unknown>;
    w.__draws = 0;
    w.__styles = {} as Record<string, unknown>;
    const watched = new WeakSet<Node>();
    const roots = (): ShadowRoot[] =>
      Array.from(document.querySelectorAll('*')).flatMap((el) => (el.shadowRoot ? [el.shadowRoot] : []));
    const note = (records: MutationRecord[]) => {
      const t = performance.now();
      for (const r of roots()) {
        for (const cls of ['englint-tint', 'englint-card', 'englint-flash']) {
          const el = r.querySelector(`.${cls}`);
          if (cls === 'englint-tint' && !('tint-out' in w.__first) && r.querySelector('.englint-tint.out')) w.__first['tint-out'] = t;
          if (cls in w.__first || !el) continue;
          w.__first[cls] = t;
          w.__boxes[cls] = { ...el.getBoundingClientRect().toJSON(), host: r.host.tagName.toLowerCase() };
        }
      }
      for (const m of records) {
        const els = m.type === 'attributes' ? [m.target] : Array.from(m.addedNodes);
        for (const el of els) {
          if (el instanceof Element && el.matches('.englint-underline.draw')) {
            const was = m.type === 'attributes' ? (m.oldValue ?? '') : '';
            if (!/\bdraw\b/.test(was)) w.__draws++;
            w.__styles.draw ??= getComputedStyle(el, '::before').animationName; // while the class is set
          }
          if (el instanceof Element && el.matches('.englint-card')) {
            const cs = getComputedStyle(el);
            w.__styles.card ??= { name: cs.animationName, transform: cs.transform };
          }
        }
      }
    };
    const watch = () => {
      for (const r of roots()) {
        if (watched.has(r)) continue;
        watched.add(r);
        new MutationObserver(note).observe(r, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
      }
    };
    watch();
    new MutationObserver(watch).observe(document.documentElement, { childList: true, subtree: true });
  });
}

/** Computed styles taken the moment each element appeared: the draw-in's `::before` animation, the card's. */
const appearedStyles = (page: Page) => page.evaluate(() => (window as any).__styles as Record<string, unknown>);
const frames = (page: Page, n = 2) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  }, n);
const firstSeen = (page: Page) => page.evaluate(() => (window as any).__first as Record<string, number>);
const draws = (page: Page) => page.evaluate(() => (window as any).__draws as number);
/** The box of the first element with `cls`, when it appeared, and the tag of the shadow host it was in. */
const firstBox = (page: Page, cls: string) =>
  page.evaluate((cls) => (window as any).__boxes[cls] as (DOMRect & { host: string }) | undefined, cls);

test('hover tints the word and thickens its underline at once; the card follows after the delay', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await recordOverlay(page);
  const u = (await errorUnderline(page).boundingBox())!;

  await page.mouse.move(u.x + u.width / 2, u.y + u.height / 2);
  // The very next frame: the pointer frame has run.
  const now = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(r));
    const roots = [document, ...Array.from(document.querySelectorAll('*')).flatMap((el) => (el.shadowRoot ? [el.shadowRoot] : []))];
    const has = (sel: string) => roots.some((r) => r.querySelector(sel));
    return { tint: has('.englint-tint.error'), active: has('.englint-underline.error.active'), card: has('.englint-card') };
  });
  expect(now).toEqual({ tint: true, active: true, card: false });

  await expect(card(page)).toBeVisible();
  const t = await firstSeen(page);
  const delay = t['englint-card']! - t['englint-tint']!;
  expect(delay).toBeGreaterThan(165); // the card opens 180 ms after the hover began
  expect(delay).toBeLessThan(235);
  // The tint covers the word's full line box (the underline is its bottom strip), and stays while the card is open.
  const tint = (await page.locator('.englint-tint').boundingBox())!;
  expect(Math.abs(tint.x - u.x)).toBeLessThan(1);
  expect(Math.abs(tint.width - u.width)).toBeLessThan(1);
  expect(tint.height).toBeGreaterThan(12);
  expect((await errorUnderline(page).boundingBox())!.height).toBeCloseTo(3, 0);

  // Leaving both: when the card closes, the tint fades out (it stays a moment, marked out), then goes.
  const far = (await page.locator('#far').boundingBox())!;
  await page.mouse.move(far.x + 5, far.y + 5);
  await expect(card(page)).toBeHidden({ timeout: 1000 });
  await expect(page.locator('.englint-tint')).toHaveCount(0, { timeout: 500 });
  await expect(page.locator('.englint-underline.active')).toHaveCount(0);
  expect('tint-out' in (await firstSeen(page))).toBe(true);
});

test('underline styles: a 2px solid line in the Correctness colour, 2px dots in the Clarity colour; hovered, 3px under a multiply tint', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await clarityOn(serviceWorker);
  const WORDY = { ...HAS, original: 'In order to', replacement: 'To', before: '', category: 'clarity', severity: 'suggestion', kind: 'wordy_phrase' };
  mock.respond(async (body: any) => ({
    results: paragraphsOf(body).map((p) => ({
      paragraph_id: p.id,
      issues: [...(p.text.includes('I has a cat') ? [HAS] : []), ...(p.text.includes('In order to') ? [WORDY] : [])],
    })),
  }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'I has a cat.\nIn order to win, we practice.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.englint-underline.suggestion')).toBeVisible();
  const style = (sel: string, pseudo?: string) =>
    page.locator(sel).first().evaluate((el, pseudo) => {
      const cs = getComputedStyle(el, pseudo);
      return { height: el.getBoundingClientRect().height, color: cs.backgroundColor, image: cs.backgroundImage, radius: cs.borderTopLeftRadius, blend: cs.mixBlendMode };
    }, pseudo);

  expect(await style('.englint-underline.error', '::before')).toMatchObject({ height: 2, color: 'rgb(229, 72, 77)', radius: '1px' });
  const dots = await style('.englint-underline.suggestion', '::before');
  expect(dots.height).toBe(2);
  expect(dots.image).toMatch(/radial-gradient\(.*rgb\(37, 99, 235\)/);

  await pointAtUnderline(page);
  await expect(page.locator('.englint-underline.error.active')).toHaveCount(1);
  await expect.poll(async () => (await style('.englint-underline.error.active', '::before')).height).toBe(3);
  expect((await style('.englint-underline.error.active', '::before')).color).toBe('rgb(229, 72, 77)');
  const tint = await style('.englint-tint.error');
  expect({ ...tint, color: rgba(tint.color) }).toMatchObject({ color: [229, 72, 77, 0.14], radius: '3px', blend: 'multiply' });
});

test('a card opened without the pointer keeps its issue active (caret)', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await page.keyboard.press('ArrowLeft'); // caret inside "has"
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.englint-underline.error.active')).toHaveCount(1);
  await expect(page.locator('.englint-tint.error')).toHaveCount(1);
});

test('a new underline draws in once; re-renders with the same issues do not replay it', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await recordOverlay(page);
  await typeIn(page, '#static-ta', 'I has a cat.'); // the fixed layer: every scroll re-renders it
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect.poll(() => draws(page)).toBe(1); // it appeared with the draw-in class (recorded as it happened)

  await page.waitForTimeout(400); // the draw-in is over
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.querySelector('#static-box')!.scrollTop += 20;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await expect(errorUnderline(page)).toBeVisible();
  await expect(errorUnderline(page)).not.toHaveClass(/\bdraw\b/);
  expect(await draws(page)).toBe(1);
});

test('accepting a fix flashes its text green, and the flash is gone after 600 ms', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await recordOverlay(page);
  const u = (await errorUnderline(page).boundingBox())!;
  await pointAtUnderline(page);
  await expect(card(page)).toBeVisible();

  await page.locator('.englint-card-accept').click();
  await expect(page.locator('#ta')).toHaveValue('I have a cat.');
  await expect.poll(async () => 'englint-flash' in (await firstSeen(page))).toBe(true);
  const flashedAt = (await firstSeen(page))['englint-flash']!;
  // Over the fixed word's old rect, in the field's own layer.
  const box = (await firstBox(page, 'englint-flash'))!;
  expect(box.host).toBe('englint-field-layer');
  expect(Math.abs(box.x - u.x)).toBeLessThan(1);
  expect(Math.abs(box.width - u.width)).toBeLessThan(1);
  expect(box.height).toBeGreaterThan(12); // the word's line box, not the underline strip
  await page.waitForFunction((at) => performance.now() - at > 600, flashedAt);
  await expect(page.locator('.englint-flash')).toHaveCount(0);
  await expect(underlines(page)).toHaveCount(0);
});

test('reduced motion: no draw-in, no card slide or scale; the tint stays', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  // Control: with motion allowed, the draw-in and the card animate (styles read as each element appears).
  await page.goto(`${pagesURL}/textarea.html`);
  await recordOverlay(page);
  await typeIn(page, '#ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAtUnderline(page);
  await expect(card(page)).toBeVisible();
  expect(await appearedStyles(page)).toMatchObject({ draw: 'englint-draw', card: { name: 'englint-card-in' } });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${pagesURL}/textarea.html`);
  await recordOverlay(page);
  await typeIn(page, '#ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAtUnderline(page);
  await expect(card(page)).toBeVisible();
  expect(await appearedStyles(page)).toEqual({ draw: 'none', card: { name: 'none', transform: 'none' } });
  await expect(page.locator('.englint-tint.error')).toHaveCount(1); // the tint (opacity only) stays
});

// ---- review round 1 ----

test('content that grows above a field inside its anchor: the next scroll re-measures it (drift probe)', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expectUnderHas(page, '#pos-ta');
  // The field moves 40px down inside its box; the box (the anchor) keeps its size; nothing re-renders.
  await page.evaluate(() => ((document.querySelector('#pos-ta-box .spacer') as HTMLElement).style.height = '140px'));
  await page.locator('#pos-ta-box').evaluate((el) => (el.scrollTop += 1));
  await frames(page, 3);
  await expectUnderHas(page, '#pos-ta');
});

test('content that grows above a field on the page: its underline follows without a scroll (anchor resize)', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#doc-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expectUnderHas(page, '#doc-ta');
  // An image above it finishes loading: the document grows, the field moves down, nothing scrolls.
  await page.evaluate(() => {
    const img = document.createElement('div');
    img.style.height = '50px';
    document.querySelector('#doc-ta')!.before(img);
  });
  await frames(page, 3);
  await expectUnderHas(page, '#doc-ta');
});

test('a card opens against the visible part of an issue that straddles its box edge', async ({ page, pagesURL, mock }) => {
  const ALPHA_BETA = { ...HAS, original: 'alpha beta', replacement: 'alpha-beta', before: 'One', kind: 'compound' };
  mock.respond(async (body: any) => ({
    results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: p.text.includes('One alpha beta') ? [ALPHA_BETA] : [] })),
  }));
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#wrap-ce', 'One alpha beta two.'); // each word on its own 24px line
  await expect(errorUnderline(page)).toHaveCount(2, { timeout: 3000 }); // "alpha", "beta"
  const lines = async () =>
    (await Promise.all([0, 1].map((i) => errorUnderline(page).nth(i).boundingBox()))).sort((a, b) => a!.y - b!.y);

  // Both lines in view: a hover on the second line places the card under that line, not the first.
  const [, second] = await lines();
  await page.mouse.move(second!.x + second!.width / 2, second!.y + second!.height / 2);
  await expect(card(page)).toBeVisible();
  expect((await card(page).boundingBox())!.y).toBeGreaterThanOrEqual(second!.y + second!.height);
  await page.keyboard.press('Escape');
  await page.mouse.move(1, 1);
  await expect(card(page)).toBeHidden();

  // Scroll the box so "alpha" (line 2) is above its top and "beta" (line 3) is in view.
  await page.locator('#wrap-box').evaluate((el) => (el.scrollTop = 156));
  const boxTop = (await page.locator('#wrap-box').boundingBox())!.y + 1;
  const [alpha, beta] = await lines();
  expect(alpha!.y + alpha!.height).toBeLessThanOrEqual(boxTop); // hidden by the box
  expect(beta!.y).toBeGreaterThan(boxTop);

  // Hover on the visible line: the card sits under that line.
  await page.mouse.move(beta!.x + beta!.width / 2, beta!.y + beta!.height / 2);
  await expect(card(page)).toBeVisible();
  expect((await card(page).boundingBox())!.y).toBeGreaterThanOrEqual(beta!.y + beta!.height);

  // The caret inside the issue: the card opens against its first visible line, "beta".
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  await page.evaluate(() => {
    const ce = document.querySelector('#wrap-ce') as HTMLElement;
    ce.focus({ preventScroll: true });
    const node = ce.firstChild!.nodeType === Node.TEXT_NODE ? ce.firstChild! : ce.querySelector('*')!.firstChild!;
    const at = (node as Text).data.indexOf('beta') + 1;
    getSelection()!.collapse(node, at);
  });
  await page.keyboard.press('ArrowRight');
  await expect(card(page)).toBeVisible();
  expect((await card(page).boundingBox())!.y).toBeGreaterThanOrEqual(beta!.y + beta!.height - 1);
});

test('a layer the page removes comes back within 2 frames, with no edit or resize', async ({ page, pagesURL, mock }) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  const back = await page.evaluate(async () => {
    const host = document.querySelector('#pos-ta-box > englint-field-layer')!;
    host.remove();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return host.isConnected && host.parentElement?.id;
  });
  expect(back).toBe('pos-ta-box');
  await expectUnderHas(page, '#pos-ta');
});

test('a container that keeps removing the layer gets the fixed layer after a few tries, not a loop', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#hostile-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).hostileRemovals)).toBeLessThanOrEqual(5);
  await expect(page.locator('#hostile-box englint-field-layer')).toHaveCount(0);
  await expectUnderHas(page, '#hostile-ta'); // drawn in the fixed layer
});

test('the draw-in class goes after the draw-in, with no render, so a re-inserted layer never replays it', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await recordOverlay(page);
  await typeIn(page, '#pos-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await expect.poll(() => draws(page)).toBe(1); // it appeared with the draw-in class
  await page.waitForTimeout(400); // nothing re-renders the field meanwhile
  await expect(errorUnderline(page)).not.toHaveClass(/\bdraw\b/);
  await page.evaluate(async () => {
    const host = document.querySelector('#pos-ta-box > englint-field-layer')!;
    host.remove(); // its boxes are rebuilt when it comes back: a class still set would restart the animation
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await expect(errorUnderline(page)).not.toHaveClass(/\bdraw\b/);
  expect(await draws(page)).toBe(1);
});

test("a field in a page component's closed shadow root: the layer goes in that root, never into its slot", async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#comp-ta', 'I has a cat.');
  const underline = () =>
    page.evaluate(() => {
      const u = (window as any).compLayer()?.shadowRoot?.querySelector('.englint-underline.error');
      return u ? u.getBoundingClientRect().toJSON() : null;
    });
  await expect.poll(underline, { timeout: 3000 }).not.toBeNull();
  expect(await page.evaluate(() => (window as any).slottedLayer)).toBe(false);
  await expect(page.locator('englint-field-layer')).toHaveCount(0); // none in the light DOM
  const want = await page.evaluate(() => {
    const box = document.querySelector('#comp-ta')!.getBoundingClientRect();
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = '16px monospace';
    return { left: box.left + 9 + ctx.measureText('I ').width, width: ctx.measureText('has').width };
  });
  const u = (await underline())!;
  expect(Math.abs(u.left - want.left)).toBeLessThan(2);
  expect(Math.abs(u.width - want.width)).toBeLessThan(2);
});

// ---- review round 2: the layer's stacking level ----

test('a field with its own stacking level (z-index 5, opaque): the layer stacks above it and the underline shows', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#z-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400); // the draw-in is over
  expect(await underlinePainted(page, (await errorUnderline(page).boundingBox())!)).toBe(true);
  expect(await page.locator('#z-box > englint-field-layer').evaluate((el) => getComputedStyle(el).zIndex)).toBe('6');
});

test('a field inside a wrapper with a stacking level (the wrapper anchors it): the underline shows, no z-index needed', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#zwrap-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  expect(await underlinePainted(page, (await errorUnderline(page).boundingBox())!)).toBe(true);
  expect(await page.locator('#zwrap-box englint-field-layer').evaluate((el) => getComputedStyle(el).zIndex)).toBe('auto');
});

// ---- card placement and undo chip details ----

test('a click on the hovered line of a two-line issue keeps the card at that line', async ({ page, pagesURL, mock }) => {
  const ALPHA_BETA = { ...HAS, original: 'alpha beta', replacement: 'alpha-beta', before: 'One', kind: 'compound' };
  mock.respond(async (body: any) => ({
    results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: p.text.includes('One alpha beta') ? [ALPHA_BETA] : [] })),
  }));
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#wrap-ce', 'One alpha beta two.'); // each word on its own 24px line
  await expect(errorUnderline(page)).toHaveCount(2, { timeout: 3000 }); // "alpha", "beta"
  const [, second] = (await Promise.all([0, 1].map((i) => errorUnderline(page).nth(i).boundingBox()))).sort((a, b) => a!.y - b!.y);

  // Hover "beta" (line 2 of the issue): the card opens under it.
  await page.mouse.move(second!.x + second!.width / 2, second!.y + second!.height / 2);
  await expect(card(page)).toBeVisible();
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // at rest
  const before = (await card(page).boundingBox())!;
  expect(before.y).toBeGreaterThanOrEqual(second!.y + second!.height);

  // The click that usually follows the hover, on the same word: the card stays (not over the word, under line 1).
  await page.mouse.down();
  await page.mouse.up();
  await frames(page, 2);
  await expect(card(page)).toBeVisible();
  expect(Math.abs((await card(page).boundingBox())!.y - before.y)).toBeLessThanOrEqual(1);
});

test("a scroll inside the field (a scroller in the editor) that moves the card's text closes the card", async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await page.locator('#inner-ce').click(); // focus: its text is checked
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await pointAtUnderline(page);
  await expect(card(page)).toBeVisible();

  await page.locator('#inner-scroll').evaluate((el) => (el.scrollTop += 10)); // "I has a cat." moves up 10px
  await expect(card(page)).toBeHidden({ timeout: 500 });
});

test("the removal guard isn't for good: on its next focus, a field the page stopped removing from gets its layer back", async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#hostile-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(500);
  await expect(page.locator('#hostile-box englint-field-layer')).toHaveCount(0); // held in the fixed layer

  await page.evaluate(() => ((window as any).hostileOff = true)); // the page settled
  await page.locator('#hostile-ta').evaluate((el: HTMLElement) => el.blur());
  await page.locator('#hostile-ta').focus();
  await expect(page.locator('#hostile-box > englint-field-layer')).toHaveCount(1);
  await expectUnderHas(page, '#hostile-ta');
});

test('a page that keeps removing the layer: a retry on focus ends in the fixed layer again after a few removals, not a loop', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#hostile-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(500);
  const removals = () => page.evaluate(() => (window as any).hostileRemovals as number);
  const first = await removals();
  expect(first).toBeLessThanOrEqual(5);

  await page.locator('#hostile-ta').evaluate((el: HTMLElement) => el.blur());
  await page.locator('#hostile-ta').focus(); // the layer is tried again
  await page.waitForTimeout(500);
  const second = await removals();
  expect(second - first).toBeGreaterThanOrEqual(1); // it was tried
  expect(second - first).toBeLessThanOrEqual(5); // and given up again quickly
  await expect(page.locator('#hostile-box englint-field-layer')).toHaveCount(0);
  await expectUnderHas(page, '#hostile-ta'); // drawn in the fixed layer
  await page.waitForTimeout(500);
  expect(await removals()).toBe(second); // quiet until the next focus (or 30 s)
});

test('a field that is a flex item with z-index 5 (static, opaque): the layer stacks above it and the underline shows', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(hasCat);
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#zflex-ta', 'I has a cat.');
  await expect(errorUnderline(page)).toBeVisible({ timeout: 3000 });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400); // the draw-in is over
  await expectUnderHas(page, '#zflex-ta');
  expect(await underlinePainted(page, (await errorUnderline(page).boundingBox())!)).toBe(true);
  expect(await page.locator('#zflex-box > englint-field-layer').evaluate((el) => getComputedStyle(el).zIndex)).toBe('6');
});
