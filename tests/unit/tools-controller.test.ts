import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Field } from '../../src/content/field-host';
import {
  TOOLS_COPY,
  createToolsController,
  type ToolsHandlers,
  type ToolsRange,
  type ToolsView,
} from '../../src/content/tools/tools-controller';
import type { ToolRequest } from '../../src/core/presets';
import type { Mode } from '../../src/core/types';
import type { FollowUpResponse, RewriteResponse, SynonymsResponse, sendMessage } from '../../src/shared/messages';

// The controller against a fake field (adapter with a text the test can change), a fake overlay that
// records every showTools/flash call, and a fake send whose answers the test settles in any order.

const RECT = new DOMRect(10, 20, 50, 16);

function fakeField(initial: string) {
  const state = { text: initial, replaceResult: true };
  const layout = new Set<(scrolled?: EventTarget | null) => void>();
  const element = document.createElement('textarea');
  document.body.appendChild(element);
  const adapter = {
    fieldId: 'f1',
    element,
    getText: vi.fn(async () => state.text),
    rectsFor: vi.fn(async (): Promise<DOMRect[]> => [RECT]),
    replace: vi.fn(async (start: number, end: number, text: string) => {
      if (!state.replaceResult) return false;
      state.text = state.text.slice(0, start) + text + state.text.slice(end);
      return true;
    }),
    select: vi.fn(async () => {}),
    onLayoutChange: vi.fn((cb: (scrolled?: EventTarget | null) => void) => {
      layout.add(cb);
      return () => layout.delete(cb);
    }),
    isAlive: () => true,
  };
  const f = { el: element, fieldId: 'f1', adapter } as unknown as Field;
  /** The adapter reports a layout change; `scrolled`: what scrolled. */
  const fireLayout = (scrolled?: EventTarget | null) => [...layout].forEach((cb) => cb(scrolled));
  return { f, adapter, state, layout, fireLayout, element };
}

/** The range of `part` in `text`, as readFieldSelection would give it. */
function rangeOf(text: string, part: string): ToolsRange {
  const start = text.indexOf(part);
  if (start < 0) throw new Error('part not in text');
  return { start, end: start + part.length, text: part };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Sent = { type: 'rewrite' | 'synonyms' | 'followUp'; data: any; reply: Deferred<any> };

function setup(text: string, mode: Mode = 'standard') {
  const field = fakeField(text);
  const shows: { anchor: DOMRect | null; view: ToolsView | null; handlers: ToolsHandlers }[] = [];
  const overlay = {
    showTools: vi.fn((anchor: DOMRect | null, view: ToolsView | null, handlers: ToolsHandlers) => {
      shows.push({ anchor, view, handlers });
    }),
    flash: vi.fn(),
  };
  const sent: Sent[] = [];
  const send = vi.fn((type: Sent['type'], data: unknown) => {
    const reply = deferred<any>();
    sent.push({ type, data, reply });
    return reply.promise;
  });
  const getMode = vi.fn(() => mode);
  const tools = createToolsController({
    overlay,
    host: 'example.com',
    getMode,
    send: send as unknown as typeof sendMessage,
  });
  const last = () => shows[shows.length - 1];
  const view = () => last()?.view ?? null;
  const handlers = () => last()!.handlers;
  return { ...field, tools, overlay, shows, sent, send, getMode, last, view, handlers };
}

/** Lets every pending promise chain run (the controller awaits the adapter and send). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ok = (r: Partial<RewriteResponse & SynonymsResponse & FollowUpResponse>) => ({ status: 'ok' as const, ...r });

const TEXT = 'First line.\nI has a cat and a dog. We play.';
const SHORTER: ToolRequest = { kind: 'preset', presetId: 'shorter' };
const VARIANTS = ['a kitten', 'one cat', 'a small cat'];

let clipboard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clipboard = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

/** Opens on "a cat" in TEXT and waits for the menu. */
async function openOnCat(mode: Mode = 'standard', text = TEXT) {
  const t = setup(text, mode);
  t.tools.open(t.f, rangeOf(text, 'a cat'));
  await settle();
  return t;
}

/** Opens, picks Shorter and answers with VARIANTS. */
async function variantsShown() {
  const t = await openOnCat();
  t.handlers().pick(SHORTER);
  await settle();
  t.sent[0]!.reply.resolve(ok({ variants: VARIANTS }));
  await settle();
  return t;
}

describe('open', () => {
  it('shows the menu against the selection, and takes nothing from the page until a pick', async () => {
    const t = await openOnCat();
    expect(t.view()).toEqual({ phase: 'menu', mode: 'standard' });
    expect(t.last()!.anchor).toEqual(RECT);
    expect(t.adapter.rectsFor).toHaveBeenCalledWith(18, 23);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.tools.isOpen()).toBe(true);
    expect(t.tools.isOpen(t.f)).toBe(true);
    expect(t.tools.isOpen({ ...t.f } as Field)).toBe(false);
  });

  it('anchors on the box around every line of a selection that wraps', async () => {
    const t = setup(TEXT);
    t.adapter.rectsFor.mockResolvedValueOnce([new DOMRect(100, 20, 80, 16), new DOMRect(10, 36, 40, 16)]);
    t.tools.open(t.f, rangeOf(TEXT, 'a cat'));
    await settle();
    expect(t.last()!.anchor).toEqual(new DOMRect(10, 20, 170, 32));
  });

  it('a selection over the limit shows the notice and never sends', async () => {
    const t = setup(TEXT);
    t.tools.open(t.f, { ...rangeOf(TEXT, 'a cat'), tooLong: true });
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: 'Select up to about 2,000 characters.' });
    t.handlers().pick(SHORTER);
    t.handlers().retry();
    await settle();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('with a request, sends it at once (the menu is skipped)', async () => {
    const t = setup(TEXT);
    t.tools.open(t.f, rangeOf(TEXT, 'a cat'), { kind: 'preset', presetId: 'rewrite' });
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.data.request).toEqual({ kind: 'preset', presetId: 'rewrite' });
    expect(t.view()).toEqual({ phase: 'loading', label: 'Rewriting…' });
  });

  it("'custom-prompt' (the menu's Custom instruction…) shows the menu with the custom input focused, and sends nothing", async () => {
    const t = setup(TEXT);
    t.tools.open(t.f, rangeOf(TEXT, 'a cat'), 'custom-prompt');
    await settle();
    expect(t.view()).toEqual({ phase: 'menu', mode: 'standard', focus: 'custom' });
    expect(t.send).not.toHaveBeenCalled();
    t.handlers().pick({ kind: 'custom', instruction: 'make it vivid' }); // the menu works as usual
    await settle();
    expect(t.sent[0]!.data.request).toEqual({ kind: 'custom', instruction: 'make it vivid' });
  });
});

