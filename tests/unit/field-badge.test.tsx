import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { Badge, badgeLook, coveredAt } from '../../src/content/overlay/Badge';
import { type BadgeState, mountOverlay } from '../../src/content/overlay/mount';
import type { ToolsHandlers } from '../../src/content/tools/tools-controller';
import type { CheckStatus, LocatedIssue } from '../../src/core/types';

// The in-field badge: what each state shows and says, who can press it, what may sit on its spot, and the
// overlay placing it (setBadge).

vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  createShadowRootUi: vi.fn(async (_ctx: unknown, options: { name: string; onMount(c: HTMLElement): unknown; onRemove?(m: unknown): void }) => {
    const shadowHost = document.createElement(options.name);
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const uiContainer = document.createElement('div');
    shadow.append(uiContainer);
    document.documentElement.append(shadowHost);
    let mounted: unknown;
    return {
      shadow,
      shadowHost,
      uiContainer,
      mount: () => void (mounted = options.onMount(uiContainer)),
      remove: () => options.onRemove?.(mounted),
    };
  }),
}));

/** A click the user made: the browser sets isTrusted; happy-dom never does, so the test does. */
function userClick(el: Element) {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
}

const CLAUDE = { name: 'Claude', keyless: false };

const view = (o: Partial<{ errors: number; suggestions: number; busy: boolean; status: CheckStatus; checked: boolean }> = {}) => ({
  errors: 0,
  suggestions: 0,
  busy: false,
  status: 'ok' as CheckStatus,
  checked: true,
  ...o,
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  document.querySelectorAll('englint-overlay').forEach((el) => el.remove());
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
});

describe('badgeLook: what each state shows and says', () => {
  it('errors: the error count in red, named with the suggestions', () => {
    expect(badgeLook(view({ errors: 2, suggestions: 1 }), CLAUDE)).toEqual({
      face: 'count',
      text: '2',
      tone: 'red',
      label: 'EngLint: 2 errors, 1 suggestion',
    });
    expect(badgeLook(view({ errors: 1 }), CLAUDE).label).toBe('EngLint: 1 error, 0 suggestions');
  });

  it('suggestions only: their count in blue', () => {
    expect(badgeLook(view({ suggestions: 3 }), CLAUDE)).toEqual({ face: 'count', text: '3', tone: 'blue', label: 'EngLint: 0 errors, 3 suggestions' });
  });

  it('nothing open: a green check, "no issues"', () => {
    expect(badgeLook(view(), CLAUDE)).toEqual({ face: 'check', text: '', tone: 'green', label: 'EngLint: no issues' });
  });

  it('before the first answer: a grey dot, "checking soon", not the check', () => {
    expect(badgeLook(view({ checked: false }), CLAUDE)).toEqual({ face: 'dot', text: '', tone: 'grey', label: 'EngLint: checking soon' });
    expect(badgeLook(view({ checked: false, busy: true }), CLAUDE).face).toBe('spinner'); // its request is in flight
    expect(badgeLook(view({ checked: false, status: 'key_missing' }), CLAUDE).text).toBe('!');
  });

  it('over 99 reads 99+', () => {
    expect(badgeLook(view({ errors: 140 }), CLAUDE).text).toBe('99+');
    expect(badgeLook(view({ errors: 99 }), CLAUDE).text).toBe('99');
  });

  it('a status glyph, named with the status text', () => {
    const look = (status: CheckStatus) => badgeLook(view({ errors: 4, status }), CLAUDE);
    expect(look('paused_cap')).toEqual({ face: 'status', text: '$', tone: 'amber', label: 'EngLint: Monthly limit reached. Live checks are paused.' });
    expect(look('out_of_credit')).toMatchObject({ text: '$', tone: 'amber' });
    expect(look('key_missing')).toEqual({ face: 'status', text: '!', tone: 'red', label: 'EngLint: Add your Claude API key to start checking.' });
    expect(look('key_invalid')).toMatchObject({ text: '!', tone: 'red', label: 'EngLint: Your API key was rejected. Check it in settings.' });
    expect(look('docs_fallback')).toEqual({ face: 'status', text: '–', tone: 'amber', label: "EngLint: Google Docs live checking isn't available right now." });
    for (const s of ['rate_limited', 'overloaded', 'offline', 'bad_response'] as CheckStatus[]) {
      expect(look(s)).toMatchObject({ face: 'status', text: '…', tone: 'grey' });
    }
    expect(look('offline').label).toBe("EngLint: Can't reach Claude. Check your connection.");
  });

  it('names the provider, and never says a server that takes no key rejected one', () => {
    expect(badgeLook(view({ status: 'offline' }), { name: 'Groq', keyless: false }).label).toBe("EngLint: Can't reach Groq. Check your connection.");
    expect(badgeLook(view({ status: 'key_invalid' }), { name: 'LM Studio', keyless: true }).label).toBe(
      'EngLint: LM Studio refused the request. Check that it accepts requests from browser extensions.',
    );
  });

  it('a spinner while a check is in flight, over counts and status alike', () => {
    const spinner = { face: 'spinner', text: '', tone: 'grey', label: 'EngLint: checking' };
    expect(badgeLook(view({ busy: true }), CLAUDE)).toEqual(spinner);
    expect(badgeLook(view({ busy: true, errors: 2 }), CLAUDE)).toEqual(spinner);
    expect(badgeLook(view({ busy: true, status: 'key_missing' }), CLAUDE)).toEqual(spinner);
  });
});

