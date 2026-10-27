import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { EditorAdapter } from '../../src/content/adapters/types';
import { createFieldHost, type PageSettings } from '../../src/content/field-host';
import type { BadgeState, CardSecondary, LayerTarget, OverlayItem, RenderResult } from '../../src/content/overlay/mount';
import type { ToolsView } from '../../src/content/tools/tools-controller';
import { kindInfo } from '../../src/core/kinds';
import { defaultFamilies } from '../../src/core/modes';
import type { CheckStatus, LocatedIssue, Mode } from '../../src/core/types';
import { onMessage, sendMessage } from '../../src/shared/messages';
import { declinedItem, dictionaryItem, dismissCountsItem, rulesItem } from '../../src/shared/settings';

// FieldHost against a fake overlay (it records every render and answers with queued results), a fake
// session (the test sets its issues) and a ResizeObserver the test fires. Frames and timers are fake.

const shared = vi.hoisted(() => ({
  mounts: 0,
  rewrite: null as ((fieldId: string, issueId: string) => void) | null,
  renders: [] as { fieldId: string; items: OverlayItem[]; where?: LayerTarget }[],
  results: [] as RenderResult[],
  /** Every showSelectionButton anchor (null: hidden) and every showTools view (null: closed), in order. */
  buttons: [] as (DOMRect | null)[],
  tools: [] as (ToolsView | null)[],
  /** Every showNotice text (null: hidden), in order. */
  notices: [] as (string | null)[],
  /** Every flash: the field and the rects it covered. */
  flashes: [] as { fieldId: string; rects: DOMRect[] }[],
  /** The card's action provider FieldHost handed the overlay, and every undo chip shown. */
  cardActions: null as ((fieldId: string, issue: LocatedIssue) => CardSecondary | null) | null,
  undos: [] as { fieldId: string; anchor: DOMRect; text: string; onUndo: () => void; side?: 'below' | 'above' }[],
  undoCloses: 0,
  /** The overlay's Dismiss handler FieldHost gave, and every offer chip shown. */
  dismiss: null as ((fieldId: string, issueId: string, at: DOMRect, side: 'below' | 'above') => void) | null,
  offers: [] as { fieldId: string; anchor: DOMRect; question: string; yes: string; onYes: () => void; onNo: () => void; side?: 'below' | 'above' }[],
  /** Every setBadge call (state null: cleared), in order, and the badge click handler FieldHost gave. */
  badges: [] as { fieldId: string; state: BadgeState | null }[],
  badgeClick: null as ((fieldId: string) => void) | null,
  sessions: [] as {
    list: LocatedIssue[];
    statusNow: CheckStatus;
    busyNow: boolean;
    checkedNow: boolean;
    refilter: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    opts: {
      onUpdate(issues: LocatedIssue[], status: CheckStatus): void;
      onBusyChange?(busy: boolean): void;
      sendHarper?(req: unknown): Promise<unknown>;
      localChecks?(): boolean;
    };
  }[],
}));

vi.mock('../../src/content/overlay/mount', () => ({
  mountOverlay: async () => {
    shared.mounts++;
    return {
      showSelectionButton(anchor: DOMRect | null) {
        shared.buttons.push(anchor);
      },
      showTools(_anchor: DOMRect | null, view: ToolsView | null) {
        shared.tools.push(view);
      },
      flash(fieldId: string, rects: DOMRect[]) {
        shared.flashes.push({ fieldId, rects });
      },
      render(fieldId: string, items: OverlayItem[], where?: LayerTarget) {
        shared.renders.push({ fieldId, items, where });
        return shared.results.shift() ?? 'drawn';
      },
      clear() {},
      drifted: () => false,
      onLayerLost() {},
      onAccept() {},
      onRewrite(cb: (fieldId: string, issueId: string) => void) {
        shared.rewrite = cb;
      },
      onDismiss(cb: (fieldId: string, issueId: string, at: DOMRect, side: 'below' | 'above') => void) {
        shared.dismiss = cb;
      },
      cardActions(cb: (fieldId: string, issue: LocatedIssue) => CardSecondary | null) {
        shared.cardActions = cb;
      },
      showUndo(fieldId: string, anchor: DOMRect, text: string, onUndo: () => void, side?: 'below' | 'above') {
        shared.undos.push({ fieldId, anchor, text, onUndo, side });
      },
      showOffer(fieldId: string, anchor: DOMRect, question: string, yes: string, onYes: () => void, onNo: () => void, side?: 'below' | 'above') {
        shared.offers.push({ fieldId, anchor, question, yes, onYes, onNo, side });
      },
      closeUndo() {
        shared.undoCloses++;
      },
      showNotice(text: string | null) {
        shared.notices.push(text);
      },
      open() {},
      close() {},
      armFlash: () => () => {},
      setBadge(fieldId: string, state: BadgeState | null) {
        shared.badges.push({ fieldId, state });
      },
      onBadgeClick(cb: (fieldId: string) => void) {
        shared.badgeClick = cb;
      },
    };
  },
}));

vi.mock('../../src/content/session', () => ({
  FieldSession: class {
    list: LocatedIssue[] = [];
    statusNow: CheckStatus = 'ok';
    busyNow = false;
    checkedNow = true;
    refilter = vi.fn();
    constructor(
      _adapter: unknown,
      public opts: {
        onUpdate(issues: LocatedIssue[], status: CheckStatus): void;
        onBusyChange?(busy: boolean): void;
        sendHarper?(req: unknown): Promise<unknown>;
        localChecks?(): boolean;
      },
    ) {
      shared.sessions.push(this);
    }
    dismiss = vi.fn(async () => {});
    start() {}
    issues() {
      return this.list;
    }
    status(): CheckStatus {
      return this.statusNow;
    }
    busy() {
      return this.busyNow;
    }
    checked() {
      return this.checkedNow;
    }
    dispose() {}
  },
}));

vi.mock('../../src/shared/messages', () => ({
  sendMessage: vi.fn(async () => undefined),
  onMessage: vi.fn(() => () => {}),
}));

class FakeResizeObserver {
  static all = new Set<FakeResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly cb: () => void) {
    FakeResizeObserver.all.add(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  /** The browser reports a size change of `el` to every observer watching it. */
  static resize(el: Element) {
    for (const o of FakeResizeObserver.all) if (o.targets.has(el)) o.cb();
  }
  static observing(el: Element) {
    return [...FakeResizeObserver.all].some((o) => o.targets.has(el));
  }
}

/** Every listener a test's FieldHost added: removed after each test, so a later test's events reach only its own. */
const listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];
const ctx = {
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  onInvalidated: () => {},
  addEventListener: (target: EventTarget, type: string, cb: EventListener, opts?: AddEventListenerOptions) => {
    listeners.push([target, type, cb, opts]);
    target.addEventListener(type, cb, opts);
  },
} as unknown as ContentScriptContext;

/**
 * The page settings: Standard (a test may change `pageMode`), default families; watchPolicy keeps its listeners.
 * The badge is off unless a test turns it on (`badgeOn`, then the watchBadge listeners).
 */
let pageMode: Mode = 'standard';
let badgeOn = false;
let localOn = true;
const policyListeners: (() => void)[] = [];
const badgeListeners: (() => void)[] = [];
const settings: PageSettings = {
  mode: () => pageMode,
  policy: (mode) => ({ mode, families: defaultFamilies(mode), rules: new Set(), dictionary: new Set() }),
  watchPolicy: (cb) => void policyListeners.push(cb),
  watchEnabled: () => true,
  showBadge: () => badgeOn,
  watchBadge: (cb) => void badgeListeners.push(cb),
  localChecks: () => localOn,
};

const issue = (id: string): LocatedIssue =>
  ({ id, start: 2, end: 5, original: 'has', replacement: 'have', severity: 'error' }) as unknown as LocatedIssue;