describe('menu view', () => {
  it('carries the page mode, so the menu lists only that mode\'s presets', async () => {
    const t = await openOnCat('essay');
    expect(t.view()).toEqual({ phase: 'menu', mode: 'essay' });
  });
});

describe('Expand on an Essay site', () => {
  const EXPAND: ToolRequest = { kind: 'preset', presetId: 'expand' };

  it('opened with Expand, it shows the notice and sends nothing', async () => {
    const t = setup(TEXT, 'essay');
    t.tools.open(t.f, rangeOf(TEXT, 'a cat'), EXPAND);
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: "Expand isn't offered for essays." });
    expect(t.send).not.toHaveBeenCalled();
  });

  it('picking Expand in an open Essay popover shows the notice and sends nothing', async () => {
    const t = await openOnCat('essay');
    t.handlers().pick(EXPAND);
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: "Expand isn't offered for essays." });
    expect(t.send).not.toHaveBeenCalled();
  });

  it('on a Standard site Expand is sent like any preset', async () => {
    const t = await openOnCat('standard');
    t.handlers().pick(EXPAND);
    await settle();
    expect(t.sent[0]!.data).toMatchObject({ mode: 'standard', request: EXPAND, stage: 'variants' });
  });
});

describe('rewrite', () => {
  it('Standard: a preset sends the variants stage with the context around the selection, then shows the variants', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.sent[0]!.type).toBe('rewrite');
    expect(t.sent[0]!.data).toEqual({
      host: 'example.com',
      mode: 'standard',
      request: SHORTER,
      text: 'a cat',
      before: 'I has ', // within the paragraph: not "First line."
      after: ' and a dog. We play.',
      stage: 'variants',
    });
    expect(t.view()).toEqual({ phase: 'loading', label: 'Rewriting…' });
    t.sent[0]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    expect(t.view()).toEqual({ phase: 'variants', variants: VARIANTS, original: 'a cat' });
  });

  it.each(['confident', 'friendlier', 'casual', 'simpler'] as const)('Essay: the %s tone preset sends the critique stage first', async (presetId) => {
    const t = await openOnCat('essay');
    const request: ToolRequest = { kind: 'preset', presetId };
    t.handlers().pick(request);
    await settle();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.sent[0]!.data).toMatchObject({ mode: 'essay', stage: 'critique', request });
    expect(t.view()).toEqual({ phase: 'loading', label: 'Reading it over…' });
  });

  it('Essay: the critique comes first; Show 3 rewrites sends the variants stage for the same request', async () => {
    const t = await openOnCat('essay');
    t.handlers().pick(SHORTER);
    await settle();
    expect(t.sent[0]!.data).toMatchObject({ mode: 'essay', stage: 'critique', request: SHORTER });
    expect(t.view()).toEqual({ phase: 'loading', label: 'Reading it over…' });
    t.sent[0]!.reply.resolve(ok({ critique: { weakness: 'It is vague.', lightFix: 'a tabby cat' } }));
    await settle();
    expect(t.view()).toEqual({ phase: 'critique', weakness: 'It is vague.', lightFix: 'a tabby cat', original: 'a cat' });

    t.handlers().showVariants();
    await settle();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.data).toEqual({ ...t.sent[0]!.data, stage: 'variants' });
    expect(t.view()).toEqual({ phase: 'loading', label: 'Rewriting…' });
    t.sent[1]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    expect(t.view()).toEqual({ phase: 'variants', variants: VARIANTS, original: 'a cat' });
  });

  it('a custom instruction is sent as the request; a blank one sends nothing', async () => {
    const t = await openOnCat();
    t.handlers().pick({ kind: 'custom', instruction: '   ' });
    await settle();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.view()).toEqual({ phase: 'menu', mode: 'standard' });
    t.handlers().pick({ kind: 'custom', instruction: 'make it vivid' });
    await settle();
    expect(t.sent[0]!.data.request).toEqual({ kind: 'custom', instruction: 'make it vivid' });
  });

  it('a field whose text changed before the pick sends nothing and says so', async () => {
    const t = await openOnCat();
    t.state.text = 'Oh ' + TEXT;
    t.handlers().pick(SHORTER);
    await settle();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.view()).toEqual({ phase: 'error', text: 'The text changed. Select it again.' });
  });
});

