import type { Locator, Page, Worker } from '@playwright/test';
import { clarityOn, expect, test } from './fixtures';
import { type MockReply, paragraphsOf } from './mock-anthropic';
import { rgba } from './pixels';

// Suggestion families on the page: their underline styles, the family toggles and the card's "Stop suggesting"
// and "Add to dictionary" (with the undo chip) re-filtering held results with no new request, a curled
// apostrophe inside a suggestion, and the hover corridor from an underline into its card.

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

const WORDY: Issue = { original: 'In order to', replacement: 'To', before: '', category: 'clarity', severity: 'suggestion', kind: 'wordy_phrase', reason: 'r' };
const REPEAT: Issue = { original: 'very very', replacement: 'very', before: 'It was', category: 'engagement', severity: 'suggestion', kind: 'repeated_word', reason: 'r' };
const CHAIRMAN: Issue = { original: 'chairman', replacement: 'chair', before: 'Ask the', category: 'delivery', severity: 'suggestion', kind: 'inclusive_language', reason: 'r' };
const TESTAMENT: Issue = { original: 'stands as a testament to', replacement: 'shows', before: 'The bridge', category: 'delivery', severity: 'suggestion', kind: 'generic_phrasing', reason: 'r' };
const KUBERNETES: Issue = { original: 'Kubernetes', replacement: 'Kubernets', before: 'We deploy on', category: 'spelling', severity: 'error', kind: 'spelling', reason: 'r' };
const HAS: Issue = { original: 'has', replacement: 'have', before: 'I', category: 'grammar', severity: 'error', kind: 'subject_verb_agreement', reason: 'r' };
const REALLY: Issue = { original: "don't really", replacement: "don't", before: 'I', category: 'clarity', severity: 'suggestion', kind: 'redundancy', reason: 'r' };

/** Each paragraph gets the issues whose `original` it contains, read as the model does (straight quotes). */
const answering =
  (...issues: Issue[]) =>
  async (body: any): Promise<MockReply> => ({
    results: paragraphsOf(body).map((p) => ({ paragraph_id: p.id, issues: issues.filter((i) => p.text.replace(/’/g, "'").includes(i.original)) })),
  });

const FOUR_FAMILIES = ['In order to win, we practice.', 'It was very very good.', 'Ask the chairman first.', 'The bridge stands as a testament to their skill.'].join('\n');

const ALL_ON = { clarity: true, engagement: true, delivery: true, generic: true };
const ALL_OFF = { clarity: false, engagement: false, delivery: false, generic: false };

async function setFamilies(sw: Worker, standard: typeof ALL_ON): Promise<void> {
  await sw.evaluate(
    (fam) => chrome.storage.local.set({ suggestionFamiliesByMode: { essay: fam.standard, standard: fam.standard, casual: fam.off } }),
    { standard, off: ALL_OFF },
  );
}
const stored = (sw: Worker, key: string) => sw.evaluate((key) => chrome.storage.local.get(key), key);

const underline = (page: Page, cls = '') => page.locator(`.englint-underline${cls}`);
const card = (page: Page) => page.locator('.englint-card');
const chip = (page: Page) => page.locator('.englint-undo');
/** Opens the card's "⋯" menu; its items are the setting action, then "Rewrite sentence". */
async function openMenu(page: Page): Promise<Locator> {
  await card(page).getByRole('button', { name: 'More actions' }).click();
  return card(page).getByRole('menuitem');
}
/** Picks `name` from the card's "⋯" menu. */
async function pickFromMenu(page: Page, name: string): Promise<void> {
  await openMenu(page);
  await card(page).getByRole('menuitem', { name }).click();
}

async function typeIn(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).click();
  await page.keyboard.type(text);
}

/** Moves the real pointer onto the middle of an underline (it takes no pointer events, so hover() can't). */
async function pointAt(target: Locator): Promise<void> {
  const box = (await target.first().boundingBox())!;
  await target.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** Computed style of an element or its ::before. */
const style = (el: Locator, pseudo?: string) =>
  el.first().evaluate((node, pseudo) => {
    const cs = getComputedStyle(node, pseudo);
    return { image: cs.backgroundImage, color: cs.backgroundColor };
  }, pseudo);

const settled = (el: Locator) => el.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));

