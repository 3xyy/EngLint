import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';
import { clarityOn, expect, test } from './fixtures';
import { fittedVersion, HAIKU, isCritique, isFollowUp, isSynonyms, isVoice, isWordLimit, SONNET, toolsResponder, userText } from './mock-anthropic';

// Evaluated inside the extension's service worker, where `chrome` exists.
declare const chrome: any;

const bar = (page: Page) => page.locator('.englint-bar');
/** A button on the selection bar, by its words. */
const barButton = (page: Page, name: string) => bar(page).getByRole('button', { name, exact: true });
/** The bar's buttons, left to right. */
const barLabels = (page: Page) => bar(page).locator('[data-bar-item]').allTextContents();
/** Opens `menu` (Shorten, Tone or More) on the bar and picks `item` from it. */
async function pickFromBar(page: Page, menu: string, item: string) {
  await barButton(page, menu).click();
  await bar(page).getByRole('menuitem', { name: item, exact: true }).click();
}

/** Types into the textarea (focusing it), then selects [start, end) the way a drag would leave it. */
async function textareaWith(page: Page, pagesURL: string, text: string): Promise<void> {
  await page.goto(`${pagesURL}/textarea.html`);
  await page.locator('#ta').click();
  await page.keyboard.type(text);
}

const selectInTextarea = (page: Page, start: number, end: number) =>
  page.locator('#ta').evaluate((el: HTMLTextAreaElement, [s, e]) => el.setSelectionRange(s!, e!), [start, end]);

/** Where [from, to) of the textarea's first line is drawn, from the page's own metrics. */
async function firstLineSpan(page: Page, text: string, from: number, to: number): Promise<{ left: number; right: number; top: number; bottom: number }> {
  return page.locator('#ta').evaluate(
    (el, [text, from, to]) => {
      const cs = getComputedStyle(el);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = cs.font;
      const box = el.getBoundingClientRect();
      const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const top = box.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      return { left: left + ctx.measureText(text.slice(0, from)).width, right: left + ctx.measureText(text.slice(0, to)).width, top, bottom: top + parseFloat(cs.lineHeight) };
    },
    [text, from, to] as const,
  );
}
/** Room above the fields, so the bar has space above a selection on their first line. */
const roomAbove = (page: Page) => page.evaluate(() => (document.body.style.paddingTop = '120px'));
const BAR_GAP = 6;
/** The bar's box once its enter animation (a scale) has finished. */
async function barBox(page: Page) {
  await bar(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return (await bar(page).boundingBox())!;
}

test('selecting text in a textarea shows the bar just above the selection: Improve, Shorten ▾, Tone ▾, My voice, More ▾', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await roomAbove(page);
  await expect(bar(page)).toHaveCount(0);
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible({ timeout: 300 });
  await expect(bar(page)).toHaveAttribute('role', 'toolbar');
  await expect(bar(page)).toHaveAttribute('aria-label', 'EngLint');
  expect(await barLabels(page)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'More']);

  const want = await firstLineSpan(page, 'I has a cat', 2, 11);
  const box = await barBox(page);
  expect(box.height).toBe(36);
  expect(Math.abs(box.x - want.left)).toBeLessThanOrEqual(12);
  expect(Math.abs(box.y + box.height + BAR_GAP - want.top)).toBeLessThanOrEqual(8);
  // One row: every button on the same line, left to right.
  const tops = await bar(page).locator('[data-bar-item]').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});

test('a single word gets Synonyms on the bar itself; a field on the page\'s first line gets the bar below the selection', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I have a big cat');
  await page.evaluate(() => (document.documentElement.style.marginTop = '-30px')); // the field's first line near the top
  await selectInTextarea(page, 9, 12); // "big"
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  expect(await barLabels(page)).toEqual(['Improve', 'Shorten', 'Tone', 'My voice', 'Synonyms', 'More']);
  const want = await firstLineSpan(page, 'I have a big cat', 9, 12);
  const box = await barBox(page);
  expect(want.top - BAR_GAP - box.height).toBeLessThan(8); // no room above
  expect(Math.abs(box.y - (want.bottom + BAR_GAP))).toBeLessThanOrEqual(8);
});

test('Tone ▾ opens Formal, Confident, Friendly and Casual; Shorten ▾ has Shorter and "Fit a word limit…"; More ▾ has Expand, Synonyms and "Ask anything…"', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  await barButton(page, 'Tone').click();
  await expect(bar(page).getByRole('menuitem')).toHaveText(['Formal', 'Confident', 'Friendly', 'Casual']);
  await expect(barButton(page, 'Tone')).toHaveAttribute('aria-expanded', 'true');
  await barButton(page, 'Shorten').click();
  await expect(bar(page).getByRole('menuitem')).toHaveText(['Shorter', 'Fit a word limit…']);
  await expect(bar(page).getByRole('menuitem', { name: 'Fit a word limit…' })).toBeEnabled();
  await barButton(page, 'More').click();
  await expect(bar(page).getByRole('menuitem')).toHaveText(['Expand', 'Synonyms', 'Ask anything…']);
  // The field kept its focus and selection all along.
  expect(await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => [document.activeElement === el, el.selectionStart, el.selectionEnd])).toEqual([true, 2, 11]);
});

test('collapsing the selection hides the bar', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible();
  await selectInTextarea(page, 4, 4);
  await expect(bar(page)).toHaveCount(0, { timeout: 1000 });
});

test('typing over the selection hides the bar', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible();
  await page.keyboard.type('x');
  await expect(bar(page)).toHaveCount(0, { timeout: 1000 });
});

test('Esc hides the bar and it stays hidden until the selection changes', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await page.waitForTimeout(400); // the Esc keyup must not bring it back
  await expect(bar(page)).toHaveCount(0);
  await selectInTextarea(page, 2, 5);
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
});

test('selecting page text that is not editable shows no bar, and leaves the field bar behind', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible();
  await page.locator('#far').click({ clickCount: 3 }); // a real selection: focus leaves the textarea
  expect(await page.evaluate(() => document.getSelection()!.toString())).toContain('Nothing to see here');
  await page.waitForTimeout(500);
  await expect(bar(page)).toHaveCount(0);
});

test('scrolling the page hides the bar', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await page.evaluate(() => (document.body.style.minHeight = '3000px'));
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible();
  await page.mouse.wheel(0, 200);
  await expect(bar(page)).toHaveCount(0, { timeout: 1000 });
});

test('pressing Improve keeps the field selection; the popover it opens takes focus', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ variants: ['have a cat', 'own a cat', 'have one cat'] }));
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  await barButton(page, 'Improve').click();
  await expect(page.locator('.englint-tools')).toBeVisible();
  await expect(bar(page)).toHaveCount(0); // the popover takes the bar's place
  const kept = await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => ({
    start: el.selectionStart,
    end: el.selectionEnd,
    focused: document.activeElement === el,
  }));
  expect(kept).toEqual({ start: 2, end: 11, focused: false });
  await expect(page.locator('.englint-tools').getByRole('button', { name: 'Use version 1' })).toBeFocused();
});

test('a selection inside a word ("roble" in "problems") is the whole word: the request and the apply both use "problems"', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ variants: ['issues', 'troubles', 'worries'] }));
  await textareaWith(page, pagesURL, 'Our problems are big.');
  await selectInTextarea(page, 5, 10); // "roble"
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  expect(await barLabels(page)).toContain('Synonyms'); // one word
  await barButton(page, 'Improve').click();
  await expect(page.locator('.englint-tools').getByRole('button', { name: /^Use version \d$/ })).toHaveCount(3);
  const user = userText(mock.requests.filter((r) => r.model === SONNET).at(-1));
  expect(user).toContain('<selection>\n"problems"\n</selection>');
  expect(user).toContain('<before>\n"Our "\n</before>');
  await page.locator('.englint-tools').getByRole('button', { name: 'Use version 1' }).click();
  await expect.poll(() => page.locator('#ta').inputValue()).toBe('Our issues are big.');
  expect(await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([4, 10]);
});