describe('synonyms', () => {
  it('sends the sentence around the target and its offset in it, then shows the options', async () => {
    const text = 'Intro.\n\nShe has a big dog. It barks.';
    const t = setup(text, 'essay'); // Essay: synonyms skip the critique
    t.tools.open(t.f, rangeOf(text, 'big'));
    await settle();
    t.handlers().pick({ kind: 'synonyms' });
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.type).toBe('synonyms');
    expect(t.sent[0]!.data).toEqual({
      host: 'example.com',
      mode: 'essay',
      target: 'big',
      sentence: 'She has a big dog.',
      targetStart: 10,
    });
    expect(t.view()).toEqual({ phase: 'loading', label: 'Finding words…' });
    const options = [
      { text: 'large', nuance: 'neutral' },
      { text: 'huge', nuance: 'stronger' },
    ];
    t.sent[0]!.reply.resolve(ok({ options }));
    await settle();
    expect(t.view()).toEqual({ phase: 'synonyms', options });
  });

  it('a long sentence is cut to the context limit: at most 300 characters each side of the target', async () => {
    // One 2,987-character sentence, the target in the middle (1,490 characters before it, 1,491 after).
    const text = `${'word '.repeat(298)}target${' word'.repeat(298)}.`;
    expect(text).toHaveLength(2987);
    const range = rangeOf(text, 'target');
    const t = setup(text);
    t.tools.open(t.f, range);
    await settle();
    t.handlers().pick({ kind: 'synonyms' });
    await settle();
    const { sentence, targetStart, target } = t.sent[0]!.data;
    expect(target).toBe('target');
    expect(sentence.slice(targetStart, targetStart + target.length)).toBe('target');
    expect(targetStart).toBeLessThanOrEqual(300);
    expect(sentence.length - targetStart - target.length).toBeLessThanOrEqual(300);
    expect(sentence.length).toBeLessThanOrEqual(target.length + 600);
    // The same window as the rewrite's context: cut at word boundaries, nothing but the sentence's own text.
    expect(text.slice(range.start - targetStart, range.start - targetStart + sentence.length)).toBe(sentence);
    expect(sentence.startsWith('word ')).toBe(true);
    expect(sentence.endsWith(' word')).toBe(true);
  });
});

describe('apply', () => {
  it('replaces the range once, closes, selects the new text and flashes it', async () => {
    const t = await variantsShown();
    t.handlers().apply('one cat');
    t.handlers().apply('one cat'); // a double click
    await settle();
    expect(t.adapter.replace).toHaveBeenCalledTimes(1);
    expect(t.adapter.replace).toHaveBeenCalledWith(18, 23, 'one cat');
    expect(t.state.text).toBe('First line.\nI has one cat and a dog. We play.');
    expect(t.view()).toBeNull();
    expect(t.tools.isOpen()).toBe(false);
    expect(t.adapter.select).toHaveBeenCalledWith(18, 25);
    expect(t.adapter.rectsFor).toHaveBeenLastCalledWith(18, 25);
    expect(t.overlay.flash).toHaveBeenCalledWith('f1', [RECT]);
  });

  it('the field text changed at the range: nothing is replaced, and the view says so', async () => {
    const t = await variantsShown();
    t.state.text = 'Oh ' + TEXT; // the user typed before the range
    t.handlers().apply('one cat');
    await settle();
    expect(t.adapter.replace).not.toHaveBeenCalled();
    expect(t.view()).toEqual({ phase: 'error', text: 'The text changed. Select it again.' });
    expect(t.overlay.flash).not.toHaveBeenCalled();
  });

  it('replace refused: the text goes to the clipboard and the view says so', async () => {
    const t = await variantsShown();
    t.state.replaceResult = false;
    t.handlers().apply('one cat');
    await settle();
    expect(clipboard).toHaveBeenCalledWith('one cat');
    expect(t.view()).toEqual({ phase: 'error', text: "Couldn't apply here — copied to clipboard." });
    expect(t.overlay.flash).not.toHaveBeenCalled();
  });

  it('while an apply is under way, nothing else is sent (Essay: the light fix, then Show 3 rewrites)', async () => {
    const t = await openOnCat('essay');
    t.handlers().pick(SHORTER);
    await settle();
    t.sent[0]!.reply.resolve(ok({ critique: { weakness: 'Vague.', lightFix: 'a tabby cat' } }));
    await settle();
    const replaced = deferred<boolean>();
    t.adapter.replace.mockImplementationOnce(() => replaced.promise);
    t.handlers().apply('a tabby cat');
    await settle();
    t.handlers().showVariants();
    t.handlers().retry();
    await settle();
    expect(t.sent).toHaveLength(1);
    replaced.resolve(true);
    await settle();
    expect(t.view()).toBeNull();
  });

  it('a popover opened on another selection during a slow apply stays open, and keeps its focus', async () => {
    const t = await variantsShown();
    const replaced = deferred<boolean>();
    t.adapter.replace.mockImplementationOnce(() => replaced.promise);
    t.handlers().apply('one cat');
    await settle();
    t.tools.open(t.f, rangeOf(TEXT, 'a dog'));
    await settle();
    replaced.resolve(true);
    await settle();
    expect(t.view()).toEqual({ phase: 'menu', mode: 'standard' });
    expect(t.tools.isOpen()).toBe(true);
    expect(t.adapter.select).not.toHaveBeenCalled();
  });

  it('replace refused and the clipboard too: the view says it could not apply', async () => {
    const t = await variantsShown();
    t.state.replaceResult = false;
    clipboard.mockRejectedValueOnce(new Error('denied'));
    t.handlers().apply('one cat');
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: "Couldn't apply here." });
  });
});