test('Engagement, Delivery and Generic phrasing underlines draw in their own classes, colours and names', async ({ page, pagesURL, mock, serviceWorker }) => {
  await setFamilies(serviceWorker, ALL_ON);
  mock.respond(answering(WORDY, REPEAT, CHAIRMAN, TESTAMENT));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', FOUR_FAMILIES);
  await expect(underline(page, '.suggestion')).toHaveCount(4, { timeout: 3000 });

  // The light scheme's family colours: an underline lies on the page, whatever the system's scheme.
  const families = [
    { cls: '.fam-clarity', label: 'Clarity suggestion', rgb: [37, 99, 235] },
    { cls: '.fam-engagement', label: 'Engagement suggestion', rgb: [22, 163, 74] },
    { cls: '.fam-delivery', label: 'Delivery suggestion', rgb: [147, 51, 234] },
    { cls: '.fam-generic', label: 'Generic phrasing', rgb: [234, 88, 12] },
  ];
  for (const f of families) {
    const u = underline(page, `.suggestion${f.cls}`);
    const colour = `rgb(${f.rgb.join(', ')})`;
    await expect(u).toHaveCount(1);
    await expect(u).toHaveAttribute('aria-label', f.label);
    await expect(u).toHaveAttribute('data-line', 'dotted');
    const { image } = await style(u, '::before');
    expect(image).toContain('radial-gradient');
    expect(image).toContain(colour);
    expect((await u.boundingBox())!.height).toBeCloseTo(2, 0);

    // Hovered: 1px thicker in its own colour, under a tint of its own colour.
    await pointAt(u);
    await expect(underline(page, `${f.cls}.active`)).toHaveCount(1);
    await expect.poll(async () => (await underline(page, `${f.cls}.active`).boundingBox())!.height).toBeCloseTo(3, 0);
    expect((await style(underline(page, `${f.cls}.active`), '::before')).image).toContain(colour);
    expect(rgba((await style(page.locator(`.englint-tint${f.cls}`))).color)).toEqual([...f.rgb, 0.14]);
  }

  // Under the system's dark scheme the page stays white, and the underlines keep these colours.
  await page.emulateMedia({ colorScheme: 'dark' });
  expect((await style(underline(page, '.fam-engagement'), '::before')).image).toContain('rgb(22, 163, 74)');
});

test('a comment-only note is dashed, in its family\u2019s colour', async ({ page, pagesURL, mock, serviceWorker }) => {
  await setFamilies(serviceWorker, ALL_ON);
  mock.respond(answering({ ...REPEAT, replacement: null }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'It was very very good.');
  const u = underline(page, '.fam-engagement');
  await expect(u).toHaveCount(1, { timeout: 3000 });
  await expect(u).toHaveAttribute('data-line', 'dashed');
  const { image } = await style(u, '::before');
  expect(image).toContain('linear-gradient');
  expect(image).toContain('rgb(22, 163, 74)');
});

test('turning Engagement off in storage hides its underline within 500 ms with no new request; on again brings it back', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await setFamilies(serviceWorker, ALL_ON);
  mock.respond(answering(WORDY, REPEAT, CHAIRMAN, TESTAMENT));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', FOUR_FAMILIES);
  await expect(underline(page, '.suggestion')).toHaveCount(4, { timeout: 3000 });
  const requests = mock.requests.length;

  await setFamilies(serviceWorker, { ...ALL_ON, engagement: false });
  await expect(underline(page, '.fam-engagement')).toHaveCount(0, { timeout: 500 });
  await expect(underline(page, '.suggestion')).toHaveCount(3);

  await setFamilies(serviceWorker, ALL_ON);
  await expect(underline(page, '.fam-engagement')).toHaveCount(1, { timeout: 500 });
  await page.waitForTimeout(1500); // past the 1 s debounce: nothing was sent meanwhile either
  expect(mock.requests.length).toBe(requests);
});