test('a contenteditable selection across a <b> shows the bar above it', async ({ page, pagesURL }) => {
  await page.goto(`${pagesURL}/contenteditable.html`);
  await roomAbove(page);
  const editor = page.locator('#ce');
  await editor.click();
  await editor.evaluate((el) => {
    el.innerHTML = '<p>I has <b>a big</b> cat</p>';
    const p = el.firstChild!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 2);
    range.setEnd(p.childNodes[1]!.firstChild!, 5);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  const want = await page.evaluate(() => {
    const p = document.querySelector('#ce p')!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 2);
    range.setEnd(document.querySelector('#ce b')!.firstChild!, 5);
    const r = range.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  const box = await barBox(page);
  expect(Math.abs(box.x - want.left)).toBeLessThanOrEqual(12);
  expect(Math.abs(box.y + box.height + BAR_GAP - want.top)).toBeLessThanOrEqual(8);
});

test('fake Docs: a bridge selection shows the bar above the selection', async ({ page, pagesURL }) => {
  await page.goto(`${pagesURL}/document/d/fake/edit.html`);
  await expect(page.locator('.kix-appview-editor')).toBeVisible();
  // A click on the page focuses the text-event iframe, as in Docs.
  const line = await page.locator('.text-layer div').nth(1).boundingBox();
  await page.mouse.click(line!.x + 20, line!.y + line!.height / 2);
  await page.evaluate(() => {
    const fake = (window as any).fakeDocs;
    const start = fake.text().indexOf('has a cat');
    fake.selection = { start, end: start + 'has a cat'.length };
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(bar(page)).toBeVisible({ timeout: 3000 });

  const want = await page.evaluate(() => {
    for (const div of Array.from(document.querySelectorAll('.text-layer div'))) {
      const node = div.firstChild as Text | null;
      const at = node ? node.data.indexOf('has a cat') : -1;
      if (!node || at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 'has a cat'.length);
      const r = range.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom };
    }
    return null;
  });
  const box = await barBox(page);
  expect(Math.abs(box.x - want!.left)).toBeLessThanOrEqual(12);
  const above = Math.abs(box.y + box.height + BAR_GAP - want!.top) <= 8;
  const below = Math.abs(box.y - (want!.bottom + BAR_GAP)) <= 8; // a first line too near the top
  expect(above || below).toBe(true);
});

// ---- the tools popover ----

const popover = (page: Page) => page.locator('.englint-tools');
const versionRows = (page: Page) => popover(page).getByRole('button', { name: /^Use version \d$/ });
const options = (page: Page) => popover(page).locator('.englint-tools-option');

const VARIANTS = ['have a cat', 'own a cat', 'have one cat'];
const SYNONYMS = [
  { text: 'large', nuance: 'neutral, everyday' },
  { text: 'huge', nuance: 'much bigger than usual' },
  { text: 'hefty', nuance: 'heavy and solid' },
  { text: 'sizable', nuance: 'fairly large' },
  { text: 'giant', nuance: 'informal, strong' },
  { text: 'bulky', nuance: 'takes up space' },
];

/** A field type the popover runs on: how to fill it, select in it, and read it back. */
interface FieldKit {
  name: string;
  fill(page: Page, pagesURL: string, text: string): Promise<void>;
  select(page: Page, start: number, end: number): Promise<void>;
  text(page: Page): Promise<string>;
  /** The field's selection as text offsets, and whether focus is in the field. */
  state(page: Page): Promise<{ start: number; end: number; focused: boolean }>;
}

const TEXTAREA: FieldKit = {
  name: 'textarea',
  fill: textareaWith,
  select: selectInTextarea,
  text: (page) => page.locator('#ta').inputValue(),
  state: (page) =>
    page.locator('#ta').evaluate((el: HTMLTextAreaElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      focused: document.activeElement === el,
    })),
};

const CONTENTEDITABLE: FieldKit = {
  name: 'contenteditable',
  async fill(page, pagesURL, text) {
    await page.goto(`${pagesURL}/contenteditable.html`);
    await page.locator('#ce').click();
    await page.keyboard.type(text);
  },
  select: (page, start, end) =>
    page.locator('#ce').evaluate(
      (el, [s, e]) => {
        // Offsets over the editor's text nodes, in order.
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const at = (offset: number): [Node, number] => {
          let left = offset;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const len = (n as Text).data.length;
            if (left <= len) return [n, left];
            left -= len;
          }
          return [el, el.childNodes.length];
        };
        const range = document.createRange();
        walker.currentNode = el;
        range.setStart(...at(s!));
        walker.currentNode = el;
        range.setEnd(...at(e!));
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
      },
      [start, end],
    ),
  text: (page) => page.locator('#ce').evaluate((el) => el.textContent ?? ''),
  state: (page) =>
    page.locator('#ce').evaluate((el) => {
      const sel = document.getSelection()!;
      const offset = (node: Node, at: number) => {
        const r = document.createRange();
        r.setStart(el, 0);
        r.setEnd(node, at);
        return r.toString().length;
      };
      const a = offset(sel.anchorNode!, sel.anchorOffset);
      const b = offset(sel.focusNode!, sel.focusOffset);
      return { start: Math.min(a, b), end: Math.max(a, b), focused: document.activeElement === el };
    }),
};

/** Fills the field, selects [start, end), and waits for the selection bar. */
async function openBar(page: Page, pagesURL: string, kit: FieldKit, text: string, start: number, end: number) {
  await kit.fill(page, pagesURL, text);
  await kit.select(page, start, end);
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
}

const sonnetRequests = (mock: { requests: any[] }) => mock.requests.filter((r) => r.model === SONNET);

/** In a diff row: the space drawn between a removed part and the added part right after it. */
const diffJoint = (row: Locator) =>
  row.locator('del + ins').evaluate((ins) => ({
    gap: ins.getBoundingClientRect().left - ins.previousElementSibling!.getBoundingClientRect().right,
    margin: parseFloat(getComputedStyle(ins).marginInlineStart),
  }));

/**
 * In the page: records the box of the first accept flash in any of our shadow roots (the overlay's and the
 * field layers', open in the e2e build). It lasts 450 ms, too short to poll for.
 */
const recordFlash = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    w.__flash = null;
    const watched = new WeakSet<Node>();
    const roots = () => Array.from(document.querySelectorAll('*')).flatMap((el) => (el.shadowRoot ? [el.shadowRoot] : []));
    const note = () => {
      for (const r of roots()) w.__flash ??= r.querySelector('.englint-flash')?.getBoundingClientRect().toJSON() ?? null;
    };
    const watch = () => {
      for (const r of roots()) {
        if (watched.has(r)) continue;
        watched.add(r);
        new MutationObserver(note).observe(r, { childList: true, subtree: true });
      }
    };
    watch();
    new MutationObserver(watch).observe(document.documentElement, { childList: true, subtree: true });
  });
const flashBox = (page: Page) => page.evaluate(() => (window as any).__flash as DOMRect | null);

for (const kit of [TEXTAREA, CONTENTEDITABLE]) {
  test(`${kit.name}: a pick on the bar opens the results, 380 px wide, in place of the bar, with a header naming the action`, async ({ page, pagesURL, mock }) => {
    mock.respond(toolsResponder({ variants: VARIANTS }));
    await openBar(page, pagesURL, kit, 'I has a cat', 2, 11);
    await pickFromBar(page, 'Tone', 'Formal');
    await expect(popover(page)).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await expect(popover(page).locator('.englint-tools-title')).toHaveText('Tone · Formal');
    await expect(versionRows(page)).toHaveCount(3);
    expect(await popover(page).evaluate((el: HTMLElement) => el.offsetWidth)).toBe(380); // layout width: the enter animation scales
    await expect(versionRows(page).first()).toBeFocused(); // the popover takes focus
    await popover(page).getByRole('button', { name: 'Close' }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect.poll(() => kit.state(page)).toEqual({ start: 2, end: 11, focused: true }); // back in the field
  });

  test(`${kit.name}: Improve shows 3 versions as word diffs, each with Copy; one applies, and undo restores the original`, async ({
    page,
    pagesURL,
    mock,
  }) => {
    mock.respond(toolsResponder({ variants: VARIANTS }));
    await openBar(page, pagesURL, kit, 'I has a cat', 2, 11);
    await barButton(page, 'Improve').click();
    await expect(versionRows(page)).toHaveCount(3);
    await expect(popover(page).locator('.englint-tools-title')).toHaveText('Improve');
    await expect(popover(page).getByRole('button', { name: /^Copy version \d$/ })).toHaveCount(3);
    const second = versionRows(page).nth(1);
    await expect(second).toHaveAttribute('aria-label', 'Use version 2');
    await expect(second.locator('del')).toHaveText('has');
    await expect(second.locator('ins')).toHaveText('own');
    // The suggestion card's diff colours (tokens --el-del, --el-ins, --el-ins-bg).
    expect(await second.locator('del').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(194, 65, 75)');
    expect(await second.locator('ins').evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor])).toEqual([
      'rgb(21, 128, 61)',
      'rgb(233, 248, 238)',
    ]);
    // "has" then "own" with no space at the joint: a visible gap keeps them apart (I1, live finding L-diff).
    const joint = await diffJoint(second);
    expect(joint.margin).toBeGreaterThan(0);
    expect(joint.gap).toBeGreaterThanOrEqual(2);
    await expect(second).toHaveText('hasown a cat'); // the gap is drawn, not typed: no space in the text

    await recordFlash(page);
    await second.click();
    await expect(popover(page)).toHaveCount(0);
    await expect.poll(() => kit.text(page)).toBe('I own a cat');
    // The new text is selected, and flashes like an accepted fix.
    await expect.poll(() => kit.state(page)).toEqual({ start: 2, end: 11, focused: true });
    await expect.poll(() => flashBox(page)).not.toBeNull();
    expect((await flashBox(page))!.width).toBeGreaterThan(40); // "own a cat", not one character
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => kit.text(page)).toBe('I has a cat');
  });
}