describe('follow-ups', () => {
  const SHOWN = 'Versions:\n1. a kitten\n2. one cat\n3. a small cat';

  /** After the variants, asks `question` and answers it with `answer`. */
  async function answered(t: Awaited<ReturnType<typeof variantsShown>>, question: string, answer: Partial<FollowUpResponse>) {
    const n = t.sent.length;
    void t.tools.ask(question);
    await settle();
    t.sent[n]!.reply.resolve(ok(answer));
    await settle();
  }

  it('after the variants, ask() shows loading, sends the selection, context, request, shown results and question, then the answer', async () => {
    const t = await variantsShown();
    void t.tools.ask('  make it shorter ');
    await settle();
    expect(t.view()).toEqual({ phase: 'loading', label: 'Thinking it over…' });
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.type).toBe('followUp');
    expect(t.sent[1]!.data).toEqual({
      host: 'example.com',
      mode: 'standard',
      request: SHORTER,
      text: 'a cat',
      before: 'I has ',
      after: ' and a dog. We play.',
      shown: SHOWN,
      history: [],
      question: 'make it shorter',
    });
    t.sent[1]!.reply.resolve(ok({ message: 'Shorter ones.', variants: ['cat', 'a pet'] }));
    await settle();
    expect(t.view()).toEqual({ phase: 'answer', message: 'Shorter ones.', variants: ['cat', 'a pet'], original: 'a cat' });
  });

  it('the popover handler asks too', async () => {
    const t = await variantsShown();
    t.handlers().ask('why?');
    await settle();
    expect(t.sent[1]!.type).toBe('followUp');
    expect(t.sent[1]!.data.question).toBe('why?');
  });

  it('a blank question sends nothing, and so does an ask before any result', async () => {
    const t = await openOnCat();
    void t.tools.ask('make it shorter'); // the menu: nothing to follow up yet
    await settle();
    expect(t.send).not.toHaveBeenCalled();
    t.handlers().pick(SHORTER);
    await settle();
    t.sent[0]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    void t.tools.ask('   ');
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.view()).toEqual({ phase: 'variants', variants: VARIANTS, original: 'a cat' });
  });

  it('a later follow-up sends the earlier questions and answers, oldest first, and the same shown results', async () => {
    const t = await variantsShown();
    await answered(t, 'make it shorter', { message: 'Shorter ones.', variants: ['cat', 'a pet'] });
    await answered(t, 'why the second?', { message: 'It is plainer.', variants: [] });
    void t.tools.ask('and now?');
    await settle();
    expect(t.sent[3]!.data.shown).toBe(SHOWN);
    expect(t.sent[3]!.data.history).toEqual([
      { q: 'make it shorter', a: 'Shorter ones.\nVersions:\n1. cat\n2. a pet' },
      { q: 'why the second?', a: 'It is plainer.' },
    ]);
    expect(t.sent[3]!.data.question).toBe('and now?');
  });

  it('after 6 answers the answer says no more can be asked, and a 7th ask sends nothing', async () => {
    const t = await variantsShown();
    for (let i = 1; i <= 5; i++) {
      await answered(t, `question ${i}`, { message: `answer ${i}`, variants: [] });
      expect(t.view(), `answer ${i}`).toEqual({ phase: 'answer', message: `answer ${i}`, variants: [], original: 'a cat' });
    }
    await answered(t, 'question 6', { message: 'answer 6', variants: ['one cat'] });
    expect(t.sent.at(-1)!.data.history).toHaveLength(5);
    expect(t.view()).toEqual({ phase: 'answer', message: 'answer 6', variants: ['one cat'], original: 'a cat', exhausted: true });
    const sends = t.sent.length;
    void t.tools.ask('question 7');
    await settle();
    expect(t.sent).toHaveLength(sends);
    expect(t.view()).toEqual({ phase: 'answer', message: 'answer 6', variants: ['one cat'], original: 'a cat', exhausted: true });
  });

  it('the box after the limit reads "Start a new request for more."', () => {
    expect(TOOLS_COPY.noMoreFollowUps).toBe('Start a new request for more.');
  });

  it('Apply on an answer variant goes through the verified apply path: replaces once, closes, selects and flashes', async () => {
    const t = await variantsShown();
    await answered(t, 'less formal', { message: 'Try these.', variants: ['one cat'] });
    t.handlers().apply('one cat');
    t.handlers().apply('one cat');
    await settle();
    expect(t.adapter.replace).toHaveBeenCalledTimes(1);
    expect(t.adapter.replace).toHaveBeenCalledWith(18, 23, 'one cat');
    expect(t.state.text).toBe('First line.\nI has one cat and a dog. We play.');
    expect(t.view()).toBeNull();
    expect(t.adapter.select).toHaveBeenCalledWith(18, 25);
    expect(t.overlay.flash).toHaveBeenCalledWith('f1', [RECT]);
  });

  it('Apply on an answer variant after the text changed replaces nothing and says so', async () => {
    const t = await variantsShown();
    await answered(t, 'less formal', { message: 'Try these.', variants: ['one cat'] });
    t.state.text = 'Oh ' + TEXT;
    t.handlers().apply('one cat');
    await settle();
    expect(t.adapter.replace).not.toHaveBeenCalled();
    expect(t.view()).toEqual({ phase: 'error', text: 'The text changed. Select it again.' });
  });

  it('a follow-up after the text changed sends nothing and says so', async () => {
    const t = await variantsShown();
    t.state.text = 'Oh ' + TEXT;
    void t.tools.ask('less formal');
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.view()).toEqual({ phase: 'error', text: 'The text changed. Select it again.' });
  });

  it('a failed follow-up offers Retry, which asks the same question again with the same history', async () => {
    const t = await variantsShown();
    await answered(t, 'make it shorter', { message: 'Shorter ones.', variants: [] });
    void t.tools.ask('and friendlier?');
    await settle();
    t.sent[2]!.reply.resolve({ status: 'overloaded' });
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: 'Claude is busy right now. Try again in a moment.', retry: true });
    t.handlers().retry();
    await settle();
    expect(t.sent).toHaveLength(4);
    expect(t.sent[3]!.type).toBe('followUp');
    expect(t.sent[3]!.data).toEqual(t.sent[2]!.data);
    expect(t.sent[3]!.data.history).toHaveLength(1);
  });

  it('an ok answer without a message is an unexpected answer', async () => {
    const t = await variantsShown();
    void t.tools.ask('less formal');
    await settle();
    t.sent[1]!.reply.resolve({ status: 'ok' });
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: "Couldn't get a usable answer from Claude. Try again.", retry: true });
  });

  it('Essay: after the critique, a follow-up sends the critique as the shown results', async () => {
    const t = await openOnCat('essay');
    t.handlers().pick(SHORTER);
    await settle();
    t.sent[0]!.reply.resolve(ok({ critique: { weakness: 'It is vague.', lightFix: 'a tabby cat' } }));
    await settle();
    void t.tools.ask('rewrite it');
    await settle();
    expect(t.sent[1]!.data).toMatchObject({ mode: 'essay', request: SHORTER, shown: 'Weakness: It is vague.\nLight-touch version: a tabby cat' });
  });

  it('Essay: after the critique and then the versions, a follow-up sends both as the shown results', async () => {
    const u = await openOnCat('essay');
    u.handlers().pick(SHORTER);
    await settle();
    u.sent[0]!.reply.resolve(ok({ critique: { weakness: 'It is vague.', lightFix: 'a tabby cat' } }));
    await settle();
    u.handlers().showVariants();
    await settle();
    u.sent[1]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    void u.tools.ask('rewrite it');
    await settle();
    expect(u.sent[2]!.data.shown).toBe(`Weakness: It is vague.\nLight-touch version: a tabby cat\n\n${SHOWN}`);
  });

  it('after synonyms, a follow-up names the synonyms request and sends the options as shown', async () => {
    const t = await openOnCat();
    t.handlers().pick({ kind: 'synonyms' });
    await settle();
    t.sent[0]!.reply.resolve(ok({ options: [{ text: 'kitten', nuance: 'young' }, { text: 'feline', nuance: 'formal' }] }));
    await settle();
    void t.tools.ask('which is warmer?');
    await settle();
    expect(t.sent[1]!.data).toMatchObject({ request: { kind: 'synonyms' }, shown: 'Options:\n- kitten (young)\n- feline (formal)', question: 'which is warmer?' });
  });

  it('shown results and earlier answers over 10,000 characters are cut to fit', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    const long = ['x'.repeat(4000), 'y'.repeat(4000), 'z'.repeat(4000)];
    t.sent[0]!.reply.resolve(ok({ variants: long }));
    await settle();
    void t.tools.ask('first');
    await settle();
    expect(t.sent[1]!.data.shown).toHaveLength(10_000);
    expect(t.sent[1]!.data.shown.endsWith('…')).toBe(true);
    t.sent[1]!.reply.resolve(ok({ message: 'm'.repeat(12_000), variants: [] }));
    await settle();
    void t.tools.ask('second');
    await settle();
    expect(t.sent[2]!.data.history[0].a).toHaveLength(10_000);
  });

  it('an answer that arrives after close() is ignored', async () => {
    const t = await variantsShown();
    void t.tools.ask('less formal');
    await settle();
    t.tools.close();
    const calls = t.shows.length;
    t.sent[1]!.reply.resolve(ok({ message: 'Late.', variants: [] }));
    await settle();
    expect(t.shows).toHaveLength(calls);
    expect(t.view()).toBeNull();
  });
});