describe('Badge', () => {
  const draw = (look = badgeLook(view({ errors: 2, suggestions: 1 }), CLAUDE), onClick = vi.fn()) => {
    const { container } = render(<Badge x={374} y={144} look={look} onClick={onClick} />);
    return { button: container.querySelector<HTMLButtonElement>('button.englint-badge')!, onClick };
  };

  it('renders each face: the count, the check, the spinner, the glyph', () => {
    const count = draw().button;
    expect(count.getAttribute('aria-label')).toBe('EngLint: 2 errors, 1 suggestion');
    expect(count.classList.contains('red')).toBe(true);
    expect(count.textContent).toBe('2');
    expect(count.style.left).toBe('374px');
    expect(count.style.top).toBe('144px');
    cleanup();
    const check = draw(badgeLook(view(), CLAUDE)).button;
    expect(check.querySelector('svg')).not.toBeNull();
    expect(check.getAttribute('aria-label')).toBe('EngLint: no issues');
    cleanup();
    const spinner = draw(badgeLook(view({ busy: true }), CLAUDE)).button;
    expect(spinner.querySelector('.englint-badge-spinner')).not.toBeNull();
    expect(spinner.getAttribute('aria-label')).toBe('EngLint: checking');
    cleanup();
    const dot = draw(badgeLook(view({ checked: false }), CLAUDE)).button;
    expect(dot.querySelector('.englint-badge-dot')).not.toBeNull();
    expect(dot.querySelector('svg')).toBeNull();
    expect(dot.getAttribute('aria-label')).toBe('EngLint: checking soon');
    cleanup();
    for (const [status, glyph] of [['paused_cap', '$'], ['key_missing', '!'], ['docs_fallback', '–']] as const) {
      const button = draw(badgeLook(view({ status }), CLAUDE)).button;
      expect(button.textContent).toBe(glyph);
      cleanup();
    }
  });

  it('a page script clicking it does nothing; the user clicking it calls onClick once', () => {
    const { button, onClick } = draw();
    button.click(); // what a page script can do: isTrusted false
    expect(onClick).not.toHaveBeenCalled();
    userClick(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('pressing it never moves focus out of the field (mousedown is prevented), and Tab never lands on it', () => {
    const { button } = draw();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(button.tabIndex).toBe(-1);
  });
});

describe('coveredAt: what may sit on the badge spot', () => {
  function page() {
    const field = document.createElement('div');
    const inner = document.createElement('p');
    field.append(inner);
    const foreign = document.createElement('div');
    const ours = document.createElement('englint-overlay');
    document.body.append(field, foreign);
    return { field, inner, foreign, ours };
  }
  /** What the browser would hit-test at any point, topmost first (happy-dom has no layout). */
  const under = (...stack: Element[]) => {
    (document as { elementsFromPoint?: (x: number, y: number) => Element[] }).elementsFromPoint = () => stack;
  };

  it('the field, or anything inside it, is no cover', () => {
    const { field, inner } = page();
    under(field, document.body);
    expect(coveredAt(field)(10, 10)).toBe(false);
    under(inner, field, document.body);
    expect(coveredAt(field)(10, 10)).toBe(false);
  });

  it("another element on top is; EngLint's own elements are looked past", () => {
    const { field, foreign, ours } = page();
    under(foreign, field);
    expect(coveredAt(field)(10, 10)).toBe(true);
    under(ours, field); // the badge itself already there
    expect(coveredAt(field)(10, 10)).toBe(false);
    under(ours, foreign, field); // something under the badge: it still counts
    expect(coveredAt(field)(10, 10)).toBe(true);
  });

  it('nothing at the point (off screen) is no cover', () => {
    const { field } = page();
    under();
    expect(coveredAt(field)(-50, -50)).toBe(false);
  });
});

describe('setBadge: the overlay places one badge, for one field', () => {
  const ctx = {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16),
    onInvalidated: vi.fn(),
    addEventListener: (target: EventTarget, type: string, cb: EventListener, opts?: AddEventListenerOptions) =>
      target.addEventListener(type, cb, opts),
  } as unknown as ContentScriptContext;
  const shadow = () => document.querySelector('englint-overlay')!.shadowRoot!;
  const badge = () => shadow().querySelector<HTMLButtonElement>('.englint-badge');

  function state(o: Partial<BadgeState> = {}): BadgeState {
    const field = document.createElement('textarea');
    document.body.append(field);
    return { anchor: new DOMRect(100, 50, 300, 120), errors: 2, suggestions: 1, busy: false, status: 'ok', checked: true, caret: null, field, inset: 6, ...o };
  }

  it("draws it in the field's bottom-right corner, hides it under the caret's line, and clears it", async () => {
    const o = await mountOverlay(ctx);
    await act(async () => o.setBadge('f1', state()));
    expect(badge()!.style.left).toBe('374px');
    expect(badge()!.style.top).toBe('144px');
    expect(badge()!.getAttribute('aria-label')).toBe('EngLint: 2 errors, 1 suggestion');

    await act(async () => o.setBadge('f1', state({ caret: new DOMRect(100, 150, 300, 20) })));
    expect(badge()).toBeNull();
    await act(async () => o.setBadge('f1', state({ inset: 12 })));
    expect(badge()!.style.left).toBe('368px');

    await act(async () => o.setBadge('f2', null)); // another field's clear leaves this one
    expect(badge()).not.toBeNull();
    await act(async () => o.setBadge('f1', null));
    expect(badge()).toBeNull();
  });

  it('a new field takes the one badge over', async () => {
    const o = await mountOverlay(ctx);
    await act(async () => o.setBadge('f1', state()));
    await act(async () => o.setBadge('f2', state({ errors: 0, suggestions: 0 })));
    expect(shadow().querySelectorAll('.englint-badge')).toHaveLength(1);
    expect(badge()!.getAttribute('aria-label')).toBe('EngLint: no issues');
    await act(async () => o.setBadge('f1', null)); // the old owner's clear is stale
    expect(badge()).not.toBeNull();
  });

  it("the user's click reaches onBadgeClick with the field; a script's click doesn't", async () => {
    const o = await mountOverlay(ctx);
    const clicked = vi.fn();
    o.onBadgeClick(clicked);
    await act(async () => o.setBadge('f1', state()));
    badge()!.click();
    expect(clicked).not.toHaveBeenCalled();
    userClick(badge()!);
    expect(clicked.mock.calls).toEqual([['f1']]);
  });

  const issue = {
    id: 'i1',
    original: 'has',
    replacement: 'have',
    before: 'I',
    reason: 'r',
    start: 2,
    end: 5,
    severity: 'error',
    category: 'grammar',
    kind: 'subject_verb_agreement',
    paragraphHash: 'h',
    model: { original: 'has', replacement: 'have' },
  } as unknown as LocatedIssue;

  it("paints under EngLint's own card, undo chip, selection button and tools popover: it comes before them in the root", async () => {
    const o = await mountOverlay(ctx);
    const text = new DOMRect(300, 140, 40, 16);
    await act(async () => {
      o.render('f1', [{ issue, rects: [text] }]);
      o.open('f1', 'i1');
      o.showUndo('f1', text, 'Stopped suggesting it.', () => {});
      o.showSelectionButton(text, () => {});
      const handlers = { pick() {}, apply() {}, showVariants() {}, retry() {}, close() {} } as unknown as ToolsHandlers;
      o.showTools(text, { phase: 'menu', mode: 'standard' }, handlers);
      o.setBadge('f1', state());
    });
    const ours = badge()!;
    for (const selector of ['.englint-card', '.englint-undo', '.englint-select-btn', '.englint-tools']) {
      const other = shadow().querySelector(selector);
      expect(other, selector).not.toBeNull();
      expect(ours.compareDocumentPosition(other!) & Node.DOCUMENT_POSITION_FOLLOWING, selector).toBeTruthy();
    }
  });

  it('resting the pointer on the badge opens no card for the word under it, and tints nothing; beside the badge the word opens its card', async () => {
    vi.useFakeTimers();
    try {
      const o = await mountOverlay(ctx);
      const word = new DOMRect(360, 140, 40, 16); // the badge's spot (374, 144, 20 × 20) covers its right half
      await act(async () => {
        o.render('f1', [{ issue, rects: [word] }]);
        o.setBadge('f1', state());
      });
      const button = badge()!;
      Object.defineProperty(button, 'getBoundingClientRect', { value: () => new DOMRect(374, 144, 20, 20) }); // happy-dom has no layout
      const rest = async (x: number, y: number) => {
        await act(async () => {
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
          await vi.advanceTimersByTimeAsync(400); // a frame, then past the card's open delay
        });
      };
      const underline = () => shadow().querySelector('.englint-underline')!;

      await rest(384, 150); // on the badge, over the word
      expect(shadow().querySelector('.englint-card')).toBeNull();
      expect(underline().classList.contains('active')).toBe(false);

      await rest(366, 150); // on the word, left of the badge
      expect(shadow().querySelector('.englint-card')).not.toBeNull();
      expect(underline().classList.contains('active')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