// Fit a word limit: 14 words, cut to a target. The model's cuts are located and counted on the client.
const LIMIT_TEXT = 'In order to win the final, we really practiced every single day after school.';
const LIMIT_REPLY = {
  cuts: [
    { original: 'In order to', replacement: 'To', why: 'a wordy opening' },
    { original: 'really', replacement: '', why: 'a filler word' },
    { original: 'every single day', replacement: 'daily', why: 'says it in one word' },
    { original: 'not in the text', replacement: '', why: 'dropped: nowhere in the selection' },
  ],
  version: 'To win the final, we practiced daily after school.',
};

for (const kit of [TEXTAREA, CONTENTEDITABLE]) {
  test(`${kit.name}: Fit a word limit… shows the target picker, finds cuts, and Apply selected replaces the selection once; undo restores it`, async ({
    page,
    pagesURL,
    mock,
  }) => {
    mock.respond(toolsResponder({ wordLimit: LIMIT_REPLY }));
    await openBar(page, pagesURL, kit, LIMIT_TEXT, 0, LIMIT_TEXT.length);
    await pickFromBar(page, 'Shorten', 'Fit a word limit…');
    await expect(popover(page).locator('.englint-tools-title')).toHaveText('Fit a word limit');
    await expect(popover(page).locator('.el-wl-count')).toHaveText('14 words selected');
    const target = popover(page).getByLabel('Target');
    await expect(target).toHaveValue('10');
    await expect(target).toBeFocused();
    expect(sonnetRequests(mock)).toHaveLength(0); // nothing before Find cuts
    await target.fill('11');
    await popover(page).getByRole('button', { name: 'Find cuts' }).click();

    const boxes = popover(page).getByRole('checkbox');
    await expect(boxes).toHaveCount(3); // the cut found nowhere is dropped
    expect(sonnetRequests(mock).filter(isWordLimit)).toHaveLength(1);
    expect(sonnetRequests(mock)[0].stream).toBe(true); // the answer starts at once (a worker's fetch must not wait 30 s)
    expect(userText(sonnetRequests(mock)[0])).toContain('The selection has 14 words. Bring it to at most 11 words');
    await expect(popover(page).locator('.el-wl-head')).toHaveText('14 → 11 words');
    // Picked in order until 11: "In order to" (12), then "really" (11).
    expect(await boxes.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).checked))).toEqual([true, true, false]);
    const counter = popover(page).locator('.el-wl-counter');
    await expect(counter).toHaveText('Selected cuts: 11 words (at the limit)');
    expect(await counter.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(21, 128, 61)'); // green: --el-ins
    await expect(popover(page).locator('.el-wl-saves')).toHaveText(['−2 words', '−1 word', '−2 words']);
    await boxes.nth(1).click(); // unpick "really"
    await expect(counter).toHaveText('Selected cuts: 12 words (1 to go)');
    await boxes.nth(2).click();
    await expect(counter).toHaveText('Selected cuts: 10 words (1 under)');
    await expect(popover(page).getByRole('button', { name: 'Use full version (9 words)' })).toBeVisible();

    await popover(page).getByRole('button', { name: 'Apply selected' }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect.poll(() => kit.text(page)).toBe('To win the final, we really practiced daily after school.');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => kit.text(page)).toBe(LIMIT_TEXT);
  });
}

test('Fit a word limit: Use full version applies the version; Find more cuts sends the cuts shown and adds new ones', async ({ page, pagesURL, mock }) => {
  let round = 0;
  mock.respond(
    toolsResponder({
      wordLimit: () =>
        ++round === 1
          ? { cuts: LIMIT_REPLY.cuts.slice(0, 2), version: LIMIT_REPLY.version }
          : { cuts: [{ original: 'every single day', replacement: 'daily', why: 'says it in one word' }], version: 'unused' },
    }),
  );
  await openBar(page, pagesURL, TEXTAREA, LIMIT_TEXT, 0, LIMIT_TEXT.length);
  await pickFromBar(page, 'Shorten', 'Fit a word limit…');
  await expect(popover(page).locator('.el-wl-chip')).toHaveCount(0); // 14 words: no common limit below it
  await popover(page).getByRole('button', { name: 'Find cuts' }).click();
  await expect(popover(page).getByRole('checkbox')).toHaveCount(2);
  await popover(page).getByRole('button', { name: 'Find more cuts' }).click();
  await expect(popover(page).getByRole('checkbox')).toHaveCount(3);
  const second = userText(sonnetRequests(mock).filter(isWordLimit)[1]);
  expect(second).toContain('<shown_cuts>');
  expect(second).toContain('In order to');
  await popover(page).getByRole('button', { name: 'Use full version (9 words)' }).click();
  await expect.poll(() => TEXTAREA.text(page)).toBe(LIMIT_REPLY.version);
});

test('Fit a word limit takes a selection over 2,000 characters (up to 5,000), with the common limits below it as chips', async ({ page, pagesURL, mock }) => {
  const long = Array.from({ length: 450 }, (_, i) => `word${i}`).join(' '); // 3,489 characters
  mock.respond(toolsResponder({ wordLimit: (body) => ({ cuts: [{ original: 'word1', replacement: '', why: 'one word' }], version: fittedVersion(body) }) }));
  await textareaWith(page, pagesURL, 'x');
  await page.locator('#ta').fill(long);
  await selectInTextarea(page, 0, long.length);
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  await pickFromBar(page, 'Shorten', 'Fit a word limit…');
  await expect(popover(page).locator('.el-wl-count')).toHaveText('450 words selected');
  await popover(page).locator('.el-wl-chips').getByRole('button', { name: '250' }).click();
  await popover(page).getByRole('button', { name: 'Find cuts' }).click();
  await expect(popover(page).getByRole('checkbox')).toHaveCount(1);
  expect(userText(sonnetRequests(mock)[0])).toContain('Bring it to at most 250 words');
  await expect(popover(page).getByRole('button', { name: 'Use full version (238 words)' })).toBeVisible(); // counted here
});

test('"Ask anything…" opens a box in the bar; its instruction is sent outside the <selection> data', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await pickFromBar(page, 'More', 'Ask anything…');
  const box = bar(page).getByPlaceholder('Tell EngLint what to do…');
  await expect(box).toBeFocused();
  expect(sonnetRequests(mock)).toHaveLength(0);
  await box.fill('make it vivid');
  await box.press('Enter');
  await expect(versionRows(page)).toHaveCount(3);
  await expect(popover(page).locator('.englint-tools-title')).toHaveText('“make it vivid”');
  const user = userText(sonnetRequests(mock).at(-1));
  expect(user).toContain('<selection>\n"has a cat"\n</selection>');
  expect(user).toContain('<instruction>\nmake it vivid\n</instruction>');
  expect(user.indexOf('<instruction>')).toBeGreaterThan(user.indexOf('</selection>'));
  expect(user.slice(0, user.indexOf('</selection>'))).not.toContain('vivid');
});

/** Makes 127.0.0.1 an Essay site (the siteModes setting), before the page loads. */
const essaySite = (sw: Worker) => sw.evaluate(() => chrome.storage.local.set({ siteModes: { '127.0.0.1': 'essay' } }));

test('Standard page: Tone ▾ Confident sends a rewrite with that preset\'s instruction', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await pickFromBar(page, 'Tone', 'Confident');
  await expect(versionRows(page)).toHaveCount(3);
  const user = userText(sonnetRequests(mock).at(-1));
  expect(user).toContain(
    "<instruction>\nMake this sound more confident and direct: cut hedges and apologies, keep every idea and the writer's voice.\n</instruction>",
  );
});