describe('late answers', () => {
  it('an answer after close() is ignored', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    t.tools.close();
    const calls = t.shows.length;
    t.sent[0]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    expect(t.shows).toHaveLength(calls);
    expect(t.view()).toBeNull();
    expect(t.adapter.replace).not.toHaveBeenCalled();
  });

  it('an answer to an older pick is ignored once a newer one started', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    t.handlers().pick({ kind: 'preset', presetId: 'clearer' });
    await settle();
    t.sent[1]!.reply.resolve(ok({ variants: ['b1', 'b2', 'b3'] }));
    await settle();
    const calls = t.shows.length;
    t.sent[0]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    expect(t.shows).toHaveLength(calls);
    expect(t.view()).toEqual({ phase: 'variants', variants: ['b1', 'b2', 'b3'], original: 'a cat' });
  });

  it('an answer for a popover that was opened again on another selection is ignored', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    t.tools.open(t.f, rangeOf(TEXT, 'a dog'));
    await settle();
    t.sent[0]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    expect(t.view()).toEqual({ phase: 'menu', mode: 'standard' });
  });
});

describe('errors', () => {
  it('a non-ok status shows its status text, and Retry sends the same request again', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    t.sent[0]!.reply.resolve({ status: 'rate_limited' });
    await settle();
    // The tools' own copy: nothing retries by itself here, the Retry button does.
    expect(t.view()).toEqual({ phase: 'error', text: 'Claude is busy right now. Try again in a moment.', retry: true });
    t.handlers().retry();
    await settle();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.type).toBe('rewrite');
    expect(t.sent[1]!.data).toEqual(t.sent[0]!.data);
    t.sent[1]!.reply.resolve(ok({ variants: VARIANTS }));
    await settle();
    expect(t.view()).toEqual({ phase: 'variants', variants: VARIANTS, original: 'a cat' });
  });

  it('Retry after a failed synonyms request asks for synonyms again', async () => {
    const t = await openOnCat();
    t.handlers().pick({ kind: 'synonyms' });
    await settle();
    t.sent[0]!.reply.resolve({ status: 'overloaded' });
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: 'Claude is busy right now. Try again in a moment.', retry: true });
    t.handlers().retry();
    await settle();
    expect(t.sent[1]!.type).toBe('synonyms');
    expect(t.sent[1]!.data).toEqual(t.sent[0]!.data);
  });

  it('a message that never reaches the background reads as offline', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    t.sent[0]!.reply.reject(new Error('Could not establish connection'));
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: "Can't reach Claude. Check your connection.", retry: true });
  });

  it('an ok answer without its payload is an unexpected answer', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    t.sent[0]!.reply.resolve({ status: 'ok' });
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: "Couldn't get a usable answer from Claude. Try again.", retry: true });
  });

  it('a bad response has the tools copy and Retry', async () => {
    const t = await openOnCat();
    t.handlers().pick(SHORTER);
    await settle();
    t.sent[0]!.reply.resolve({ status: 'bad_response' });
    await settle();
    expect(t.view()).toEqual({ phase: 'error', text: "Couldn't get a usable answer from Claude. Try again.", retry: true });
  });

  it('the monthly cap and key problems have no Retry: they are fixed outside the popover', async () => {
    const cases: [string, string][] = [
      ['paused_cap', 'Monthly limit reached. Rewrites, synonyms, chat and reviews are paused until next month or until you raise the limit in settings.'],
      ['key_missing', 'Add your Claude API key to start checking.'],
      ['key_invalid', 'Your API key was rejected. Check it in settings.'],
    ];
    for (const [status, text] of cases) {
      const t = await openOnCat();
      t.handlers().pick(SHORTER);
      await settle();
      t.sent[0]!.reply.resolve({ status });
      await settle();
      expect(t.view(), status).toEqual({ phase: 'error', text });
      t.handlers().retry(); // nothing to retry: no button, and no request either
      await settle();
      expect(t.sent, status).toHaveLength(1);
    }
  });
});