test('"Stop suggesting …" hides the underline and shows the undo chip where the card was; Undo brings it back; no new request', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await clarityOn(serviceWorker);
  mock.respond(answering(WORDY));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'In order to win, we practice.');
  await expect(underline(page, '.fam-clarity')).toHaveCount(1, { timeout: 3000 });
  const requests = mock.requests.length;

  await pointAt(underline(page, '.fam-clarity'));
  await expect(card(page)).toBeVisible();
  await settled(card(page)); // measured at full size
  await expect(card(page).locator('.englint-card-preview ins')).toHaveText('To');
  await expect(card(page).getByRole('button')).toHaveText(['', 'Accept', 'Dismiss']); // "⋯" first, an icon
  const cardBox = (await card(page).boundingBox())!;
  await expect(await openMenu(page)).toHaveText(['Stop suggesting wordy phrases', 'Rewrite sentence']);

  await card(page).getByRole('menuitem', { name: 'Stop suggesting wordy phrases' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(underline(page)).toHaveCount(0);
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveText('Stopped suggesting wordy phrases.Undo');
  await settled(chip(page));
  const chipBox = (await chip(page).boundingBox())!;
  expect(Math.abs(chipBox.x - cardBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(chipBox.y - cardBox.y)).toBeLessThanOrEqual(1);
  expect(await stored(serviceWorker, 'rules')).toEqual({ rules: [{ mode: 'standard', kind: 'wordy_phrase' }] });
  await expect(page.locator('#ta')).toBeFocused(); // the buttons never took focus from the field

  await chip(page).getByRole('button', { name: 'Undo' }).click();
  await expect(chip(page)).toHaveCount(0);
  await expect(underline(page, '.fam-clarity')).toHaveCount(1);
  expect(await stored(serviceWorker, 'rules')).toEqual({ rules: [] });
  await page.waitForTimeout(1500);
  expect(mock.requests.length).toBe(requests);
});

test('the undo chip closes after 5 s, on Esc, and on a click elsewhere; the setting stays', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  const PASSIVE: Issue = { ...WORDY, original: 'was written', replacement: 'wrote', before: 'The letter', kind: 'passive_voice' };
  const REDUNDANT: Issue = { ...WORDY, original: 'end result', replacement: 'result', before: 'The', kind: 'redundancy' };
  mock.respond(answering(WORDY, PASSIVE, REDUNDANT));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'In order to win, we practice.\nThe letter was written by me.\nThe end result is fine.');
  await expect(underline(page, '.fam-clarity')).toHaveCount(3, { timeout: 3000 });
  const stop = async (index: number, label: string) => {
    await pointAt(underline(page, '.fam-clarity').nth(index));
    await pickFromMenu(page, `Stop suggesting ${label}`);
    await expect(chip(page)).toHaveText(`Stopped suggesting ${label}.Undo`);
  };

  await stop(0, 'wordy phrases');
  await page.waitForTimeout(4000);
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveCount(0, { timeout: 1500 }); // 5 s after it showed
  await expect(underline(page, '.fam-clarity')).toHaveCount(2); // the rule stays

  await stop(0, 'passive voice');
  await page.keyboard.press('Escape');
  await expect(chip(page)).toHaveCount(0);
  await expect(underline(page, '.fam-clarity')).toHaveCount(1);

  await stop(0, 'redundant words');
  await page.locator('#far').click();
  await expect(chip(page)).toHaveCount(0);
  await expect(underline(page)).toHaveCount(0);
});

test('the third dismissal of a kind offers to stop it; Stop hides the rest of that kind and shows the undo chip', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  const PASSIVE: Issue = { ...WORDY, original: 'was written', replacement: 'wrote', before: 'The letter', kind: 'passive_voice' };
  mock.respond(answering(PASSIVE));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', ['The letter was written by me.', 'The poem was written at dawn.', 'The essay was written twice.', 'The song was written in May.'].join('\n'));
  await expect(underline(page, '.fam-clarity')).toHaveCount(4, { timeout: 3000 });
  const dismiss = async () => {
    await page.mouse.move(1, 1);
    await pointAt(underline(page, '.fam-clarity'));
    await expect(card(page)).toBeVisible();
    await card(page).getByRole('button', { name: 'Dismiss' }).click();
  };

  await dismiss();
  await dismiss();
  await expect(underline(page, '.fam-clarity')).toHaveCount(2);
  await expect(chip(page)).toHaveCount(0);

  await page.mouse.move(1, 1);
  await pointAt(underline(page, '.fam-clarity'));
  await expect(card(page)).toBeVisible();
  await settled(card(page));
  const cardBox = (await card(page).boundingBox())!;
  await card(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(chip(page)).toHaveText('Stop suggesting passive voice in other writing?StopNot now');
  await settled(chip(page));
  const chipBox = (await chip(page).boundingBox())!;
  expect(Math.abs(chipBox.x - cardBox.x)).toBeLessThanOrEqual(1); // where the card was
  expect(Math.abs(chipBox.y - cardBox.y)).toBeLessThanOrEqual(1);
  await expect(underline(page, '.fam-clarity')).toHaveCount(1);
  await chip(page).getByRole('button', { name: 'Stop' }).click();
  await expect(chip(page)).toHaveText('Stopped suggesting passive voice.Undo');
  await expect(underline(page, '.fam-clarity')).toHaveCount(0);
  expect(await stored(serviceWorker, 'rules')).toEqual({ rules: [{ mode: 'standard', kind: 'passive_voice' }] });
  await expect(page.locator('#ta')).toBeFocused();
});