test('Essay page: the bar\'s More ▾ has no Expand', async ({ page, pagesURL, mock, serviceWorker }) => {
  await essaySite(serviceWorker);
  mock.respond(toolsResponder());
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'More').click();
  await expect(bar(page).getByRole('menuitem')).toHaveText(['Synonyms', 'Ask anything…']);
  await expect(barButton(page, 'Improve')).toBeVisible();
});

test('Essay site: the critique comes first, then "Show 3 rewrites" shows the versions', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await essaySite(serviceWorker);
  mock.respond(
    toolsResponder({ variants: VARIANTS, critique: { weakness: 'The verb does not agree with "I".', light_fix: 'have a cat' } }),
  );
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  await expect(popover(page).locator('.englint-tools-weakness')).toHaveText('The verb does not agree with "I".');
  const fix = popover(page).getByRole('button', { name: 'Use this version' });
  await expect(fix.locator('del')).toHaveText('has');
  await expect(fix.locator('ins')).toHaveText('have');
  await expect(versionRows(page)).toHaveCount(0);
  expect(sonnetRequests(mock).map(isCritique)).toEqual([true]);

  await popover(page).getByRole('button', { name: 'Show 3 rewrites' }).click();
  await expect(versionRows(page)).toHaveCount(3);
  expect(sonnetRequests(mock).map(isCritique)).toEqual([true, false]);
});

const followUpBox = (page: Page) => popover(page).getByPlaceholder('Ask a follow-up…');
const answerMessage = (page: Page) => popover(page).locator('.englint-tools-message');

test('a follow-up after the versions answers with a message and diffs; one applies, and undo restores the original', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(
    toolsResponder({ variants: VARIANTS, followUp: { message: 'These sound more relaxed.', variants: ['got a cat', 'have got a cat'] } }),
  );
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  await expect(versionRows(page)).toHaveCount(3);
  await followUpBox(page).click();
  await page.keyboard.type('less formal');
  await page.keyboard.press('Enter');
  await expect(answerMessage(page)).toHaveText('These sound more relaxed.');
  await expect(versionRows(page)).toHaveCount(2);
  const first = versionRows(page).first();
  await expect(first.locator('del')).toHaveText('has');
  await expect(first.locator('ins')).toHaveText('got');

  const asked = sonnetRequests(mock);
  expect(asked.map(isFollowUp)).toEqual([false, true]);
  const user = userText(asked[1]);
  expect(user).toContain('<selection>\n"has a cat"\n</selection>');
  expect(user).toContain('<shown>\n"Versions:\\n1. have a cat\\n2. own a cat\\n3. have one cat"\n</shown>');
  expect(user.trimEnd().endsWith('<question>\nless formal\n</question>')).toBe(true);
  expect(asked[1].max_tokens).toBe(4096);

  await recordFlash(page);
  await first.click();
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => TEXTAREA.text(page)).toBe('I got a cat');
  await expect.poll(() => TEXTAREA.state(page)).toEqual({ start: 2, end: 11, focused: true });
  await expect.poll(() => flashBox(page)).not.toBeNull();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => TEXTAREA.text(page)).toBe('I has a cat');
});

test('Essay site: a follow-up after the critique shows its message and at most one version', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await essaySite(serviceWorker);
  mock.respond(
    toolsResponder({
      critique: { weakness: 'The verb does not agree with "I".', light_fix: 'have a cat' },
      followUp: { message: 'The verb is the main problem. One light fix:', variants: ['have a cat', 'own a cat', 'keep a cat'] },
    }),
  );
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  await expect(popover(page).locator('.englint-tools-weakness')).toBeVisible();
  await followUpBox(page).click();
  await page.keyboard.type('rewrite it');
  await page.keyboard.press('Enter');
  await expect(answerMessage(page)).toHaveText('The verb is the main problem. One light fix:');
  await expect(versionRows(page)).toHaveCount(1);
  await expect(versionRows(page).first().locator('ins')).toHaveText('have');
  expect(sonnetRequests(mock).map(isFollowUp)).toEqual([false, true]);
  expect(userText(sonnetRequests(mock)[1])).toContain('<shown>\n"Weakness: The verb does not agree with \\"I\\".\\nLight-touch version: have a cat"\n</shown>');
});

const VOICE_OTHER = 'We left at dawn and nobody talked.';
const VOICE_PARA = 'It was not just a trip, it was a journey.';
const VOICE_TEXT = `${VOICE_OTHER}\n${VOICE_PARA}`;

test('Sound like me sends the other paragraph as the voice sample, shows the patterns found and one diff, and applies it', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(toolsResponder({ voice: { tells: ['a staged contrast', 'an inflated claim'], final: 'It was a long trip, and it mattered.' } }));
  await openBar(page, pagesURL, TEXTAREA, VOICE_TEXT, VOICE_OTHER.length + 1, VOICE_TEXT.length);
  await barButton(page, 'My voice').click();
  await expect(popover(page).locator('.englint-tools-tells')).toHaveText('Generic patterns found: a staged contrast, an inflated claim');
  const row = popover(page).getByRole('button', { name: 'Use this version' });
  await expect(row).toHaveCount(1);
  await expect(versionRows(page)).toHaveCount(0);
  await expect(row.locator('del').first()).toBeVisible();
  await expect(row.locator('ins').first()).toBeVisible();
  await expect(popover(page).locator('.englint-tools-note')).toHaveCount(0);

  const asked = sonnetRequests(mock);
  expect(asked.map(isVoice)).toEqual([true]);
  const user = userText(asked[0]);
  expect(user).toContain('<selection>\n"It was not just a trip, it was a journey."\n</selection>');
  expect(user).toContain(`<voice_sample>\n"${VOICE_OTHER}"\n</voice_sample>`);
  expect(user.slice(user.indexOf('<voice_sample>'), user.indexOf('</voice_sample>'))).not.toContain('journey');

  await row.click();
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => TEXTAREA.text(page)).toBe(`${VOICE_OTHER}\nIt was a long trip, and it mattered.`);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => TEXTAREA.text(page)).toBe(VOICE_TEXT);
});

test('Sound like me: a version that changes a number is never applied; it offers Copy with the fact note', async ({
  page,
  pagesURL,
  mock,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: pagesURL });
  mock.respond(
    toolsResponder({
      voice: { tells: [], final: 'The trip took 3 days.' },
      followUp: { message: 'Two shorter ones.', variants: ['It took 3 days.', 'It was a long trip.'] },
    }),
  );
  await openBar(page, pagesURL, TEXTAREA, VOICE_TEXT, VOICE_OTHER.length + 1, VOICE_TEXT.length);
  await barButton(page, 'My voice').click();
  await expect(popover(page).locator('.englint-tools-tells')).toHaveText('No generic patterns found.');
  await expect(popover(page).locator('.englint-tools-note')).toHaveText('Check the facts: this version changes a number, name or quote.');
  await expect(popover(page).getByRole('button', { name: 'Use this version' })).toHaveCount(0);
  await expect(popover(page).locator('.englint-tools-version ins').first()).toBeVisible();
  const copy = popover(page).getByRole('button', { name: 'Copy this version' });
  await expect(copy).toBeFocused();
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('The trip took 3 days.');
  expect(await TEXTAREA.text(page)).toBe(VOICE_TEXT);

  // A follow-up keeps the gate: its version with the number is copy only, the other applies.
  await followUpBox(page).click();
  await page.keyboard.type('shorter');
  await page.keyboard.press('Enter');
  await expect(answerMessage(page)).toHaveText('Two shorter ones.');
  await expect(popover(page).getByRole('button', { name: 'Use version 1' })).toHaveCount(0);
  await expect(popover(page).getByRole('button', { name: 'Copy version 1' })).toBeVisible();
  await expect(popover(page).locator('.englint-tools-note')).toHaveText('Check the facts: this version changes a number, name or quote.');
  await popover(page).getByRole('button', { name: 'Use version 2' }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => TEXTAREA.text(page)).toBe(`${VOICE_OTHER}\nIt was a long trip.`);
});