function fakeAdapter(el: Element): EditorAdapter {
  return {
    fieldId: 'x',
    element: el,
    getText: async () => 'I has a cat.',
    rectsFor: async () => [new DOMRect(10, 10, 30, 20)],
    rectsForMany: async (ranges) => ranges.map(() => [new DOMRect(10, 10, 30, 20)]),
    replace: async () => true,
    select: async () => {},
    onChange: () => () => {},
    onLayoutChange: () => () => {},
    isAlive: () => true,
    dispose() {},
  };
}

/** A textarea field on a plain page (the document is its layer's anchor), its host and its session. */
function field() {
  const el = document.createElement('textarea');
  document.body.append(el);
  const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
  const f = host.attach(el, () => fakeAdapter(el));
  const session = shared.sessions.at(-1)!;
  const setIssues = (list: LocatedIssue[]) => {
    session.list = list;
    session.opts.onUpdate(list, 'ok');
  };
  return { host, f, setIssues };
}

const frame = () => vi.advanceTimersByTimeAsync(20);
const html = () => document.documentElement;
const anchors = () => shared.renders.map((r) => r.where?.anchor ?? null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  shared.mounts = 0;
  shared.renders.length = 0;
  shared.results.length = 0;
  shared.sessions.length = 0;
  shared.buttons.length = 0;
  shared.tools.length = 0;
  shared.notices.length = 0;
  shared.flashes.length = 0;
  shared.cardActions = null;
  shared.undos.length = 0;
  shared.offers.length = 0;
  shared.dismiss = null;
  shared.undoCloses = 0;
  shared.badges.length = 0;
  shared.badgeClick = null;
  policyListeners.length = 0;
  badgeListeners.length = 0;
  badgeOn = false;
  localOn = true;
  pageMode = 'standard';
  fakeBrowser.reset();
  vi.mocked(sendMessage).mockClear();
  FakeResizeObserver.all.clear();
});