test('the undo chip covers text in the fixed layer: the pointer on it hovers nothing there and opens no card', async ({ page, pagesURL, mock, serviceWorker }) => {
  await clarityOn(serviceWorker);
  const PASSIVE: Issue = { ...WORDY, original: 'was written', replacement: 'wrote', before: 'The letter', kind: 'passive_voice' };
  mock.respond(answering(WORDY, PASSIVE));
  await page.setViewportSize({ width: 1280, height: 900 }); // room for the card below the first line
  await page.goto(`${pagesURL}/scroll.html`);
  await typeIn(page, '#static-ta', 'In order to win, we practice.\nThe letter was written by me.');
  await expect(underline(page, '.fam-clarity')).toHaveCount(2, { timeout: 3000 });
  await expect(page.locator('englint-field-layer')).toHaveCount(0); // no anchor: the fixed layer, which paints over the page

  await pointAt(underline(page, '.fam-clarity').first());
  await expect(card(page)).toHaveAttribute('data-side', 'below');
  await pickFromMenu(page, 'Stop suggesting wordy phrases');
  await expect(chip(page)).toBeVisible();
  await settled(chip(page));
  // Where the card was, below the first line, the chip covers the next line's underline.
  const covered = (await underline(page, '.fam-clarity').boundingBox())!;
  const c = (await chip(page).boundingBox())!;
  const at = { x: covered.x + covered.width / 2, y: covered.y + covered.height / 2 };
  expect(at.x > c.x && at.x < c.x + c.width && at.y > c.y && at.y < c.y + c.height).toBe(true);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(400); // past the open delay
  await expect(page.locator('.englint-tint')).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  await expect(chip(page)).toBeVisible();
});

test('"Add “Kubernetes” to dictionary" hides the spelling underline and stores the lowercased word', async ({ page, pagesURL, mock, serviceWorker }) => {
  mock.respond(answering(KUBERNETES));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'We deploy on Kubernetes daily.');
  await expect(underline(page, '.error')).toHaveCount(1, { timeout: 3000 });
  const requests = mock.requests.length;

  await pointAt(underline(page, '.error'));
  await expect(card(page).locator('.englint-card-preview ins')).toHaveText('Kubernets');
  await expect(card(page).getByRole('button')).toHaveText(['', 'Accept', 'Dismiss']);
  await expect(await openMenu(page)).toHaveText(['Add “Kubernetes” to dictionary', 'Rewrite sentence']);
  await card(page).getByRole('menuitem', { name: 'Add “Kubernetes” to dictionary' }).click();
  await expect(underline(page)).toHaveCount(0);
  await expect(chip(page)).toHaveText('Added “Kubernetes” to your dictionary.Undo');
  expect(await stored(serviceWorker, 'dictionary')).toEqual({ dictionary: ['kubernetes'] });
  expect(mock.requests.length).toBe(requests);
});

test('a curled apostrophe inside a suggestion: "don’t really" is underlined from the model’s "don\'t really", and accepting keeps ’', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await clarityOn(serviceWorker);
  mock.respond(answering(REALLY));
  await page.goto(`${pagesURL}/contenteditable.html`);
  await typeIn(page, '#ce', 'I don’t really know.');
  await expect(underline(page, '.fam-clarity')).toHaveCount(1, { timeout: 3000 });
  const sent = paragraphsOf(mock.requests.at(-1)).map((p) => p.text);
  expect(sent).toEqual(['I don’t really know.']); // the page's own curled text went out

  // The underline spans "don’t really" in the editor.
  const want = await page.evaluate(() => {
    const text = document.querySelector('#ce')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf('don’t'));
    range.setEnd(text, text.data.indexOf(' know'));
    const r = range.getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  const box = (await underline(page, '.fam-clarity').boundingBox())!;
  expect(Math.abs(box.x - want.left)).toBeLessThan(2);
  expect(Math.abs(box.width - want.width)).toBeLessThan(2);

  await pointAt(underline(page, '.fam-clarity'));
  await expect(card(page).locator('.englint-card-preview ins')).toHaveText('don’t');
  await card(page).locator('.englint-card-accept').click();
  await expect(page.locator('#ce')).toHaveText('I don’t know.');
});