test('Essay site: Sound like me critiques first without the voice sample, its light fix with a number is copy only, and "Show the version" brings the version', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await essaySite(serviceWorker);
  mock.respond(
    toolsResponder({
      critique: { weakness: 'The contrast sounds staged.', light_fix: 'The trip took 3 days.' },
      voice: { tells: ['a staged contrast'], final: 'It was a long trip, and it mattered.' },
    }),
  );
  await openBar(page, pagesURL, TEXTAREA, VOICE_TEXT, VOICE_OTHER.length + 1, VOICE_TEXT.length);
  await barButton(page, 'My voice').click();
  await expect(popover(page).locator('.englint-tools-weakness')).toHaveText('The contrast sounds staged.');
  await expect(popover(page).getByRole('button', { name: 'Use this version' })).toHaveCount(0);
  await expect(popover(page).getByRole('button', { name: 'Copy this version' })).toBeVisible();
  await expect(popover(page).locator('.englint-tools-note')).toHaveText('Check the facts: this version changes a number, name or quote.');
  await expect(popover(page).getByRole('button', { name: 'Show 3 rewrites' })).toHaveCount(0);
  expect(sonnetRequests(mock).map(isCritique)).toEqual([true]);
  expect(userText(sonnetRequests(mock)[0])).not.toContain('<voice_sample>');

  await popover(page).getByRole('button', { name: 'Show the version' }).click();
  await expect(popover(page).locator('.englint-tools-tells')).toHaveText('Generic patterns found: a staged contrast');
  expect(sonnetRequests(mock).map(isVoice)).toEqual([false, true]);
  expect(userText(sonnetRequests(mock)[1])).toContain(`<voice_sample>\n"${VOICE_OTHER}"\n</voice_sample>`);
  await popover(page).getByRole('button', { name: 'Use this version' }).click();
  await expect.poll(() => TEXTAREA.text(page)).toBe(`${VOICE_OTHER}\nIt was a long trip, and it mattered.`);
});

test('Synonyms: 6 options with nuance notes; one replaces only the word', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ options: SYNONYMS }));
  await openBar(page, pagesURL, TEXTAREA, 'I have a big cat', 9, 12);
  await barButton(page, 'Synonyms').click();
  await expect(options(page)).toHaveCount(6);
  await expect(options(page).nth(1).locator('.englint-tools-nuance')).toHaveText('much bigger than usual');
  const asked = mock.requests.filter((r) => r.model === HAIKU && isSynonyms(r));
  expect(asked).toHaveLength(1);
  expect(userText(asked[0])).toContain('"target":"big"');

  await options(page).nth(1).click();
  await expect.poll(() => TEXTAREA.text(page)).toBe('I have a huge cat');
  await expect(popover(page)).toHaveCount(0);
});

test('keyboard: the focused bar (the shortcut) moves with the arrows and opens its menus; the results move up and down; Enter applies; Esc closes, focus returns to the field and the bar comes back', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  expect(await toFrame(serviceWorker, 'openTools', {})).toEqual({ opened: true }); // the shortcut's request
  await expect(barButton(page, 'Improve')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(barButton(page, 'Shorten')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown'); // opens Tone on its first item
  await expect(bar(page).getByRole('menuitem', { name: 'Formal' })).toBeFocused();
  await page.keyboard.press('ArrowUp'); // wraps to the last
  await expect(bar(page).getByRole('menuitem', { name: 'Casual' })).toBeFocused();
  await page.keyboard.press('Escape'); // the menu closes; the bar stays
  await expect(bar(page).getByRole('menuitem')).toHaveCount(0);
  await expect(barButton(page, 'Tone')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(barButton(page, 'Improve')).toBeFocused();
  await page.keyboard.press('ArrowLeft'); // wraps to the end
  await expect(barButton(page, 'More')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter'); // Improve
  await expect(versionRows(page)).toHaveCount(3);
  await expect(versionRows(page).first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(versionRows(page).nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => TEXTAREA.text(page)).toBe('I own a cat');
  await page.waitForTimeout(400);
  await expect(bar(page)).toHaveCount(0); // not again for the text just applied

  await TEXTAREA.select(page, 2, 5);
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  expect(await toFrame(serviceWorker, 'openTools', {})).toEqual({ opened: true });
  await expect(barButton(page, 'Improve')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => TEXTAREA.state(page)).toEqual({ start: 2, end: 5, focused: true });
  // Closed with nothing applied: the bar is back beside the same selection (taking no focus), to try another action.
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  await expect(barButton(page, 'Improve')).not.toBeFocused();
  await page.keyboard.press('Escape'); // Esc on that bar hides it, and its keyup doesn't bring it back
  await expect(bar(page)).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(bar(page)).toHaveCount(0);
});

test('a click outside closes the popover and leaves focus where the click put it', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  await expect(versionRows(page)).toHaveCount(3);
  // Another input, clear of the popover.
  await page.evaluate(() => {
    const other = document.createElement('input');
    other.id = 'other';
    other.style.cssText = 'position:fixed;right:16px;bottom:16px;width:120px';
    document.body.append(other);
  });
  await page.locator('#other').click();
  await expect(popover(page)).toHaveCount(0);
  await page.waitForTimeout(200); // no late jump back to the field
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('other');
});

test('scrolling the page closes the popover', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder());
  await page.goto(`${pagesURL}/textarea.html`);
  await page.evaluate(() => (document.body.style.minHeight = '3000px'));
  await page.locator('#ta').click();
  await page.keyboard.type('I has a cat');
  await selectInTextarea(page, 2, 11);
  await barButton(page, 'Improve').click();
  await expect(popover(page)).toBeVisible();
  await page.mouse.wheel(0, 200);
  await expect(popover(page)).toHaveCount(0, { timeout: 1000 });
});

test('a scroll elsewhere on the page keeps the bar', async ({ page, pagesURL }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'side';
    box.style.cssText = 'position:fixed;right:0;top:0;width:120px;height:120px;overflow:auto';
    box.innerHTML = '<div style="height:2000px">side</div>';
    document.body.append(box);
  });
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible();
  await page.locator('#side').evaluate((el) => el.scrollBy(0, 300));
  await page.waitForTimeout(300);
  await expect(bar(page)).toBeVisible();
});

test('while the popover is open, a new selection in the field shows no bar beside it', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  await expect(versionRows(page)).toHaveCount(3);
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => {
    el.focus(); // no click: that would close the popover
    el.setSelectionRange(0, 5);
  });
  await page.keyboard.press('Shift+ArrowRight'); // a selection event the bar follows
  await page.waitForTimeout(400);
  await expect(popover(page)).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
});

test('the field leaving the page closes the popover, and a late answer brings nothing back', async ({ page, pagesURL, mock }) => {
  let answer!: () => void;
  const released = new Promise<void>((resolve) => (answer = resolve));
  let rewriteSent = false;
  const reply = toolsResponder({ variants: VARIANTS });
  mock.respond(async (body) => {
    if (body.model !== SONNET) return reply(body);
    await released; // held until the field is gone
    rewriteSent = true;
    return reply(body);
  });
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  await expect(popover(page).getByRole('status')).toHaveText('Rewriting…');
  await page.locator('#ta').evaluate((el) => el.remove());
  await expect(popover(page)).toHaveCount(0);
  answer();
  await expect.poll(() => rewriteSent).toBe(true);
  await page.waitForTimeout(300); // the answer reaches the page
  await expect(popover(page)).toHaveCount(0);
});

test('a busy Claude and an unusable answer get the tools wording, and Retry asks again', async ({ page, pagesURL, mock }) => {
  const replies: object[] = [{ status: 429 }, { status: 429 }, { variants: [] }, { variants: VARIANTS }]; // the SDK retries a 429 once
  const reply = toolsResponder();
  mock.respond(async (body) => (body.model === SONNET ? replies.shift()! : reply(body)));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  const error = popover(page).locator('.englint-tools-error');
  await expect(error).toHaveText('Claude is busy right now. Try again in a moment.', { timeout: 10_000 });
  await popover(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(error).toHaveText("Couldn't get a usable answer from Claude. Try again.");
  await popover(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(versionRows(page)).toHaveCount(3);
});

test('a selection over 2,000 characters: the bar has only Fit a word limit on, a line says so, and nothing is sent', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder());
  const long = 'word '.repeat(420).trim(); // 2,099 characters
  await textareaWith(page, pagesURL, 'x');
  await page.locator('#ta').fill(long);
  await selectInTextarea(page, 0, long.length);
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  await expect(bar(page).locator('.englint-bar-hint')).toHaveText('Only Fit a word limit works on selections this long.');
  for (const name of ['Improve', 'Tone', 'My voice', 'More']) await expect(barButton(page, name)).toBeDisabled();
  await expect(barButton(page, 'Shorten')).toBeEnabled();
  await barButton(page, 'Improve').click({ force: true }); // off: the click does nothing
  await barButton(page, 'Shorten').click();
  await expect(bar(page).getByRole('menuitem', { name: 'Shorter' })).toBeDisabled();
  await expect(bar(page).getByRole('menuitem', { name: 'Fit a word limit…' })).toBeEnabled();
  await expect(popover(page)).toHaveCount(0);
  expect(sonnetRequests(mock)).toHaveLength(0);
});