afterEach(() => {
  for (const [target, type, cb, opts] of listeners.splice(0)) target.removeEventListener(type, cb, opts);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe("a field's session and the local Harper checker", () => {
  it('asks Harper through the background (harperCheck) and follows the page’s "Instant local checks" switch', async () => {
    field();
    const { opts } = shared.sessions.at(-1)!;
    const req = { host: 'example.com', mode: 'standard', paragraphs: [{ hash: 'h', text: 'I ate a apple.' }] };
    await opts.sendHarper!(req);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('harperCheck', req);
    expect(opts.localChecks!()).toBe(true);
    localOn = false;
    expect(opts.localChecks!()).toBe(false);
  });
});

describe("the anchor's resize observer is on only while the field has something drawn", () => {
  it('a page whose height keeps changing makes no renders while the field has no issues', async () => {
    const { setIssues } = field();
    setIssues([issue('a')]);
    await frame();
    expect(shared.renders).toHaveLength(1);
    expect(FakeResizeObserver.observing(html())).toBe(true); // attached on the first non-empty render
    FakeResizeObserver.resize(html()); // control: with an issue drawn, the page growing re-renders it
    await frame();
    expect(shared.renders).toHaveLength(2);

    setIssues([]); // fixed: nothing drawn
    await frame();
    expect(shared.renders).toHaveLength(3);
    expect(FakeResizeObserver.observing(html())).toBe(false);
    for (let i = 0; i < 5; i++) {
      FakeResizeObserver.resize(html()); // a feed or a streaming reply keeps growing the page
      await frame();
    }
    expect(shared.renders).toHaveLength(3);

    setIssues([issue('b')]); // an issue again: observed again
    await frame();
    expect(FakeResizeObserver.observing(html())).toBe(true);
  });

  it('a field that never had issues is never observed, even once the overlay is up for another field', async () => {
    const other = field();
    other.setIssues([issue('a')]); // mounts the overlay
    await frame();
    const quiet = field();
    quiet.setIssues([]);
    await frame();
    other.setIssues([]);
    await frame();
    const before = shared.renders.length;
    expect(FakeResizeObserver.observing(html())).toBe(false);
    FakeResizeObserver.resize(html());
    await frame();
    expect(shared.renders).toHaveLength(before);
  });
});

describe('the removal guard is not for good', () => {
  it("'unstable' (the page kept removing the layer): the fixed layer for 30 s, then the field's own layer again", async () => {
    const { setIssues } = field();
    shared.results.push('unstable');
    setIssues([issue('a')]);
    await frame();
    await frame();
    expect(anchors()).toEqual([html(), null]); // given up for the fixed layer at once
    setIssues([issue('a'), issue('b')]); // renders meanwhile stay in the fixed layer
    await frame();
    expect(anchors()).toEqual([html(), null, null]);

    await vi.advanceTimersByTimeAsync(29_900);
    expect(anchors()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(anchors()).toEqual([html(), null, null, html()]); // tried again, with no edit or focus
  });

  it('the next focus tries the layer again at once; a page that still removes it is held again (no loop)', async () => {
    const { host, f, setIssues } = field();
    shared.results.push('unstable');
    setIssues([issue('a')]);
    await frame();
    await frame();
    expect(anchors()).toEqual([html(), null]);

    shared.results.push('unstable'); // the page is still at it
    host.focused(f);
    await frame();
    await frame();
    expect(anchors()).toEqual([html(), null, html(), null]);
    await vi.advanceTimersByTimeAsync(10_000); // nothing more by itself
    expect(anchors()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(20_100); // the hold restarted at the focus: 30 s from then
    expect(anchors()).toEqual([html(), null, html(), null, html()]);
  });

  it("'unrendered' (no place for the layer at all) stays for good: neither the time nor a focus brings it back", async () => {
    const { host, f, setIssues } = field();
    shared.results.push('unrendered');
    setIssues([issue('a')]);
    await frame();
    await frame();
    host.focused(f);
    await vi.advanceTimersByTimeAsync(31_000);
    setIssues([issue('b')]);
    await frame();
    expect(anchors()).toEqual([html(), null, null]);
  });

  it('a focus with nothing held changes nothing', async () => {
    const { host, f, setIssues } = field();
    setIssues([issue('a')]);
    await frame();
    host.focused(f);
    await frame();
    expect(anchors()).toEqual([html()]);
  });
});

describe('openTools: the menu and the shortcut open the popover through FieldHost', () => {
  const REWRITE = { kind: 'preset', presetId: 'rewrite' } as const;
  const range = { start: 2, end: 5, text: 'has' };

  it('mounts the overlay when nothing is drawn yet, then opens the popover sending the request', async () => {
    const { host, f } = field();
    expect(shared.mounts).toBe(0); // no issues: no overlay yet
    const opened = host.openTools(f, range, REWRITE);
    await vi.advanceTimersByTimeAsync(0);
    expect(await opened).toBe(true);
    expect(shared.mounts).toBe(1);
    expect(shared.tools[0]).toEqual({ phase: 'loading', label: 'Rewriting…' });
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('rewrite', expect.objectContaining({ text: 'has', request: REWRITE }));
  });

  it("hides the selection button the way pressing it does, and the button stays away while it's open", async () => {
    const el = document.createElement('textarea');
    document.body.append(el);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), selection: async () => ({ start: 2, end: 5 }) }));
    host.selectionChanged();
    await vi.advanceTimersByTimeAsync(200);
    expect(shared.buttons.at(-1)).toBeInstanceOf(DOMRect); // the button is up

    await host.openTools(f, range);
    expect(shared.buttons.at(-1)).toBeNull();
    expect(shared.tools.at(-1)).toEqual({ phase: 'menu', mode: 'standard' });
    const shown = shared.buttons.length;
    host.selectionChanged(); // a new selection while the popover is open
    await vi.advanceTimersByTimeAsync(200);
    expect(shared.buttons.slice(shown).every((b) => b === null)).toBe(true);
  });

  describe('the selection button anchor', () => {
    const lastAnchor = () => shared.buttons.at(-1);
    const attachWith = (extra: Partial<EditorAdapter>) => {
      const el = document.createElement('textarea');
      document.body.append(el);
      const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
      const selection = vi.fn(async () => ({ start: 2, end: 5 }));
      host.attach(el, () => ({ ...fakeAdapter(el), selection, ...extra }));
      return { host, selection };
    };
    const settle = async (host: { selectionChanged(): void }) => {
      host.selectionChanged();
      await vi.advanceTimersByTimeAsync(200);
    };

    it('is the last painted highlight rect when it sits on the range\'s last line, the range still read from selection()', async () => {
      const rectsFor = vi.fn(async () => [new DOMRect(10, 40, 30, 20), new DOMRect(90, 62, 100, 20)]);
      const { host, selection } = attachWith({
        rectsFor,
        selectionRects: async () => [new DOMRect(100, 40, 60, 18), new DOMRect(96, 64, 80, 18)],
      });
      await settle(host);
      expect(selection).toHaveBeenCalled();
      expect(lastAnchor()).toEqual(new DOMRect(96, 64, 80, 18));
    });

    it('is the measured last rect when the painted boxes are on another line: a stale highlight', async () => {
      const { host } = attachWith({
        rectsFor: async () => [new DOMRect(90, 200, 100, 20)],
        selectionRects: async () => [new DOMRect(100, 40, 60, 18)],
      });
      await settle(host);
      expect(lastAnchor()).toEqual(new DOMRect(90, 200, 100, 20));
    });

    it('is the painted rect when the range cannot be measured to check it against', async () => {
      const { host } = attachWith({ rectsFor: async () => [], selectionRects: async () => [new DOMRect(100, 40, 60, 18)] });
      await settle(host);
      expect(lastAnchor()).toEqual(new DOMRect(100, 40, 60, 18));
    });

    it('works with a synchronous selectionRects', async () => {
      const { host } = attachWith({ selectionRects: () => [new DOMRect(5, 6, 7, 8)] });
      await settle(host);
      expect(lastAnchor()).toEqual(new DOMRect(5, 6, 7, 8));
    });

    it('is the measured last rect when selectionRects gives null', async () => {
      const { host } = attachWith({ selectionRects: async () => null });
      await settle(host);
      expect(lastAnchor()).toEqual(new DOMRect(10, 10, 30, 20));
    });

    it('is the measured last rect when selectionRects gives none or throws', async () => {
      const empty = attachWith({ selectionRects: async () => [] });
      await settle(empty.host);
      expect(lastAnchor()).toEqual(new DOMRect(10, 10, 30, 20));
      shared.buttons.length = 0;
      const broken = attachWith({
        selectionRects: async () => {
          throw new Error('gdocs-timeout');
        },
      });
      await settle(broken.host);
      expect(lastAnchor()).toEqual(new DOMRect(10, 10, 30, 20));
    });

    it('shows nothing for a collapsed selection even when highlight rects are left over', async () => {
      const { host } = attachWith({ selection: async () => null, selectionRects: async () => [new DOMRect(1, 1, 1, 1)] });
      await settle(host);
      expect(shared.buttons.some((b) => b !== null)).toBe(false);
    });
  });

  it('a field that left before the overlay mounted opens nothing', async () => {
    const { host, f } = field();
    const opening = host.openTools(f, range, REWRITE);
    host.detach(f);
    expect(await opening).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.tools).toEqual([]);
  });

  it('a comment-only card\'s "Rewrite this sentence" opens Rewrite on that issue\'s sentence, not the whole text', async () => {
    const text = 'First one here. The very unique plan works. Last one.';
    const el = document.createElement('textarea');
    document.body.append(el);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), getText: async () => text }));
    const start = text.indexOf('very unique');
    const note = { id: 'n1', start, end: start + 'very unique'.length, original: 'very unique', replacement: null, severity: 'suggestion', kind: 'vague_claim', reason: 'r' };
    shared.sessions.at(-1)!.list = [note as unknown as LocatedIssue];
    await host.overlay(); // mounts, and hands the callback to the fake overlay
    shared.rewrite!(f.fieldId, 'n1');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      'rewrite',
      expect.objectContaining({ text: 'The very unique plan works.', request: expect.objectContaining({ kind: 'preset', presetId: 'rewrite' }) }),
    );
  });

  it('a note\'s Rewrite sends its kind, plain label and reason as the focus', async () => {
    const text = 'First one here. The very unique plan works. Last one.';
    const el = document.createElement('textarea');
    document.body.append(el);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), getText: async () => text }));
    const start = text.indexOf('very unique');
    const note = { id: 'n1', start, end: start + 11, original: 'very unique', replacement: null, severity: 'suggestion', kind: 'vague_word', reason: 'Too vague here.' };
    shared.sessions.at(-1)!.list = [note as unknown as LocatedIssue];
    await host.overlay();
    shared.rewrite!(f.fieldId, 'n1');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      'rewrite',
      expect.objectContaining({
        request: { kind: 'preset', presetId: 'rewrite', focus: { kind: 'vague_word', label: kindInfo('vague_word')!.label, reason: 'Too vague here.' } },
      }),
    );
  });

  it('an invented kind\'s focus label is the kind with underscores turned into spaces', async () => {
    const text = 'The very unique plan works.';
    const el = document.createElement('textarea');
    document.body.append(el);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), getText: async () => text }));
    const note = { id: 'n1', start: 4, end: 15, original: 'very unique', replacement: null, severity: 'suggestion', kind: 'odd_new_kind', reason: 'why' };
    shared.sessions.at(-1)!.list = [note as unknown as LocatedIssue];
    await host.overlay();
    shared.rewrite!(f.fieldId, 'n1');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      'rewrite',
      expect.objectContaining({ request: expect.objectContaining({ focus: { kind: 'odd_new_kind', label: 'odd new kind', reason: 'why' } }) }),
    );
  });

  it('a note whose original crosses two sentences opens on both', async () => {
    const text = 'Intro here. It rained. We left early. Done.';
    const el = document.createElement('textarea');
    document.body.append(el);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), getText: async () => text }));
    const start = text.indexOf('rained. We');
    const original = 'rained. We';
    const note = { id: 'n1', start, end: start + original.length, original, replacement: null, severity: 'suggestion', kind: 'long_sentence', reason: 'r' };
    shared.sessions.at(-1)!.list = [note as unknown as LocatedIssue];
    await host.overlay();
    shared.rewrite!(f.fieldId, 'n1');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('rewrite', expect.objectContaining({ text: 'It rained. We left early.' }));
  });

  it('"Rewrite this sentence" on a note whose text changed since the check opens nothing and says so', async () => {
    const el = document.createElement('textarea');
    document.body.append(el);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), getText: async () => 'The plan works now.' }));
    const note = { id: 'n1', start: 4, end: 15, original: 'very unique', replacement: null, severity: 'suggestion' };
    shared.sessions.at(-1)!.list = [note as unknown as LocatedIssue];
    await host.overlay();
    shared.rewrite!(f.fieldId, 'n1');
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.tools).toEqual([]);
    expect(vi.mocked(sendMessage)).not.toHaveBeenCalledWith('rewrite', expect.anything());
    expect(shared.notices).toEqual(['The text changed. Select it again.']);
  });

  it('focusedField is the attached field that has focus', () => {
    const a = document.createElement('textarea');
    const b = document.createElement('textarea');
    document.body.append(a, b);
    let focused: Element | null = null;
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: (el) => el === focused });
    host.attach(a, () => fakeAdapter(a));
    const fb = host.attach(b, () => fakeAdapter(b));
    expect(host.focusedField()).toBeUndefined();
    focused = b;
    expect(host.focusedField()).toBe(fb);
  });
});