describe('closing', () => {
  it('a scroll that moves the field closes it; other layout changes and other scrollers do not', async () => {
    const t = await openOnCat();
    t.fireLayout(); // a resize
    t.fireLayout(document.createElement('div')); // a scroller elsewhere
    expect(t.tools.isOpen()).toBe(true);
    t.fireLayout(document); // the page
    expect(t.tools.isOpen()).toBe(false);
    expect(t.view()).toBeNull();
    expect(t.layout.size).toBe(0); // stopped listening
  });

  it('a scroll of the field itself closes it', async () => {
    const t = await openOnCat();
    expect(t.tools.isOpen()).toBe(true);
    t.fireLayout(t.element);
    expect(t.tools.isOpen()).toBe(false);
    expect(t.view()).toBeNull();
    expect(t.adapter.select).not.toHaveBeenCalled(); // the user is scrolling: no jump back to the selection
  });

  it('the close handler (Esc) returns focus and the selection to the field; a click outside does not', async () => {
    const t = await openOnCat();
    t.handlers().close();
    await settle();
    expect(t.view()).toBeNull();
    expect(t.adapter.select).toHaveBeenCalledWith(18, 23);

    t.tools.open(t.f, rangeOf(TEXT, 'a cat'));
    await settle();
    t.handlers().close(false);
    await settle();
    expect(t.view()).toBeNull();
    expect(t.adapter.select).toHaveBeenCalledTimes(1);
  });

  it('close() from outside the popover leaves focus alone', async () => {
    const t = await openOnCat();
    expect(t.view()).toEqual({ phase: 'menu', mode: 'standard' });
    t.tools.close();
    await settle();
    expect(t.view()).toBeNull();
    expect(t.adapter.select).not.toHaveBeenCalled();
  });
});