test('the text changed while the popover was open, so nothing is applied', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Improve').click();
  await expect(versionRows(page)).toHaveCount(3);
  // The user types before the selection (focus moves back into the field; no click, which would close it).
  await page.locator('#ta').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(0, 0);
  });
  await page.keyboard.type('Oh ');
  await expect(popover(page)).toBeVisible();
  await versionRows(page).nth(1).click();
  await expect(popover(page).locator('.englint-tools-error')).toHaveText('The text changed. Select it again.');
  expect(await TEXTAREA.text(page)).toBe('Oh I has a cat');
});

test('fake Docs: a synonym applies through the paste path', async ({ page, pagesURL, mock }) => {
  mock.respond(toolsResponder({ options: [{ text: 'couch', nuance: 'everyday' }, ...SYNONYMS] }));
  await page.goto(`${pagesURL}/document/d/fake/edit.html`);
  await expect(page.locator('.kix-appview-editor')).toBeVisible();
  const line = await page.locator('.text-layer div').nth(1).boundingBox();
  await page.mouse.click(line!.x + 20, line!.y + line!.height / 2);
  const docText = () => page.evaluate(() => (window as any).fakeDocs.text() as string);
  await page.evaluate(() => {
    const fake = (window as any).fakeDocs;
    const start = fake.text().indexOf('sofa');
    fake.selection = { start: start + 'sofa'.length, end: start }; // backward, as shift+left leaves it
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(bar(page)).toBeVisible({ timeout: 3000 });
  await barButton(page, 'Synonyms').click(); // one word: on the bar itself
  await options(page).first().click();
  await expect.poll(docText).toContain('sleep on the couch.');
  expect(await page.evaluate(() => (window as any).fakeDocs.pastes)).toContain('couch');
  await expect(popover(page)).toHaveCount(0);
});

// ---- the right-click menu and the shortcut ----

const REWRITE = { kind: 'preset', presetId: 'rewrite' } as const;

/** The page's tab id (the only tab the test opened). */
const tabIdOf = (sw: Worker) => sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id as number);

/**
 * Sends `type` to one frame of the tab, the way the background does (@webext-core/messaging's envelope):
 * this stands in for the menu click, which Playwright can't make (Chrome's own menu). Resolves the reply.
 */
async function toFrame(sw: Worker, type: string, data: unknown, frameId = 0): Promise<any> {
  const tabId = await tabIdOf(sw);
  const reply = await sw.evaluate(
    ([tabId, type, data, frameId]) =>
      new Promise((resolve) =>
        chrome.tabs.sendMessage(tabId, { id: 1, type, data, timestamp: Date.now() }, { frameId }, (r: unknown) => resolve(r)),
      ),
    [tabId, type, data, frameId] as const,
  );
  return (reply as { res?: unknown } | undefined)?.res;
}

/** The background's menu and shortcut handlers (exposed in the e2e build only), called as Chrome would. */
const launcher = (sw: Worker, call: 'menuClicked' | 'command', ...args: unknown[]) =>
  sw.evaluate(([call, args]) => (globalThis as any).__englintLauncher[call](...args), [call, args] as const);

test('openTools (the menu, simulated) on a field selection opens the popover already loading Improve, in place of the bar', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  let answer!: () => void;
  const released = new Promise<void>((resolve) => (answer = resolve));
  const reply = toolsResponder({ variants: VARIANTS });
  mock.respond(async (body) => {
    if (body.model === SONNET) await released;
    return reply(body);
  });
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  await expect(bar(page)).toBeVisible({ timeout: 1000 });

  expect(await toFrame(serviceWorker, 'openTools', { request: REWRITE })).toEqual({ opened: true });
  await expect(popover(page).getByRole('status')).toHaveText('Rewriting…');
  await expect(popover(page).locator('.englint-tools-title')).toHaveText('Improve');
  await expect(bar(page)).toHaveCount(0); // one bar/popover state
  await expect.poll(() => sonnetRequests(mock).length).toBe(1);
  expect(userText(sonnetRequests(mock)[0])).toContain('<selection>\n"has a cat"\n</selection>');
  answer();
  await expect(versionRows(page)).toHaveCount(3);
  await versionRows(page).nth(1).click();
  await expect.poll(() => TEXTAREA.text(page)).toBe('I own a cat');
});

test('openTools with no field selection answers opened: false and opens nothing', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(toolsResponder());
  await textareaWith(page, pagesURL, 'I has a cat'); // a caret, no selection
  expect(await toFrame(serviceWorker, 'openTools', { request: REWRITE })).toEqual({ opened: false });
  await page.locator('#far').click({ clickCount: 3 }); // page text selected; no field has focus
  expect(await toFrame(serviceWorker, 'openTools', { request: REWRITE })).toEqual({ opened: false });
  await page.waitForTimeout(300);
  await expect(popover(page)).toHaveCount(0);
  expect(sonnetRequests(mock)).toHaveLength(0);
});

test("the menu in a box EngLint doesn't edit (an <input>) says so in the page, and sends nothing", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await page.goto(`${pagesURL}/textarea.html`);
  await page.locator('#txt').click();
  await page.keyboard.type('I has a cat');
  await page.locator('#txt').evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 11));
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => serviceWorker.evaluate(() => !!(globalThis as any).__englintLauncher)).toBe(true);
  await launcher(serviceWorker, 'menuClicked', { menuItemId: 'englint-rewrite', editable: true, frameId: 0 }, { id: tabId });
  await expect(page.locator('.englint-notice')).toHaveText("EngLint can't edit this box. Select text in a text area or document.");
  await expect(popover(page)).toHaveCount(0);
  expect(sonnetRequests(mock)).toHaveLength(0);
});

test('the menu on a switched-off site says EngLint is off there, and sends nothing', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['127.0.0.1'] }));
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => serviceWorker.evaluate(() => !!(globalThis as any).__englintLauncher)).toBe(true);
  await launcher(serviceWorker, 'menuClicked', { menuItemId: 'englint-rewrite', editable: true, frameId: 0 }, { id: tabId });
  await expect(page.locator('.englint-notice')).toHaveText('EngLint is off for this site.');
  await expect(popover(page)).toHaveCount(0);
  expect(sonnetRequests(mock)).toHaveLength(0);
});

test("a page script clicking the bar's buttons and items (through the e2e build's open root) sends nothing; the user's click does", async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await openBar(page, pagesURL, TEXTAREA, 'I has a cat', 2, 11);
  await barButton(page, 'Tone').click(); // its items are in the page now
  await page.evaluate(() => {
    const root = document.querySelector('englint-overlay')!.shadowRoot!;
    for (const item of root.querySelectorAll<HTMLButtonElement>('.englint-bar button')) item.click();
  });
  await page.waitForTimeout(300);
  expect(sonnetRequests(mock)).toHaveLength(0);
  await expect(barButton(page, 'Improve')).toBeVisible(); // still the bar
  await barButton(page, 'Improve').click();
  await expect(versionRows(page)).toHaveCount(3);
  expect(sonnetRequests(mock)).toHaveLength(1);
});

test('openTools with custom-prompt ("Ask anything…") opens the bar with its box focused', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  expect(await toFrame(serviceWorker, 'openTools', { request: 'custom-prompt' })).toEqual({ opened: true });
  const box = bar(page).getByPlaceholder('Tell EngLint what to do…');
  await expect(box).toBeFocused();
  expect(sonnetRequests(mock)).toHaveLength(0);
  await page.keyboard.type('make it vivid');
  await page.keyboard.press('Enter');
  await expect(versionRows(page)).toHaveCount(3);
});

test("pageSelection answers the top frame's selected text: page text, or a field's selection", async ({ page, pagesURL, serviceWorker }) => {
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  expect(await toFrame(serviceWorker, 'pageSelection', undefined)).toEqual({ text: 'has a cat' });
  await page.locator('#far').click({ clickCount: 3 });
  expect((await toFrame(serviceWorker, 'pageSelection', undefined)).text).toContain('Nothing to see here');
});