describe("fieldFocused keeps the shortcut's focus map warm", () => {
  const sentFocus = () =>
    vi
      .mocked(sendMessage)
      .mock.calls.filter(([type]) => type === 'fieldFocused')
      .map(([, data]) => (data as { focused: boolean }).focused);
  const tick = () => vi.advanceTimersByTimeAsync(1);

  function focusable(selection: () => { start: number; end: number } | null = () => null) {
    const el = document.createElement('textarea');
    document.body.append(el);
    const state = { focused: false };
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: (e) => state.focused && e === el });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), selection: async () => selection() }));
    return { host, f, state };
  }

  it('says when the frame gains and loses a focused field, once per change, and nothing for a frame never focused', async () => {
    const { state } = focusable();
    await tick();
    document.dispatchEvent(new Event('focusout'));
    await tick();
    expect(sentFocus()).toEqual([]); // the background starts out knowing nothing: no false to send
    state.focused = true;
    document.dispatchEvent(new Event('focusin'));
    await tick();
    document.dispatchEvent(new Event('focusin')); // within the field again: no change
    await tick();
    expect(sentFocus()).toEqual([true]);
    state.focused = false;
    document.dispatchEvent(new Event('focusout'));
    await tick();
    expect(sentFocus()).toEqual([true, false]);
  });

  it('a field that attaches with focus already in it is reported (Docs attaches after its gate)', async () => {
    const el = document.createElement('textarea');
    document.body.append(el);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    host.attach(el, () => fakeAdapter(el));
    expect(sentFocus()).toEqual([]); // once focus has landed
    await tick();
    expect(sentFocus()).toEqual([true]);
  });

  it('a selection settling in the field says it again, and so does a heartbeat every 10 s while it stays', async () => {
    let selection: { start: number; end: number } | null = { start: 2, end: 5 };
    const { host, state } = focusable(() => selection);
    state.focused = true;
    document.dispatchEvent(new Event('focusin'));
    await tick();
    expect(sentFocus()).toEqual([true]);
    host.selectionChanged();
    await vi.advanceTimersByTimeAsync(200);
    expect(sentFocus()).toEqual([true, true]); // unchanged, but a worker that slept has forgotten it
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentFocus()).toEqual([true, true, true]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentFocus()).toHaveLength(4);

    selection = null; // collapsed
    host.selectionChanged();
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sentFocus()).toHaveLength(4);
  });

  it('the heartbeat is quiet while the tab is hidden or the window has no focus, and resumes after', async () => {
    const { host, state } = focusable(() => ({ start: 2, end: 5 }));
    state.focused = true;
    document.dispatchEvent(new Event('focusin'));
    await tick();
    host.selectionChanged();
    await vi.advanceTimersByTimeAsync(200);
    expect(sentFocus()).toEqual([true, true]);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sentFocus()).toHaveLength(2); // a hidden tab never keeps the worker awake
      visibility.mockReturnValue('visible');
      hasFocus.mockReturnValue(false); // another window (or app) has focus
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sentFocus()).toHaveLength(2);
      hasFocus.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sentFocus()).toEqual([true, true, true]);
    } finally {
      visibility.mockRestore();
      hasFocus.mockRestore();
    }
  });

  it('the focused field leaving says the frame has none, and stops the heartbeat', async () => {
    const { host, f, state } = focusable(() => ({ start: 2, end: 5 }));
    state.focused = true;
    await tick(); // the attach-time report
    host.selectionChanged();
    await vi.advanceTimersByTimeAsync(200);
    expect(sentFocus()).toEqual([true, true]);
    host.detach(f);
    await tick();
    expect(sentFocus()).toEqual([true, true, false]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sentFocus()).toEqual([true, true, false]);
  });
});