test('hover: moving from the underline into the card over about 120 ms keeps it open; leaving both closes it in 150 ms ± 100', async ({
  page,
  pagesURL,
  mock,
}) => {
  mock.respond(answering(HAS));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'I has a cat.');
  await expect(underline(page, '.error')).toHaveCount(1, { timeout: 3000 });
  await pointAt(underline(page, '.error'));
  await expect(card(page)).toBeVisible();
  await settled(card(page));
  const u = (await underline(page, '.error').boundingBox())!;
  const c = (await card(page).boundingBox())!;
  expect(c.y - (u.y + u.height)).toBeGreaterThanOrEqual(5); // a gap between the text and the card to cross

  // The corridor, paced in the page: about 120 ms below the text and above the card (on neither), then into the card.
  const corridor = await page.evaluate(
    async ({ u, c }) => {
      const move = (x: number, y: number) => document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const x = u.x + u.width / 2;
      const gapY = u.y + u.height + 3;
      const t0 = performance.now();
      for (let i = 0; i < 6; i++) {
        move(x + i, gapY);
        await sleep(20);
      }
      move(x + 6, c.y + 12);
      const ms = performance.now() - t0;
      await sleep(400); // well past the close delay, resting on the card
      const root = document.querySelector('englint-overlay')!.shadowRoot!;
      return { ms, open: root.querySelector('.englint-card') !== null };
    },
    { u, c },
  );
  expect(corridor.ms).toBeGreaterThan(100);
  expect(corridor.ms).toBeLessThan(145);
  expect(corridor.open).toBe(true);

  // Leaving both with the real pointer: the time from that move's event to the card's removal, both in the page.
  await page.evaluate(() => {
    const w = window as any;
    const root = document.querySelector('englint-overlay')!.shadowRoot!;
    w.__left = undefined;
    w.__gone = undefined;
    document.addEventListener('mousemove', (e) => (w.__left ??= e.timeStamp), { capture: true, once: true });
    const obs = new MutationObserver(() => {
      if (root.querySelector('.englint-card')) return;
      w.__gone = performance.now();
      obs.disconnect();
    });
    obs.observe(root, { childList: true, subtree: true });
  });
  const far = (await page.locator('#far').boundingBox())!;
  await page.mouse.move(far.x + 5, far.y + 5);
  await expect.poll(() => page.evaluate(() => (window as any).__gone), { timeout: 2000 }).not.toBeUndefined();
  const closedAfter = await page.evaluate(() => (window as any).__gone - (window as any).__left);
  expect(closedAfter).toBeGreaterThanOrEqual(50);
  expect(closedAfter).toBeLessThanOrEqual(250);
});

test('a generic-phrasing tell is underlined from the text alone, before any Claude answer, and its fix applies "is"', async ({
  page,
  pagesURL,
  mock,
  serviceWorker,
}) => {
  await setFamilies(serviceWorker, ALL_ON);
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'The library serves as a meeting place.');
  await expect(underline(page, '.fam-generic')).toHaveCount(1, { timeout: 500 });
  expect(mock.requests.length).toBe(0);

  await pointAt(underline(page, '.fam-generic'));
  await expect(card(page).locator('.englint-card-preview ins')).toHaveText('is');
  await expect(await openMenu(page)).toHaveText(['Stop suggesting generic phrasing', 'Rewrite sentence']);
  await page.locator('.englint-card-accept').click();
  await expect(page.locator('#ta')).toHaveValue('The library is a meeting place.');
  await expect(underline(page)).toHaveCount(0);
});

test('a generic-phrasing tell is not drawn while the Generic phrasing toggle is off', async ({ page, pagesURL, mock, serviceWorker }) => {
  await setFamilies(serviceWorker, { ...ALL_ON, generic: false });
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'The library serves as a meeting place.');
  await page.waitForTimeout(1500);
  await expect(underline(page)).toHaveCount(0);
  expect(mock.requests.length).toBe(1);
});

test('a switched-off site draws no generic-phrasing tell', async ({ page, pagesURL, serviceWorker }) => {
  await setFamilies(serviceWorker, ALL_ON);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ disabledSites: ['127.0.0.1'] }));
  await page.goto(`${pagesURL}/textarea.html`);
  await typeIn(page, '#ta', 'The library serves as a meeting place.');
  await page.waitForTimeout(1500);
  await expect(underline(page)).toHaveCount(0);
});