test('the shortcut, through the background: a focused field opens the popover; once focus leaves it, page text goes to the panel', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder());
  await textareaWith(page, pagesURL, 'I has a cat'); // its focus report tells the background which frame
  await selectInTextarea(page, 2, 11);
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => serviceWorker.evaluate(() => !!(globalThis as any).__englintLauncher)).toBe(true);
  await page.waitForTimeout(200); // the focus report reaches the background
  await launcher(serviceWorker, 'command', 'englint-tools', { id: tabId });
  await expect(barButton(page, 'Improve')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);

  await page.locator('#far').click({ clickCount: 3 }); // focus leaves the field: its blur is reported
  await page.waitForTimeout(300);
  await launcher(serviceWorker, 'command', 'englint-tools', { id: tabId }); // the panel can't open here (no gesture)
  const key = `tools:${tabId}`;
  await expect
    .poll(async () => ((await serviceWorker.evaluate((k) => chrome.storage.session.get(k), key)) as any)[key]?.text ?? '')
    .toContain('Nothing to see here');
  await expect(popover(page)).toHaveCount(0);
});

test('the menu, through the background: in a field it opens the popover with the request; on page text it stashes both', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => serviceWorker.evaluate(() => !!(globalThis as any).__englintLauncher)).toBe(true);
  await launcher(serviceWorker, 'menuClicked', { menuItemId: 'englint-shorter', editable: true, frameId: 0 }, { id: tabId });
  await expect(versionRows(page)).toHaveCount(3);
  expect(userText(sonnetRequests(mock)[0])).toContain('Make this shorter.');

  await launcher(
    serviceWorker,
    'menuClicked',
    { menuItemId: 'englint-formal', editable: false, selectionText: 'Nothing to see here', frameId: 0 },
    { id: tabId },
  );
  const key = `tools:${tabId}`;
  const stash = ((await serviceWorker.evaluate((k) => chrome.storage.session.get(k), key)) as any)[key];
  expect(stash).toEqual({ text: 'Nothing to see here', request: { kind: 'preset', presetId: 'formal' }, at: expect.any(Number) });
});

/** The fake Docs editor with focus in its text-event iframe and `part` selected through the bridge. */
async function docsWithSelection(page: Page, pagesURL: string, part: string, query = '') {
  await page.goto(`${pagesURL}/document/d/fake/edit.html${query}`);
  await expect(page.locator('.kix-appview-editor')).toBeVisible();
  const line = await page.locator('.text-layer div').nth(1).boundingBox();
  await page.mouse.click(line!.x + 20, line!.y + line!.height / 2); // focuses the text-event iframe, as in Docs
  await page.evaluate((part) => {
    const fake = (window as any).fakeDocs;
    const start = fake.text().indexOf(part);
    fake.selection = { start, end: start + part.length };
  }, part);
}

const stashText = async (sw: Worker, tabId: number) => {
  const key = `tools:${tabId}`;
  return (((await sw.evaluate((k) => chrome.storage.session.get(k), key)) as any)[key]?.text ?? '') as string;
};

/** The frame the background remembers as having the tab's focused field (`session:toolsFocus:<tabId>`), or null. */
const focusFrame = async (sw: Worker, tabId: number) => {
  const key = `toolsFocus:${tabId}`;
  return (((await sw.evaluate((k) => chrome.storage.session.get(k), key)) as any)[key] ?? null) as number | null;
};
const forgetFocus = (sw: Worker, tabId: number) => sw.evaluate((k) => chrome.storage.session.remove(k), `toolsFocus:${tabId}`);

/**
 * Stops the extension's worker, as Chrome does after about 30 s idle: its in-memory focus map is gone. The old
 * instance is marked first: Playwright keeps the same handle, which answers again once a new one runs.
 */
async function stopWorker(page: Page, sw: Worker) {
  await sw.evaluate(() => ((globalThis as any).__englintOld = true));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
}

/** The worker, once something woke a fresh one (stopWorker's mark is gone). */
async function liveWorker(context: BrowserContext, timeout = 10_000): Promise<Worker> {
  const answers = (w: Worker) =>
    Promise.race([
      w.evaluate(() => !!(globalThis as any).__englintLauncher && !(globalThis as any).__englintOld).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)), // a stopped worker: evaluate hangs
    ]);
  let live: Worker | null = null;
  await expect
    .poll(
      async () => {
        const w = context.serviceWorkers().at(-1);
        live = w && (await answers(w)) ? w : null;
        return live !== null;
      },
      { timeout },
    )
    .toBe(true);
  return live!;
}

/** A selection in a field has settled: the bar is up, and its fieldFocused has reached the background. */
async function settled(page: Page, sw: Worker, tabId: number) {
  await expect(bar(page)).toBeVisible({ timeout: 1000 });
  await expect.poll(() => focusFrame(sw, tabId)).toBe(0);
  await page.waitForTimeout(300); // the forced send that settling makes is in, too
}

/** Wakes a fresh worker through the options page (no field message), once its focus prefill has landed. */
async function wakeWorker(context: BrowserContext, old: Worker): Promise<Worker> {
  const other = await context.newPage();
  await other.goto(`chrome-extension://${new URL(old.url()).host}/options.html`);
  await expect(other.getByText('Key saved', { exact: true })).toBeVisible(); // it answered
  await other.close();
  const worker = await liveWorker(context);
  await worker.evaluate(() => (globalThis as any).__englintPrefill); // the read from storage.session
  return worker;
}

test('fake Docs: the shortcut opens the popover on the doc selection once the field has reported focus', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder({ variants: VARIANTS }));
  await docsWithSelection(page, pagesURL, 'has a cat');
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => focusFrame(serviceWorker, tabId), { timeout: 10_000 }).toBe(0); // its fieldFocused reached the background
  await launcher(serviceWorker, 'command', 'englint-tools', { id: tabId });
  await expect(barButton(page, 'Improve')).toBeFocused();
  await barButton(page, 'Improve').click();
  await expect(versionRows(page)).toHaveCount(3);
  expect(userText(sonnetRequests(mock)[0])).toContain('<selection>\n"has a cat"\n</selection>');
  expect(await stashText(serviceWorker, tabId)).toBe(''); // not the panel
});

test("fake Docs: focus leaving the doc and coming back reaches the background (this document's focus events miss both)", async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder());
  await docsWithSelection(page, pagesURL, 'has a cat');
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => focusFrame(serviceWorker, tabId), { timeout: 10_000 }).toBe(0);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); // out of the text-event iframe, to the page
  await expect.poll(() => focusFrame(serviceWorker, tabId)).toBeNull();
  const line = await page.locator('.text-layer div').nth(1).boundingBox();
  await page.mouse.click(line!.x + 20, line!.y + line!.height / 2); // back into the doc
  await expect.poll(() => focusFrame(serviceWorker, tabId)).toBe(0);
});

test('fake Docs after a worker restart: a selection settling in the doc refills the map, so the shortcut opens the popover', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  context,
}) => {
  mock.respond(toolsResponder());
  await docsWithSelection(page, pagesURL, 'has a cat');
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => focusFrame(serviceWorker, tabId), { timeout: 10_000 }).toBe(0); // the field said it has focus
  await page.waitForTimeout(300); // nothing else on its way
  await forgetFocus(serviceWorker, tabId); // no prefill: only the selection can refill the map
  await stopWorker(page, serviceWorker);
  const selected = Date.now();
  await page.evaluate(() => {
    const fake = (window as any).fakeDocs;
    const start = fake.text().indexOf('a cat');
    fake.selection = { start, end: start + 'a cat'.length };
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); // the selection settles
  });
  const worker = await liveWorker(context); // woken by the frame's fieldFocused
  await expect.poll(() => focusFrame(worker, tabId)).toBe(0);
  expect(Date.now() - selected).toBeLessThan(5000); // the settling send, not the 10 s heartbeat
  await launcher(worker, 'command', 'englint-tools', { id: tabId });
  await expect(barButton(page, 'Improve')).toBeFocused();
  expect(await stashText(worker, tabId)).toBe('');
});

test('a selection left in a field: its heartbeat refills the map after a worker restart, so the shortcut opens the popover', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  context,
}) => {
  mock.respond(toolsResponder());
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  const tabId = await tabIdOf(serviceWorker);
  await settled(page, serviceWorker, tabId);
  await forgetFocus(serviceWorker, tabId); // no prefill: only the heartbeat can refill the map
  await stopWorker(page, serviceWorker);
  const stopped = Date.now();
  // A fresh worker may start earlier (the live check's own message), but only a fieldFocused brings the key back.
  const worker = await liveWorker(context, 15_000);
  await expect.poll(() => focusFrame(worker, tabId), { timeout: 15_000 }).toBe(0);
  expect(Date.now() - stopped).toBeGreaterThan(5000); // the 10 s heartbeat, not a send at once
  await launcher(worker, 'command', 'englint-tools', { id: tabId });
  await expect(barButton(page, 'Improve')).toBeFocused();
});