describe('the suggestion policy and the card actions', () => {
  const at = new DOMRect(10, 10, 30, 20);
  const located = (o: Partial<LocatedIssue>): LocatedIssue =>
    ({ id: 'i1', start: 2, end: 5, before: '', reason: 'r', paragraphHash: 'h', model: { original: 'x', replacement: null }, ...o }) as LocatedIssue;
  const PASSIVE = located({ original: 'was written', replacement: 'wrote', severity: 'suggestion', category: 'clarity', kind: 'passive_voice' });
  const KUBERNETES = located({ original: 'Kubernetes', replacement: 'Kubernetis', severity: 'error', category: 'spelling', kind: 'spelling' });
  const GRAMMAR = located({ original: 'has', replacement: 'have', severity: 'error', category: 'grammar', kind: 'subject_verb_agreement' });

  it('a change to the families, rules or dictionary re-filters every attached field, once each', () => {
    const a = document.createElement('textarea');
    const b = document.createElement('textarea');
    document.body.append(a, b);
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    host.attach(a, () => fakeAdapter(a));
    host.attach(b, () => fakeAdapter(b));
    const [sa, sb] = shared.sessions;
    expect(policyListeners).toHaveLength(1); // one subscription per host, not per field
    policyListeners[0]!();
    expect(sa!.refilter).toHaveBeenCalledTimes(1);
    expect(sb!.refilter).toHaveBeenCalledTimes(1);

    host.detach(host.get(a)!); // a field that left is not re-filtered
    policyListeners[0]!();
    expect(sa!.refilter).toHaveBeenCalledTimes(1);
    expect(sb!.refilter).toHaveBeenCalledTimes(2);
  });

  it('the card offers "Stop suggesting {label}", "Add to dictionary", or nothing', async () => {
    const { host, f } = field();
    await host.overlay();
    expect(shared.cardActions!(f.fieldId, PASSIVE)?.label).toBe('Stop suggesting passive voice');
    expect(shared.cardActions!(f.fieldId, KUBERNETES)?.label).toBe('Add to dictionary');
    expect(shared.cardActions!(f.fieldId, GRAMMAR)).toBeNull();
    pageMode = 'casual'; // Casual has no rules
    expect(shared.cardActions!(f.fieldId, located({ ...PASSIVE, kind: 'oxford_comma', severity: 'error' }))).toBeNull();
  });

  it('"Stop suggesting" writes the rule for this mode, shows the undo chip where the card was, and Undo removes exactly that rule', async () => {
    await rulesItem.setValue([{ mode: 'essay', kind: 'passive_voice' }]);
    const { host, f } = field();
    await host.overlay();
    shared.cardActions!(f.fieldId, PASSIVE)!.run(at, 'above');
    await vi.waitFor(() => expect(shared.undos).toHaveLength(1));
    expect(await rulesItem.getValue()).toEqual([
      { mode: 'essay', kind: 'passive_voice' },
      { mode: 'standard', kind: 'passive_voice' },
    ]);
    // On the card's side of its text: the card was above it.
    expect(shared.undos[0]).toMatchObject({ fieldId: f.fieldId, anchor: at, text: 'Stopped suggesting passive voice.', side: 'above' });

    await rulesItem.setValue([...(await rulesItem.getValue()), { mode: 'standard', kind: 'hedging' }]); // meanwhile
    shared.undos[0]!.onUndo();
    await vi.waitFor(async () =>
      expect(await rulesItem.getValue()).toEqual([
        { mode: 'essay', kind: 'passive_voice' },
        { mode: 'standard', kind: 'hedging' },
      ]),
    );
  });

  describe('the offers after Dismiss', () => {
    const PASSIVE_AT = located({ id: 'p1', original: 'was written', replacement: 'wrote', severity: 'suggestion', category: 'clarity', kind: 'passive_voice' });
    const NGOZI = located({ id: 'n1', start: 7, end: 12, original: 'Ngozi', replacement: 'Ngozie', severity: 'error', category: 'spelling', kind: 'spelling' });
    beforeEach(() => {
      pageMode = 'essay';
    });
    function offerField(text: string, issues: LocatedIssue[]) {
      const el = document.createElement('textarea');
      document.body.append(el);
      const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
      const f = host.attach(el, () => ({ ...fakeAdapter(el), getText: async () => text }));
      const session = shared.sessions.at(-1)!;
      session.list = issues;
      return { host, f, session };
    }
    const dismissIssue = async (f: { fieldId: string }, id: string, side: 'below' | 'above' = 'below') => {
      shared.dismiss!(f.fieldId, id, at, side);
      await vi.advanceTimersByTimeAsync(0);
    };

    it('dismisses the issue, and the third dismissal of an eligible kind shows "Stop suggesting {label} in essays?" where the card was', async () => {
      const { host, f, session } = offerField('The letter was written by me.', [PASSIVE_AT]);
      await host.overlay();
      await dismissIssue(f, 'p1');
      await dismissIssue(f, 'p1');
      expect(session.dismiss).toHaveBeenCalledTimes(2);
      expect(shared.offers).toHaveLength(0);
      await dismissIssue(f, 'p1', 'above');
      expect(shared.offers).toHaveLength(1);
      expect(shared.offers[0]).toMatchObject({ fieldId: f.fieldId, anchor: at, question: 'Stop suggesting passive voice in essays?', yes: 'Stop', side: 'above' });
    });

    it('Stop writes the rule and shows the undo chip in the offer\'s place; Not now is remembered', async () => {
      await dismissCountsItem.setValue({ 'essay:passive_voice': 2 });
      const { host, f } = offerField('The letter was written by me.', [PASSIVE_AT]);
      await host.overlay();
      await dismissIssue(f, 'p1', 'above');
      shared.offers[0]!.onYes();
      await vi.waitFor(() => expect(shared.undos).toHaveLength(1));
      expect(await rulesItem.getValue()).toEqual([{ mode: 'essay', kind: 'passive_voice' }]);
      expect(shared.undos[0]).toMatchObject({ fieldId: f.fieldId, anchor: at, text: 'Stopped suggesting passive voice.', side: 'above' });
      shared.undos[0]!.onUndo();
      await vi.waitFor(async () => expect(await rulesItem.getValue()).toEqual([]));

      await dismissCountsItem.setValue({ 'essay:passive_voice': 2 });
      await dismissIssue(f, 'p1');
      shared.offers[1]!.onNo();
      await vi.waitFor(async () => expect(await declinedItem.getValue()).toEqual(['essay:passive_voice']));
      await dismissIssue(f, 'p1');
      expect(shared.offers).toHaveLength(2); // never asked again
    });

    it('Stop shows the undo chip even when resetting the count fails', async () => {
      await dismissCountsItem.setValue({ 'essay:passive_voice': 2 });
      const { host, f } = offerField('The letter was written by me.', [PASSIVE_AT]);
      await host.overlay();
      await dismissIssue(f, 'p1');
      const reset = vi.spyOn(dismissCountsItem, 'setValue').mockRejectedValueOnce(new Error('quota'));
      shared.offers[0]!.onYes();
      await vi.waitFor(() => expect(shared.undos).toHaveLength(1));
      expect(shared.undos[0]!.text).toBe('Stopped suggesting passive voice.');
      expect(await rulesItem.getValue()).toEqual([{ mode: 'essay', kind: 'passive_voice' }]);
      expect(reset).toHaveBeenCalled();
      reset.mockRestore();
    });

    it('counts nothing in Casual', async () => {
      pageMode = 'casual';
      const { host, f } = offerField('The letter was written by me.', [PASSIVE_AT]);
      await host.overlay();
      for (let i = 0; i < 4; i++) await dismissIssue(f, 'p1');
      expect(shared.offers).toHaveLength(0);
      expect(await dismissCountsItem.getValue()).toEqual({});
    });

    it('dismissing a spelling error on a mid-sentence capitalized word offers the dictionary; Add stores it and shows "Added …"', async () => {
      const { host, f } = offerField('We met Ngozi today.', [NGOZI]);
      await host.overlay();
      await dismissIssue(f, 'n1');
      expect(shared.offers).toHaveLength(1);
      expect(shared.offers[0]).toMatchObject({ question: 'Add “Ngozi” to your dictionary?', yes: 'Add' });
      shared.offers[0]!.onYes();
      await vi.waitFor(() => expect(shared.undos).toHaveLength(1));
      expect(shared.undos[0]!.text).toBe('Added “Ngozi” to your dictionary.');
      expect(await dictionaryItem.getValue()).toEqual(['ngozi']);
    });

    it('the first word of a sentence, a lowercase word and a grammar error offer nothing', async () => {
      const first = offerField('Ngozi came today.', [{ ...NGOZI, start: 0, end: 5 }]);
      await first.host.overlay();
      await dismissIssue(first.f, 'n1');
      const lower = offerField('We met ngozi today.', [{ ...NGOZI, original: 'ngozi' }]);
      await dismissIssue(lower.f, 'n1');
      const grammar = offerField('We has Ngozi today.', [located({ id: 'g1', start: 3, end: 6, original: 'has', replacement: 'have', severity: 'error', category: 'grammar', kind: 'subject_verb_agreement' })]);
      await dismissIssue(grammar.f, 'g1');
      expect(shared.offers).toHaveLength(0);
    });

    it('a field whose text changed since the issue was found makes no dictionary offer, and still dismisses', async () => {
      const { host, f, session } = offerField('Ngozi today.', [NGOZI]); // "We met " was deleted: offset 7 is mid-word now
      await host.overlay();
      await dismissIssue(f, 'n1');
      expect(session.dismiss).toHaveBeenCalledWith('n1');
      expect(shared.offers).toHaveLength(0);
    });

    it('a dismissal that cannot read the field, or whose issue is gone, still dismisses and offers nothing', async () => {
      const { host, f, session } = offerField('x', [NGOZI]);
      await host.overlay();
      await dismissIssue(f, 'missing');
      expect(shared.offers).toHaveLength(0);
      expect(session.dismiss).toHaveBeenCalledWith('missing');
    });
  });

  it('closeUndo closes the chip on the mounted overlay, and never mounts one', async () => {
    const { host } = field();
    host.closeUndo();
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.mounts).toBe(0);
    await host.overlay();
    host.closeUndo();
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.undoCloses).toBe(1);
  });

  it('"Add to dictionary" stores the lowercased word, the chip names the word as written, and Undo removes exactly it', async () => {
    await dictionaryItem.setValue(['englint']);
    const { host, f } = field();
    await host.overlay();
    shared.cardActions!(f.fieldId, KUBERNETES)!.run(at);
    await vi.waitFor(() => expect(shared.undos).toHaveLength(1));
    expect(await dictionaryItem.getValue()).toEqual(['englint', 'kubernetes']);
    expect(shared.undos[0]!.text).toBe('Added “Kubernetes” to your dictionary.');
    shared.undos[0]!.onUndo();
    await vi.waitFor(async () => expect(await dictionaryItem.getValue()).toEqual(['englint']));
  });
});