describe('Sound like me', () => {
  const VOICE: ToolRequest = { kind: 'preset', presetId: 'voice' };
  const PARA = 'The trip was not just a trip; it was a journey.';
  const VOICE_TEXT = `We left at dawn.\n${PARA}\nNobody talked much.`;
  const SAMPLE = 'We left at dawn.\n\nNobody talked much.';

  async function openOn(part: string, mode: Mode = 'standard', text = VOICE_TEXT) {
    const t = setup(text, mode);
    t.tools.open(t.f, rangeOf(text, part));
    await settle();
    return t;
  }
  /** Picks Sound like me (Standard) and answers with `tells` and `final`. */
  async function voiceShown(final = 'The trip mattered to us.', tells = ['a staged contrast']) {
    const t = await openOn(PARA);
    t.handlers().pick(VOICE);
    await settle();
    t.sent[0]!.reply.resolve(ok({ variants: [final], tells }));
    await settle();
    return t;
  }

  it('sends the variants stage with the field\'s other paragraphs as the voice sample, then shows the tells and the one version', async () => {
    const t = await openOn(PARA);
    t.handlers().pick(VOICE);
    await settle();
    expect(t.sent[0]!.data).toEqual({
      host: 'example.com',
      mode: 'standard',
      request: VOICE,
      text: PARA,
      before: '',
      after: '',
      stage: 'variants',
      voiceSample: SAMPLE,
    });
    expect(t.view()).toEqual({ phase: 'loading', label: 'Rewriting…' });
    t.sent[0]!.reply.resolve(ok({ variants: ['The trip mattered to us.'], tells: ['a staged contrast'] }));
    await settle();
    expect(t.view()).toEqual({ phase: 'voice', tells: ['a staged contrast'], final: 'The trip mattered to us.', original: PARA, canApply: true });
  });

  it('the voice sample never holds the selection or the rest of its paragraph', async () => {
    const t = await openOn('not just a trip');
    t.handlers().pick(VOICE);
    await settle();
    expect(t.sent[0]!.data.voiceSample).toBe(SAMPLE);
    expect(t.sent[0]!.data.before).toBe('The trip was ');
  });

  it('Essay: the critique comes first, without the voice sample; the version after it carries the sample', async () => {
    const t = await openOn(PARA, 'essay');
    t.handlers().pick(VOICE);
    await settle();
    expect(t.sent[0]!.data).toMatchObject({ mode: 'essay', stage: 'critique', request: VOICE });
    expect(t.sent[0]!.data).not.toHaveProperty('voiceSample');
    t.sent[0]!.reply.resolve(ok({ critique: { weakness: 'It sounds staged.', lightFix: 'The trip was a journey.' } }));
    await settle();
    expect(t.view()).toEqual({
      phase: 'critique',
      weakness: 'It sounds staged.',
      lightFix: 'The trip was a journey.',
      original: PARA,
      voice: true,
      canApply: true,
    });
    t.handlers().showVariants();
    await settle();
    expect(t.sent[1]!.data).toEqual({ ...t.sent[0]!.data, stage: 'variants', voiceSample: SAMPLE });
    t.sent[1]!.reply.resolve(ok({ variants: ['The trip mattered to us.'], tells: [] }));
    await settle();
    expect(t.view()).toEqual({ phase: 'voice', tells: [], final: 'The trip mattered to us.', original: PARA, canApply: true });
  });

  it('a field with no other paragraph sends no voice sample, and other requests never send one', async () => {
    const alone = await openOn(PARA, 'standard', PARA);
    alone.handlers().pick(VOICE);
    await settle();
    expect(alone.sent[0]!.data).not.toHaveProperty('voiceSample');
    const other = await openOn(PARA);
    other.handlers().pick(SHORTER);
    await settle();
    expect(other.sent[0]!.data).not.toHaveProperty('voiceSample');
  });

  it('a version that changes a number cannot be applied: the view says so, and an apply replaces nothing', async () => {
    const t = await voiceShown('The trip took 3 days.');
    expect(t.view()).toEqual({ phase: 'voice', tells: ['a staged contrast'], final: 'The trip took 3 days.', original: PARA, canApply: false });
    t.handlers().apply('The trip took 3 days.');
    await settle();
    expect(t.adapter.replace).not.toHaveBeenCalled();
    expect(t.view()).toMatchObject({ phase: 'voice', canApply: false });
  });

  it('a version with the claims unchanged applies through the verified path', async () => {
    const t = await voiceShown();
    t.handlers().apply('The trip mattered to us.');
    await settle();
    expect(t.adapter.replace).toHaveBeenCalledWith(17, 17 + PARA.length, 'The trip mattered to us.');
    expect(t.view()).toBeNull();
    expect(t.overlay.flash).toHaveBeenCalled();
  });

  it('Copy puts the version on the clipboard and says whether it worked', async () => {
    const t = await voiceShown('The trip took 3 days.');
    await expect(t.handlers().copy('The trip took 3 days.')).resolves.toBe(true);
    expect(clipboard).toHaveBeenCalledWith('The trip took 3 days.');
    clipboard.mockRejectedValueOnce(new Error('denied'));
    await expect(t.handlers().copy('The trip took 3 days.')).resolves.toBe(false);
    expect(t.adapter.replace).not.toHaveBeenCalled();
  });

  it('a follow-up after it names Sound like me and sends the tells and the version as the shown results', async () => {
    const t = await voiceShown();
    void t.tools.ask('warmer');
    await settle();
    expect(t.sent[1]!.type).toBe('followUp');
    expect(t.sent[1]!.data).toMatchObject({
      request: VOICE,
      shown: 'Generic patterns found: a staged contrast\nVersion: The trip mattered to us.',
      question: 'warmer',
    });
    const none = await voiceShown('The trip mattered to us.', []);
    void none.tools.ask('why?');
    await settle();
    expect(none.sent[1]!.data.shown).toBe('No generic patterns found.\nVersion: The trip mattered to us.');
  });

  it('Essay: a light fix that changes a number cannot be applied: the critique says so, and an apply replaces nothing', async () => {
    const t = await openOn(PARA, 'essay');
    t.handlers().pick(VOICE);
    await settle();
    t.sent[0]!.reply.resolve(ok({ critique: { weakness: 'It sounds staged.', lightFix: 'The trip took 3 days.' } }));
    await settle();
    expect(t.view()).toMatchObject({ phase: 'critique', voice: true, canApply: false });
    t.handlers().apply('The trip took 3 days.');
    await settle();
    expect(t.adapter.replace).not.toHaveBeenCalled();
  });

  it('the selection back with no tells: it already sounds like the writer, with nothing to apply', async () => {
    const t = await voiceShown(PARA, []);
    expect(t.view()).toEqual({ phase: 'voice', tells: [], final: PARA, original: PARA, canApply: false, unchanged: true });
    t.handlers().apply(PARA);
    await settle();
    expect(t.adapter.replace).not.toHaveBeenCalled();
    void t.tools.ask('warmer');
    await settle();
    expect(t.sent[1]!.data.shown).toBe('No generic patterns found. This already sounds like you.');
  });

  it('a follow-up after it keeps the gate: a version that changes a claim cannot be applied, one that keeps them can', async () => {
    const t = await voiceShown('The trip took 3 days.');
    void t.tools.ask('shorter');
    await settle();
    t.sent[1]!.reply.resolve(ok({ message: 'Shorter now.', variants: ['It took 3 days.', 'The trip mattered.'] }));
    await settle();
    expect(t.view()).toEqual({
      phase: 'answer',
      message: 'Shorter now.',
      variants: ['It took 3 days.', 'The trip mattered.'],
      original: PARA,
      canApply: [false, true],
    });
    t.handlers().apply('It took 3 days.');
    await settle();
    expect(t.adapter.replace).not.toHaveBeenCalled();
    t.handlers().apply('The trip mattered.');
    await settle();
    expect(t.adapter.replace).toHaveBeenCalledWith(17, 17 + PARA.length, 'The trip mattered.');
  });

  it('Essay: a follow-up after the critique keeps the gate too', async () => {
    const t = await openOn(PARA, 'essay');
    t.handlers().pick(VOICE);
    await settle();
    t.sent[0]!.reply.resolve(ok({ critique: { weakness: 'It sounds staged.', lightFix: 'The trip was a journey.' } }));
    await settle();
    void t.tools.ask('rewrite it');
    await settle();
    t.sent[1]!.reply.resolve(ok({ message: 'One light fix:', variants: ['The trip took 3 days.'] }));
    await settle();
    expect(t.view()).toMatchObject({ phase: 'answer', canApply: [false] });
    t.handlers().apply('The trip took 3 days.');
    await settle();
    expect(t.adapter.replace).not.toHaveBeenCalled();
  });

  it('a failed request offers Retry, which sends it again with the voice sample', async () => {
    const t = await openOn(PARA);
    t.handlers().pick(VOICE);
    await settle();
    t.sent[0]!.reply.resolve({ status: 'overloaded' });
    await settle();
    t.handlers().retry();
    await settle();
    expect(t.sent[1]!.data).toEqual(t.sent[0]!.data);
  });

  describe('sentence openers and versions equal to the selection', () => {
    const OPENER = 'We packed early. Moreover, we were tired.';
    const OPENER_TEXT = `We left at dawn.\n${OPENER}\nNobody talked much.`;
    const DROPPED = 'We packed early, and we were tired.';

    it('a version that drops an opener at a later sentence start can be applied', async () => {
      const t = await openOn(OPENER, 'standard', OPENER_TEXT);
      t.handlers().pick(VOICE);
      await settle();
      t.sent[0]!.reply.resolve(ok({ variants: [DROPPED], tells: ['a stock transition'] }));
      await settle();
      expect(t.view()).toMatchObject({ phase: 'voice', final: DROPPED, canApply: true });
      t.handlers().apply(DROPPED);
      await settle();
      expect(t.adapter.replace).toHaveBeenCalledWith(17, 17 + OPENER.length, DROPPED);
    });

    it('a name after a title still counts: swapping it cannot be applied', async () => {
      const text = 'We left at dawn.\nI asked Dr. Okafor. Then we left.\nNobody talked much.';
      const t = await openOn('I asked Dr. Okafor. Then we left.', 'standard', text);
      t.handlers().pick(VOICE);
      await settle();
      t.sent[0]!.reply.resolve(ok({ variants: ['I asked Dr. Adeyemi, and we left.'], tells: ['a flat ending'] }));
      await settle();
      expect(t.view()).toMatchObject({ phase: 'voice', canApply: false });
      t.handlers().apply('I asked Dr. Adeyemi, and we left.');
      await settle();
      expect(t.adapter.replace).not.toHaveBeenCalled();
    });

    it('Essay: a light fix that drops an opener can be applied; one equal to the selection cannot', async () => {
      const t = await openOn(OPENER, 'essay', OPENER_TEXT);
      t.handlers().pick(VOICE);
      await settle();
      t.sent[0]!.reply.resolve(ok({ critique: { weakness: 'A stock transition.', lightFix: DROPPED } }));
      await settle();
      expect(t.view()).toMatchObject({ phase: 'critique', voice: true, canApply: true });
      const same = await openOn(OPENER, 'essay', OPENER_TEXT);
      same.handlers().pick(VOICE);
      await settle();
      same.sent[0]!.reply.resolve(ok({ critique: { weakness: 'A stock transition.', lightFix: ` ${OPENER} ` } }));
      await settle();
      expect(same.view()).toMatchObject({ phase: 'critique', voice: true, canApply: false });
    });

    it('a follow-up version that drops an opener can be applied; one equal to the selection cannot', async () => {
      const t = await openOn(OPENER, 'standard', OPENER_TEXT);
      t.handlers().pick(VOICE);
      await settle();
      t.sent[0]!.reply.resolve(ok({ variants: [DROPPED], tells: ['a stock transition'] }));
      await settle();
      void t.tools.ask('try again');
      await settle();
      t.sent[1]!.reply.resolve(ok({ message: 'Two takes:', variants: [DROPPED, OPENER] }));
      await settle();
      expect(t.view()).toMatchObject({ phase: 'answer', variants: [DROPPED, OPENER], canApply: [true, false] });
      t.handlers().apply(OPENER);
      await settle();
      expect(t.adapter.replace).not.toHaveBeenCalled();
    });
  });
});