test('after a worker restart woken by something else, the prefill from storage.session opens the popover for a focused field', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  context,
}) => {
  mock.respond(toolsResponder());
  await textareaWith(page, pagesURL, 'I has a cat');
  await selectInTextarea(page, 2, 11);
  const tabId = await tabIdOf(serviceWorker);
  await settled(page, serviceWorker, tabId);
  await stopWorker(page, serviceWorker);
  const worker = await wakeWorker(context, serviceWorker); // the options page, not the field
  await launcher(worker, 'command', 'englint-tools', { id: tabId });
  await expect(barButton(page, 'Improve')).toBeFocused();
});

test('after a worker restart, the shortcut on page text still takes the panel path: a blurred field is not prefilled back', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
  context,
}) => {
  mock.respond(toolsResponder());
  await textareaWith(page, pagesURL, 'I has a cat'); // TabState's activeFieldId stays this field after the blur
  const tabId = await tabIdOf(serviceWorker);
  await expect.poll(() => focusFrame(serviceWorker, tabId)).toBe(0);
  await page.locator('#far').click({ clickCount: 3 }); // focus leaves the field
  await expect.poll(() => focusFrame(serviceWorker, tabId)).toBeNull();
  await stopWorker(page, serviceWorker);
  const worker = await wakeWorker(context, serviceWorker);
  await launcher(worker, 'command', 'englint-tools', { id: tabId });
  await expect.poll(() => stashText(worker, tabId)).toContain('Nothing to see here');
  await expect(popover(page)).toHaveCount(0);
});

test('fake Docs in fallback mode: the shortcut takes the panel path (no field to open the popover on)', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  mock.respond(toolsResponder());
  await docsWithSelection(page, pagesURL, 'has a cat', '?paint=mismatch');
  await expect(page.locator('.englint-notice')).toHaveText("Google Docs live checking isn't available right now.", { timeout: 10_000 });
  // The page's own text is all a panel could get here (live Docs draws on a canvas: usually nothing).
  await page.evaluate(() => {
    const node = document.querySelectorAll('.text-layer div')[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  const want = await page.evaluate(() => document.getSelection()!.toString());
  const tabId = await tabIdOf(serviceWorker);
  await launcher(serviceWorker, 'command', 'englint-tools', { id: tabId });
  await expect.poll(() => stashText(serviceWorker, tabId)).toBe(want);
  await expect(popover(page)).toHaveCount(0);
});

test('the right-click menu is registered in Chrome: the parent and every child exist', async ({ serviceWorker }) => {
  const ids = ['englint', 'englint-rewrite', 'englint-shorten', 'englint-shorter', 'englint-wordLimit', 'englint-tone', 'englint-formal', 'englint-confident', 'englint-friendlier', 'englint-casual', 'englint-voice', 'englint-more', 'englint-expand', 'englint-synonyms', 'englint-custom'];
  // contextMenus has no getter: update() fails with "Cannot find menu item with id …" for an item that isn't there.
  const missing = () =>
    serviceWorker.evaluate(async (ids) => {
      const errors: string[] = [];
      for (const id of ids) {
        const error = await new Promise<string | null>((resolve) =>
          chrome.contextMenus.update(id, { enabled: true }, () => resolve(chrome.runtime.lastError?.message ?? null)),
        );
        if (error) errors.push(`${id}: ${error}`);
      }
      return errors;
    }, ids);
  await expect.poll(missing).toEqual([]); // registered on install
});

// ---- comment-only clarity notes: "Rewrite sentence" on the card ----
const NOTE = {
  original: 'very unique',
  replacement: null,
  before: 'The plan is',
  category: 'clarity',
  severity: 'suggestion',
  kind: 'redundancy',
  reason: 'r',
};
const withNote = (extra: object = {}) =>
  toolsResponder({
    variants: ['The plan is unique.', 'The plan stands alone.', 'No plan is like it.'],
    issues: (t) => (t.includes('very unique') ? [NOTE] : []),
    ...extra,
  });
const TWO_SENTENCES = 'First, hello there. The plan is very unique. Last one.';

/** Hovers the note's underline, which opens its card. */
async function openNoteCard(page: Page, pagesURL: string): Promise<void> {
  await textareaWith(page, pagesURL, TWO_SENTENCES);
  const underline = page.locator('.englint-underline').first();
  await expect(underline).toBeVisible({ timeout: 3000 });
  const box = (await underline.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.englint-card')).toBeVisible();
}

test('a comment-only note: its primary is "Rewrite sentence", Stop suggesting is in its menu; it opens Rewrite on that sentence and a version replaces it', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await clarityOn(serviceWorker);
  mock.respond(withNote());
  await openNoteCard(page, pagesURL);
  const card = page.locator('.englint-card');
  await expect(card.locator('.englint-card-accept')).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveText(['', 'Rewrite sentence', 'Dismiss']); // "⋯" first, an icon
  const more = card.getByRole('button', { name: 'More actions' });
  await more.click();
  await expect(card.getByRole('menuitem')).toHaveText(['Stop suggesting redundant words']); // the primary rewrites
  await more.click();
  await expect(card.getByRole('menu')).toHaveCount(0);
  await card.getByRole('button', { name: 'Rewrite sentence' }).click();
  await expect(card).toHaveCount(0);
  await expect(versionRows(page)).toHaveCount(3);
  const user = userText(sonnetRequests(mock).at(-1));
  expect(user).toContain('<selection>\n"The plan is very unique."\n</selection>');
  await versionRows(page).nth(1).click();
  await expect(page.locator('#ta')).toHaveValue('First, hello there. The plan stands alone. Last one.');
});

test('a card with a fix: "Rewrite sentence" in its menu opens Rewrite on that sentence', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  mock.respond(withNote({ issues: (t: string) => (t.includes('very unique') ? [{ ...NOTE, replacement: 'unique' }] : []) }));
  await openNoteCard(page, pagesURL);
  const card = page.locator('.englint-card');
  await card.getByRole('button', { name: 'More actions' }).click();
  await expect(card.getByRole('menuitem')).toHaveText(['Stop suggesting redundant words', 'Rewrite sentence']);
  await expect(page.locator('#ta')).toBeFocused(); // a pointer's open leaves focus in the field
  await card.getByRole('menuitem', { name: 'Rewrite sentence' }).click();
  await expect(card).toHaveCount(0);
  await expect(versionRows(page)).toHaveCount(3);
  expect(userText(sonnetRequests(mock).at(-1))).toContain('<selection>\n"The plan is very unique."\n</selection>');
});

test('a comment-only note on an Essay site: Rewrite sentence shows the critique first', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await clarityOn(serviceWorker);
  await essaySite(serviceWorker);
  mock.respond(withNote({ critique: { weakness: '"Very unique" is not a degree.', light_fix: 'The plan is unique.' } }));
  await openNoteCard(page, pagesURL);
  await page.locator('.englint-card').getByRole('button', { name: 'Rewrite sentence' }).click();
  await expect(popover(page).locator('.englint-tools-weakness')).toHaveText('"Very unique" is not a degree.');
  expect(sonnetRequests(mock).map(isCritique)).toEqual([true]);
});

test('Rewrite sentence on an Essay comment-only long_sentence note sends the note as <focus>', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await clarityOn(serviceWorker);
  await essaySite(serviceWorker);
  const note = { ...NOTE, kind: 'long_sentence', reason: 'Runs through too many ideas.' };
  mock.respond(
    toolsResponder({
      critique: { weakness: 'It tries to say too much.', light_fix: 'The plan is unique.' },
      issues: (t) => (t.includes('very unique') ? [note] : []),
    }),
  );
  await openNoteCard(page, pagesURL);
  await page.locator('.englint-card').getByRole('button', { name: 'Rewrite sentence' }).click();
  await expect(popover(page).locator('.englint-tools-weakness')).toBeVisible();
  const user = userText(sonnetRequests(mock).at(-1));
  expect(user).toContain('<focus>');
  expect(user).toContain('very long sentences');
  expect(user).toContain('Runs through too many ideas.');
});

test('Dismiss on a comment-only note removes it', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  mock.respond(withNote());
  await openNoteCard(page, pagesURL);
  await page.locator('.englint-card').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.englint-underline')).toHaveCount(0);
});