describe("the badge: the focused field's counts and status in its corner", () => {
  beforeEach(() => {
    badgeOn = true;
  });

  const err = (id: string) => issue(id);
  const sugg = (id: string) => ({ ...issue(id), severity: 'suggestion' }) as LocatedIssue;
  const lastBadge = () => shared.badges.at(-1);
  /** Gives `el` a layout: its border box `rect`, a 1 px border, so its client box is 1 px in on each side. */
  function sized(el: Element, rect: DOMRect) {
    let box = rect;
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => box, configurable: true });
    for (const [prop, get] of [
      ['clientLeft', () => 1],
      ['clientTop', () => 1],
      ['clientWidth', () => box.width - 2],
      ['clientHeight', () => box.height - 2],
    ] as const) {
      Object.defineProperty(el, prop, { get, configurable: true });
    }
    return { moveTo: (next: DOMRect) => (box = next) };
  }

  function badgeField(opts: { adapter?: Partial<EditorAdapter>; badgeInset?: number; focused?: boolean } = {}) {
    const el = document.createElement('textarea');
    document.body.append(el);
    const layout = sized(el, new DOMRect(40, 40, 302, 122)); // client box: 41, 41, 300 × 120
    const state = { focused: opts.focused ?? true };
    let onLayout: (scrolled?: EventTarget | null, redrawn?: boolean) => void = () => {};
    const host = createFieldHost(ctx, {
      host: 'example.com',
      settings,
      isFocused: (e) => state.focused && e === el,
      ...(opts.badgeInset ? { badgeInset: opts.badgeInset } : {}),
    });
    const f = host.attach(el, () => ({
      ...fakeAdapter(el),
      onLayoutChange: (cb) => {
        onLayout = cb;
        return () => {};
      },
      ...opts.adapter,
    }));
    const session = shared.sessions.at(-1)!;
    const setIssues = (list: LocatedIssue[], status: CheckStatus = 'ok') => {
      session.list = list;
      session.statusNow = status;
      session.opts.onUpdate(list, status);
    };
    return {
      el,
      host,
      f,
      session,
      state,
      setIssues,
      layout,
      scroll: (target: EventTarget | null) => onLayout(target),
      /** The editor redrew its lines and nothing scrolled (Docs' tiles), or, with false, a resize. */
      relayout: (redrawn: boolean) => (redrawn ? onLayout(undefined, true) : onLayout()),
    };
  }

  it("a focused field gets it with its counts, status, element and a 6 px inset, against the field's client box", async () => {
    const { f, el, setIssues } = badgeField();
    setIssues([err('a'), err('b'), sugg('c')]);
    await frame();
    expect(lastBadge()).toEqual({
      fieldId: f.fieldId,
      state: {
        anchor: new DOMRect(41, 41, 300, 120),
        errors: 2,
        suggestions: 1,
        busy: false,
        status: 'ok',
        checked: true,
        caret: null,
        field: el,
        inset: 6,
      },
    });
  });

  it('a clean focused field shows it too, mounting the overlay for it', async () => {
    const { f } = badgeField();
    await frame();
    expect(shared.mounts).toBe(1);
    expect(lastBadge()).toMatchObject({ fieldId: f.fieldId, state: { errors: 0, suggestions: 0 } });
  });

  it('a field without focus gets none; focus coming and going shows and clears it', async () => {
    const { f, state } = badgeField({ focused: false });
    await frame();
    expect(shared.badges).toEqual([]);
    expect(shared.mounts).toBe(0); // nothing drawn, nothing focused: no overlay on the page
    state.focused = true;
    document.dispatchEvent(new Event('focusin'));
    await frame();
    expect(lastBadge()).toMatchObject({ fieldId: f.fieldId, state: { errors: 0 } });
    state.focused = false;
    document.dispatchEvent(new Event('focusout'));
    await frame();
    expect(lastBadge()).toEqual({ fieldId: f.fieldId, state: null });
  });

  it('a status and a check in flight show on it; busy redraws only the badge, with no underline re-measure', async () => {
    const { session, setIssues } = badgeField();
    setIssues([err('a')], 'key_missing');
    await frame();
    expect(lastBadge()!.state).toMatchObject({ status: 'key_missing', busy: false });
    const renders = shared.renders.length;
    session.busyNow = true;
    session.opts.onBusyChange!(true);
    await frame();
    expect(lastBadge()!.state).toMatchObject({ busy: true, errors: 1 });
    expect(shared.renders).toHaveLength(renders);
  });

  it('"Show the EngLint badge" off clears it; on brings it back', async () => {
    const { f } = badgeField();
    await frame();
    badgeOn = false;
    badgeListeners.forEach((cb) => cb());
    await frame();
    expect(lastBadge()).toEqual({ fieldId: f.fieldId, state: null });
    badgeOn = true;
    badgeListeners.forEach((cb) => cb());
    await frame();
    expect(lastBadge()!.state).not.toBeNull();
  });

  it('a page scroll that leaves the underlines to the page still moves the badge with the field', async () => {
    const { setIssues, layout, scroll } = badgeField();
    setIssues([err('a')]);
    await frame();
    await frame(); // settled: the caret's measure has drawn too, so only the scroll can draw again
    const renders = shared.renders.length;
    layout.moveTo(new DOMRect(40, -60, 302, 122)); // the page scrolled 100 px
    scroll(document);
    await frame();
    expect(shared.renders).toHaveLength(renders); // the layer scrolled with the page
    expect(lastBadge()!.state!.anchor).toEqual(new DOMRect(41, 0, 300, 61)); // the part still in view
  });

  it('detaching the field clears its badge', async () => {
    const { f, host } = badgeField();
    await frame();
    host.detach(f);
    expect(lastBadge()).toEqual({ fieldId: f.fieldId, state: null });
  });

  it('a second field taking focus takes the badge over', async () => {
    const a = document.createElement('textarea');
    const b = document.createElement('textarea');
    document.body.append(a, b);
    let focused: Element = a;
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: (el) => el === focused });
    const fa = host.attach(a, () => fakeAdapter(a));
    const fb = host.attach(b, () => fakeAdapter(b));
    await frame();
    expect(lastBadge()).toMatchObject({ fieldId: fa.fieldId });
    focused = b;
    document.dispatchEvent(new Event('focusin'));
    await frame();
    expect(shared.badges.slice(-2)).toEqual([
      { fieldId: fa.fieldId, state: null },
      expect.objectContaining({ fieldId: fb.fieldId, state: expect.objectContaining({ errors: 0 }) }),
    ]);
  });

  it('the Docs host gives it its own inset (12 px)', async () => {
    badgeField({ badgeInset: 12 });
    await frame();
    expect(lastBadge()!.state!.inset).toBe(12);
  });

  it("the user's click on it opens the side panel", async () => {
    badgeField();
    await frame();
    shared.badgeClick!('f-any');
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('openPanel', undefined);
  });

  describe('when the side panel does not open', () => {
    const FALLBACK = 'Open the full panel from the EngLint icon in the toolbar.';
    async function click(reply: () => Promise<unknown>) {
      badgeField();
      await frame();
      vi.mocked(sendMessage).mockImplementationOnce(reply as never);
      shared.notices.length = 0;
      shared.badgeClick!('f-any');
      await vi.advanceTimersByTimeAsync(0);
    }

    it('the browser refused (opened: false): a notice says where the panel is', async () => {
      await click(async () => ({ opened: false }));
      expect(shared.notices).toEqual([FALLBACK]);
    });

    it('the message failed: the same notice', async () => {
      await click(async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      });
      expect(shared.notices).toEqual([FALLBACK]);
    });

    it('it opened: no notice', async () => {
      await click(async () => ({ opened: true }));
      expect(shared.notices).toEqual([]);
    });
  });

  it('a resizable field: 16 px more inset on both axes, clear of its resize grip', async () => {
    const { el, setIssues } = badgeField();
    (el as HTMLElement).style.resize = 'both';
    setIssues([err('a')]);
    await frame();
    expect(lastBadge()!.state!.inset).toBe(22);
    (el as HTMLElement).style.resize = 'none';
    setIssues([err('a')]);
    await frame();
    expect(lastBadge()!.state!.inset).toBe(6);
  });

  it('only while the window has focus: a field focused in a frame the user left shows none; window focus and blur redraw it', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      const { f } = badgeField();
      await frame();
      expect(shared.badges).toEqual([]);
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event('focus'));
      await frame();
      expect(lastBadge()).toMatchObject({ fieldId: f.fieldId, state: { errors: 0 } });
      hasFocus.mockReturnValue(false); // the user clicked into another frame
      window.dispatchEvent(new Event('blur'));
      await frame();
      expect(lastBadge()).toEqual({ fieldId: f.fieldId, state: null });
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("says whether the field has had its first answer (a neutral face until then)", async () => {
    const { session, setIssues } = badgeField();
    session.checkedNow = false;
    setIssues([]);
    await frame();
    expect(lastBadge()!.state!.checked).toBe(false);
    session.checkedNow = true;
    setIssues([]);
    await frame();
    expect(lastBadge()!.state!.checked).toBe(true);
  });

  describe("the caret's line: the field's client width, at the line of the character beside the caret", () => {
    const LINE = new DOMRect(60, 101, 9, 20);

    /** Measures "I has a cat.": every character has a box; past its end there is none. */
    const measured = () => vi.fn(async (start: number) => (start < 12 ? [LINE] : []));

    it('measured from the character after the caret, or the one before when that has no box (the end of the text)', async () => {
      let caret: number | null = 4; // in "I has a cat.", the "s" of "has"
      const rectsFor = measured();
      const { setIssues } = badgeField({ adapter: { caret: () => caret, rectsFor } });
      setIssues([err('a')]);
      await frame();
      await frame();
      expect(rectsFor).toHaveBeenLastCalledWith(4, 5);
      expect(lastBadge()!.state!.caret).toEqual(new DOMRect(41, 101, 300, 20));

      caret = 12; // the end of the text
      setIssues([err('a')]);
      await frame();
      await frame();
      expect(rectsFor.mock.calls.slice(-2)).toEqual([
        [12, 13],
        [11, 12],
      ]);
      expect(lastBadge()!.state!.caret).toEqual(new DOMRect(41, 101, 300, 20));

      caret = null; // no caret in the field, and no selection either
      setIssues([err('a')]);
      await frame();
      await frame();
      expect(lastBadge()!.state!.caret).toBeNull();
    });

    it('measuring it asks the adapter for the caret and rects, never for the whole text', async () => {
      const getText = vi.fn(async () => 'I has a cat.');
      const rectsFor = measured();
      const { setIssues } = badgeField({ adapter: { caret: () => 12, rectsFor, getText } });
      setIssues([err('a')]);
      await frame();
      await frame();
      expect(rectsFor).toHaveBeenCalled();
      expect(getText).not.toHaveBeenCalled();
      expect(lastBadge()!.state!.caret).toEqual(new DOMRect(41, 101, 300, 20));
    });

    it("a range selection: the line where it ends is the caret's line, so the badge hides beside the selection button", async () => {
      const end = new DOMRect(200, 141, 30, 20);
      const rectsFor = vi.fn(async () => [new DOMRect(100, 121, 200, 20), end]); // two lines
      const { setIssues } = badgeField({ adapter: { caret: () => null, selection: () => ({ start: 2, end: 10 }), rectsFor } });
      setIssues([err('a')]);
      await frame();
      await frame();
      expect(rectsFor).toHaveBeenLastCalledWith(2, 10);
      expect(lastBadge()!.state!.caret).toEqual(new DOMRect(41, 141, 300, 20));
    });

    it('is measured once a frame, however many edits and focus changes asked for it', async () => {
      const caret = vi.fn(() => 4);
      const { setIssues } = badgeField({ adapter: { caret } });
      await frame();
      await frame();
      caret.mockClear();
      setIssues([err('a')]);
      setIssues([err('a'), err('b')]);
      setIssues([err('a'), err('b'), err('c')]);
      document.dispatchEvent(new Event('focusin'));
      await frame();
      await frame();
      expect(caret).toHaveBeenCalledTimes(1);
      expect(lastBadge()!.state).toMatchObject({ errors: 3, caret: new DOMRect(41, 10, 300, 20) });
    });

    it('a settled selection change measures it again', async () => {
      let line = LINE;
      const { setIssues } = badgeField({ adapter: { caret: () => 4, rectsFor: async () => [line] } });
      setIssues([err('a')]);
      await frame();
      await frame();
      line = new DOMRect(60, 61, 9, 20); // an arrow key moved the caret up a line
      document.dispatchEvent(new Event('selectionchange'));
      await vi.advanceTimersByTimeAsync(150);
      await frame();
      await frame();
      expect(lastBadge()!.state!.caret).toEqual(new DOMRect(41, 61, 300, 20));
    });

    it("the editor redrawing its lines (Docs' tiles) moves the badge with the field without measuring again; a resize measures", async () => {
      const caret = vi.fn(() => 4);
      const { setIssues, layout, relayout } = badgeField({ adapter: { caret } });
      setIssues([err('a')]);
      await frame();
      await frame();
      caret.mockClear();

      layout.moveTo(new DOMRect(40, 30, 302, 122));
      relayout(true);
      await frame();
      await frame();
      expect(lastBadge()!.state!.anchor).toEqual(new DOMRect(41, 31, 300, 120)); // drawn again where the field is
      expect(caret).not.toHaveBeenCalled(); // an edit that moved the caret comes through onUpdate

      relayout(false);
      await frame();
      await frame();
      expect(caret).toHaveBeenCalledTimes(1);
    });

    it('one measure at a time: asks that come while one is on its way make one more after it, not one each', async () => {
      let answer: (at: number) => void = () => {};
      const caret = vi.fn(() => new Promise<number>((resolve) => (answer = resolve)));
      const { setIssues } = badgeField({ adapter: { caret } });
      await frame();
      await frame();
      expect(caret).toHaveBeenCalledTimes(1); // on its way (a slow bridge)
      for (let i = 0; i < 3; i++) {
        setIssues([err('a')]);
        await frame();
      }
      expect(caret).toHaveBeenCalledTimes(1);

      answer(4);
      await frame();
      await frame();
      expect(caret).toHaveBeenCalledTimes(2); // once more, for everything asked meanwhile
      expect(lastBadge()!.state!.caret).toEqual(new DOMRect(41, 10, 300, 20));
      answer(4);
      await frame();
      await frame();
      expect(caret).toHaveBeenCalledTimes(2); // nothing asked since
    });

    it("the field's own scroll moves the remembered line with its text, without measuring again", async () => {
      const rectsFor = vi.fn(async () => [LINE]);
      const { el, setIssues, scroll } = badgeField({ adapter: { caret: () => 4, rectsFor } });
      setIssues([err('a')]);
      await frame();
      await frame();
      const measured = rectsFor.mock.calls.length;
      el.scrollTop = 40;
      Object.defineProperty(el, 'scrollTop', { value: 40, configurable: true }); // happy-dom has no scrolling
      scroll(el);
      await frame();
      await frame();
      expect(lastBadge()!.state!.caret).toEqual(new DOMRect(41, 61, 300, 20));
      expect(rectsFor.mock.calls.length).toBe(measured);
    });
  });
});

describe("the side panel's Chat: fieldText and applyEdit", () => {
  type Handler = (message: { data: unknown }) => Promise<unknown>;
  /** The handler the newest FieldHost registered for a panel message. */
  const handler = (name: string): Handler => {
    const call = vi.mocked(onMessage).mock.calls.filter(([n]) => n === name).at(-1);
    if (!call) throw new Error(`no ${name} handler`);
    return call[1] as unknown as Handler;
  };

  /** A field whose text the adapter's replace really changes (and then reads back, like the real ones). */
  function chatField(text: string, adapter: Partial<EditorAdapter> = {}) {
    const el = document.createElement('textarea');
    document.body.append(el);
    let current = text;
    const replace = vi.fn(async (start: number, end: number, t: string) => {
      current = current.slice(0, start) + t + current.slice(end);
      return true;
    });
    const host = createFieldHost(ctx, { host: 'example.com', settings, isFocused: () => true });
    const f = host.attach(el, () => ({ ...fakeAdapter(el), getText: async () => current, replace, ...adapter }));
    const apply = (original: string, replacement: string) => handler('applyEdit')({ data: { fieldId: f.fieldId, original, replacement } });
    return { f, replace, apply, text: () => current, edit: (next: string) => (current = next) };
  }

  it('applyEdit replaces the one occurrence through the adapter, which verifies it', async () => {
    const { apply, replace, text } = chatField('I has a cat. She runs.');
    expect(await apply('I has', 'I have')).toEqual({ result: 'applied' });
    expect(replace).toHaveBeenCalledExactlyOnceWith(0, 5, 'I have');
    expect(text()).toBe('I have a cat. She runs.');
  });

  it("applyEdit finds a straight-quoted original in curled text, and the replacement takes the text's curled quotes", async () => {
    const { apply, replace } = chatField('Well, it’s a long day.');
    expect(await apply("it's a long day", "it's a hard day")).toEqual({ result: 'applied' });
    expect(replace).toHaveBeenCalledExactlyOnceWith(6, 21, 'it’s a hard day');
  });

  it('an applied edit flashes over the new text, like an accepted fix; one not applied flashes nothing', async () => {
    const rectsFor = vi.fn(async () => [new DOMRect(1, 2, 3, 4)]);
    const { f, apply } = chatField('I has a cat. We has a dog.', { rectsFor });
    expect(await apply('We has a dog', 'We have a dog')).toEqual({ result: 'applied' });
    await vi.advanceTimersByTimeAsync(0);
    expect(rectsFor).toHaveBeenCalledWith(13, 26);
    expect(shared.flashes).toEqual([{ fieldId: f.fieldId, rects: [new DOMRect(1, 2, 3, 4)] }]);
    expect(await apply('We has', 'We have')).toEqual({ result: 'changed' }); // "We has" is gone now
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.flashes).toHaveLength(1);
  });

  it("applyEdit says 'changed' when the original is no longer there, writing nothing", async () => {
    const { apply, replace, edit } = chatField('I has a cat.');
    edit('We have a cat.'); // typed since the answer
    expect(await apply('I has', 'I have')).toEqual({ result: 'changed' });
    expect(replace).not.toHaveBeenCalled();
  });

  it("applyEdit says 'failed' when the adapter's read-back doesn't confirm the replacement, or the field can't be read", async () => {
    const { apply } = chatField('I has a cat.', { replace: async () => false });
    expect(await apply('I has', 'I have')).toEqual({ result: 'failed' });
    const unreadable = chatField('I has a cat.', {
      getText: async () => {
        throw new Error('gone');
      },
    });
    expect(await unreadable.apply('I has', 'I have')).toEqual({ result: 'failed' });
  });

  it("applyEdit returns 'ambiguous' for an original found twice, writing nothing", async () => {
    const { apply, replace } = chatField('I has a cat. I has a dog.');
    expect(await apply('I has', 'I have')).toEqual({ result: 'ambiguous' });
    expect(replace).not.toHaveBeenCalled();
  });

  it("applyEdit returns 'blocked' for a claims change and, in Essay, 'too_big' for an edit adding 4 new words, writing nothing", async () => {
    const claims = chatField('We met in 2019.');
    expect(await claims.apply('in 2019', 'in 2020')).toEqual({ result: 'blocked' });
    expect(claims.replace).not.toHaveBeenCalled();

    pageMode = 'essay';
    const essay = chatField('The plan works.');
    expect(await essay.apply('The plan works', 'The plan works very well for us')).toEqual({ result: 'too_big' });
    expect(essay.replace).not.toHaveBeenCalled();
    expect(await essay.apply('The plan works', 'The plan works very well today')).toEqual({ result: 'applied' });
  });

  it("applyEdit for a field this frame doesn't have says 'changed'", async () => {
    chatField('I has a cat.');
    expect(await handler('applyEdit')({ data: { fieldId: 'f-gone', original: 'I has', replacement: 'I have' } })).toEqual({ result: 'changed' });
  });

  it('revealText selects the first match of a quote through the adapter, redraws and flashes it, and says found', async () => {
    const select = vi.fn(async () => {});
    const rectsFor = vi.fn(async () => [new DOMRect(1, 2, 3, 4)]);
    const { f } = chatField('I has a cat. She runs home.', { select, rectsFor });
    expect(await handler('revealText')({ data: { fieldId: f.fieldId, quote: 'She runs' } })).toEqual({ found: true });
    expect(select).toHaveBeenCalledExactlyOnceWith(13, 21);
    await vi.advanceTimersByTimeAsync(0);
    expect(rectsFor).toHaveBeenCalledWith(13, 21);
    expect(shared.flashes).toEqual([{ fieldId: f.fieldId, rects: [new DOMRect(1, 2, 3, 4)] }]);
  });

  it('revealText finds a straight-quoted passage in curled text', async () => {
    const select = vi.fn(async () => {});
    const { f } = chatField('Well, it’s a long day.', { select });
    expect(await handler('revealText')({ data: { fieldId: f.fieldId, quote: "it's a long day" } })).toEqual({ found: true });
    expect(select).toHaveBeenCalledExactlyOnceWith(6, 21);
  });

  it('revealText for an absent quote says not found and selects nothing', async () => {
    const select = vi.fn(async () => {});
    const { f } = chatField('I has a cat.', { select });
    expect(await handler('revealText')({ data: { fieldId: f.fieldId, quote: 'a dog' } })).toEqual({ found: false });
    expect(select).not.toHaveBeenCalled();
    expect(shared.flashes).toHaveLength(0);
  });

  it('revealText for a field this frame does not have, or one that cannot be read, says not found', async () => {
    chatField('I has a cat.');
    expect(await handler('revealText')({ data: { fieldId: 'f-gone', quote: 'I has' } })).toEqual({ found: false });
    const broken = chatField('x', {
      getText: async () => {
        throw new Error('gone');
      },
    });
    expect(await handler('revealText')({ data: { fieldId: broken.f.fieldId, quote: 'I has' } })).toEqual({ found: false });
  });

  it('fieldText returns the text, the selection (or the caret as an empty range, or none) and the mode', async () => {
    pageMode = 'essay';
    const ranged = chatField('I has a cat.', { selection: () => ({ start: 2, end: 5 }), caret: () => null });
    expect(await handler('fieldText')({ data: { fieldId: ranged.f.fieldId } })).toEqual({
      ok: true,
      text: 'I has a cat.',
      focus: { start: 2, end: 5 },
      mode: 'essay',
    });
    const caret = chatField('I has a cat.', { selection: () => null, caret: async () => 7 });
    expect(await handler('fieldText')({ data: { fieldId: caret.f.fieldId } })).toMatchObject({ ok: true, focus: { start: 7, end: 7 } });
    const none = chatField('I has a cat.');
    expect(await handler('fieldText')({ data: { fieldId: none.f.fieldId } })).toMatchObject({ ok: true, focus: null });
  });

  it("fieldText keeps a stale selection inside the text", async () => {
    const { f } = chatField('Short.', { selection: () => ({ start: 3, end: 40 }) });
    expect(await handler('fieldText')({ data: { fieldId: f.fieldId } })).toMatchObject({ focus: { start: 3, end: 6 } });
  });

  it("fieldText is not ok for a field this frame doesn't have, or whose text can't be read", async () => {
    chatField('I has a cat.');
    expect(await handler('fieldText')({ data: { fieldId: 'f-gone' } })).toEqual({ ok: false });
    const broken = chatField('x', {
      getText: async () => {
        throw new Error('gone');
      },
    });
    expect(await handler('fieldText')({ data: { fieldId: broken.f.fieldId } })).toEqual({ ok: false });
  });
});
