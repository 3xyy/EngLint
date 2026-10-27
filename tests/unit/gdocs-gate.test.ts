import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRectRuns, type RectRun } from '../../src/content/gdocs/geometry';
import {
  REASK_INTERVAL_MS,
  READY_TIMEOUT_MS,
  REATTACH_INTERVAL_MS,
  closesCard,
  createReattacher,
  onDocsKey,
  gateDocs,
  isDocsEditor,
  whenDocsEditor,
} from '../../src/entrypoints/gdocs.content';
import { boxFromAttributes, fixtureHtml, fixtureText } from './gdocs-fixture';

function fixtureRuns(): RectRun[] {
  const host = document.createElement('div');
  host.innerHTML = fixtureHtml;
  return readRectRuns(host, boxFromAttributes);
}

/** A gate over a scripted page: whenReady answers, the painted runs, and an interaction trigger. */
function setup(opts: { ready?: boolean[]; runs?: () => RectRun[]; text?: string } = {}) {
  const answers = [...(opts.ready ?? [true])];
  const page = { runs: opts.runs ?? fixtureRuns, text: opts.text ?? fixtureText };
  const interactions = new Set<() => void>();
  const deps = {
    bridge: {
      whenReady: vi.fn(async (_timeoutMs?: number) => answers.shift() ?? answers[answers.length - 1] ?? true),
      getText: vi.fn(async () => page.text),
    },
    readRuns: vi.fn(() => page.runs()),
    onInteraction: vi.fn((cb: () => void) => {
      interactions.add(cb);
      return () => interactions.delete(cb);
    }),
    onReady: vi.fn(),
    onFallback: vi.fn(),
  };
  const interact = () => [...interactions].forEach((cb) => cb());
  return { deps, page, interact, interactions, stop: gateDocs(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gateDocs: first answer', () => {
  it('ready and the painted runs match the text → ready, once', async () => {
    const { deps } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.bridge.whenReady).toHaveBeenCalledWith(READY_TIMEOUT_MS);
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.onFallback).not.toHaveBeenCalled();
    expect(deps.onInteraction).not.toHaveBeenCalled(); // no re-ask listener when it isn't needed
  });

  it('not ready → fallback', async () => {
    const { deps } = setup({ ready: [false] });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onFallback).toHaveBeenCalledTimes(1);
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('ready but a run differs from the text → fallback after the paint wait', async () => {
    const runs = fixtureRuns();
    runs[1] = { ...runs[1]!, text: 'I had a cat and she likes to sleep on the sofa.' };
    const { deps } = setup({ runs: () => runs });
    await vi.advanceTimersByTimeAsync(4900);
    expect(deps.onFallback).not.toHaveBeenCalled(); // a repaint may still catch up
    await vi.advanceTimersByTimeAsync(400);
    expect(deps.onFallback).toHaveBeenCalledTimes(1);
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('runs painted after a delay → ready', async () => {
    let painted: RectRun[] = [];
    const { deps } = setup({ runs: () => painted });
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.onReady).not.toHaveBeenCalled();
    painted = fixtureRuns();
    await vi.advanceTimersByTimeAsync(300);
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.onFallback).not.toHaveBeenCalled();
  });

  it('a slow cold load: no rects for 8 s, then runs that match → ready, with no fallback meanwhile', async () => {
    let painted: RectRun[] = [];
    const { deps } = setup({ runs: () => painted });
    await vi.advanceTimersByTimeAsync(8000);
    expect(deps.onFallback).not.toHaveBeenCalled(); // nothing painted yet is not a mismatch
    painted = fixtureRuns();
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.onFallback).not.toHaveBeenCalled();
  });

  it('rects that arrive late but differ from the text → fallback once they have had the 5 s paint wait', async () => {
    const wrong = fixtureRuns();
    wrong[1] = { ...wrong[1]!, text: 'I had a cat and she likes to sleep on the sofa.' };
    let painted: RectRun[] = [];
    const { deps } = setup({ runs: () => painted });
    await vi.advanceTimersByTimeAsync(8000);
    painted = wrong; // seen by 9 s
    await vi.advanceTimersByTimeAsync(4500);
    expect(deps.onFallback).not.toHaveBeenCalled(); // a repaint may still catch up
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.onFallback).toHaveBeenCalledTimes(1);
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('an empty document (no paragraphs, no rects) → ready at once', async () => {
    const { deps } = setup({ runs: () => [], text: '\u0003\n' });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onReady).toHaveBeenCalledTimes(1);
  });

  it('text but never any rects → fallback when the 30 s first-paint wait ends', async () => {
    const { deps } = setup({ runs: () => [] });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(deps.onFallback).not.toHaveBeenCalled(); // a slow cold load may still paint
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.onFallback).toHaveBeenCalledTimes(1);
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('a text read that keeps failing, with nothing seen yet, gets the 30 s first-paint wait, then counts as unusable', async () => {
    const { deps } = setup();
    deps.bridge.getText.mockRejectedValue(new Error('gdocs-timeout'));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(deps.bridge.getText.mock.calls.length).toBeGreaterThan(1);
    expect(deps.onFallback).not.toHaveBeenCalled(); // a slow cold load may still answer
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.onFallback).toHaveBeenCalledTimes(1);
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('a slow cold load whose text reads fail for 8 s, then match the painted runs → ready, with no fallback meanwhile', async () => {
    const { deps } = setup();
    deps.bridge.getText.mockRejectedValue(new Error('gdocs-timeout'));
    await vi.advanceTimersByTimeAsync(8000);
    expect(deps.onFallback).not.toHaveBeenCalled();
    deps.bridge.getText.mockImplementation(async () => fixtureText);
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.onFallback).not.toHaveBeenCalled();
  });
});

describe('gateDocs: re-asking after a fallback', () => {
  it('the first interaction after the fallback re-asks, and ready starts checking', async () => {
    const { deps, interact, interactions } = setup({ ready: [false, true] });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onFallback).toHaveBeenCalledTimes(1);
    expect(interactions.size).toBe(1);

    interact();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.bridge.whenReady).toHaveBeenCalledTimes(2);
    expect(deps.bridge.whenReady).toHaveBeenLastCalledWith(READY_TIMEOUT_MS); // waits out MAIN's fresh window
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(interactions.size).toBe(0);
    interact();
    await vi.advanceTimersByTimeAsync(REASK_INTERVAL_MS);
    expect(deps.bridge.whenReady).toHaveBeenCalledTimes(2);
  });

  it('at most once per 60 s', async () => {
    const { deps, interact } = setup({ ready: [false, false, false, true] });
    await vi.advanceTimersByTimeAsync(0);
    interact();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.bridge.whenReady).toHaveBeenCalledTimes(2);
    expect(deps.onFallback).toHaveBeenCalledTimes(1); // still the same fallback

    await vi.advanceTimersByTimeAsync(REASK_INTERVAL_MS - 1000);
    interact();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.bridge.whenReady).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    interact();
    interact();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.bridge.whenReady).toHaveBeenCalledTimes(3);
  });

  it('no second re-ask while one is waiting', async () => {
    const { deps, interact } = setup({ ready: [false] });
    await vi.advanceTimersByTimeAsync(0);
    let answer!: (ready: boolean) => void;
    deps.bridge.whenReady.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    interact();
    await vi.advanceTimersByTimeAsync(REASK_INTERVAL_MS + 1000);
    interact();
    expect(deps.bridge.whenReady).toHaveBeenCalledTimes(2);
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onReady).toHaveBeenCalledTimes(1);
  });

  it('never asks again by itself', async () => {
    const { deps } = setup({ ready: [false] });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.bridge.whenReady).toHaveBeenCalledTimes(1);
  });

  it('a stopped gate neither starts nor re-asks', async () => {
    const late = setup({ ready: [true] });
    late.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(late.deps.onReady).not.toHaveBeenCalled();

    const fallen = setup({ ready: [false, true] });
    await vi.advanceTimersByTimeAsync(0);
    fallen.stop();
    expect(fallen.interactions.size).toBe(0);
    fallen.interact();
    await vi.advanceTimersByTimeAsync(0);
    expect(fallen.deps.bridge.whenReady).toHaveBeenCalledTimes(1);
  });
});

describe('only the Docs editor is gated', () => {
  const page = (withEditor: boolean) => {
    const doc = document.implementation.createHTMLDocument('docs');
    if (withEditor) doc.body.innerHTML = '<div class="kix-appview-editor"></div>';
    return doc;
  };

  it.each([
    ['/document/d/1AbC/edit', true],
    ['/document/u/0/d/1AbC/edit', true],
    ['/document/u/12/d/1AbC/edit', true],
    ['/document/u/0/', false], // the docs list
    ['/document/', false],
    ['/document/u/x/d/1AbC/edit', false],
    ['/documents/d/1AbC/edit', false],
  ])('%s with the editor → %s', (path, expected) => {
    expect(isDocsEditor(path, page(true))).toBe(expected);
  });

  it('an editor URL without the editor element is not the editor', () => {
    expect(isDocsEditor('/document/d/1AbC/edit', page(false))).toBe(false);
  });

  it('waits for an editor built after load', async () => {
    const doc = page(false);
    const result = track(whenDocsEditor('/document/d/1AbC/edit', doc, READY_TIMEOUT_MS));
    await vi.advanceTimersByTimeAsync(2000);
    expect(result.settled).toBe(false);
    doc.body.innerHTML = '<div><div class="kix-appview-editor"></div></div>';
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ settled: true, value: true });
  });

  it('a non-editor path answers false at once; an editor that never comes, false at the timeout', async () => {
    expect(await whenDocsEditor('/document/u/0/', page(true), READY_TIMEOUT_MS)).toBe(false);
    const never = track(whenDocsEditor('/document/d/1AbC/edit', page(false), READY_TIMEOUT_MS));
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS - 1);
    expect(never.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(never).toEqual({ settled: true, value: false });
  });
});

describe('re-attaching after Docs replaces its editor', () => {
  function setup(opts: { editor?: boolean[] } = {}) {
    const answers = [...(opts.editor ?? [true])];
    const state = { wanted: true };
    const deps = {
      whenEditor: vi.fn(async () => answers.shift() ?? true),
      wanted: vi.fn(() => state.wanted),
      attach: vi.fn(),
    };
    return { deps, state, request: createReattacher(deps) };
  }

  it('waits for the editor, then attaches once', async () => {
    const { deps, request } = setup();
    request();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.whenEditor).toHaveBeenCalledTimes(1);
    expect(deps.attach).toHaveBeenCalledTimes(1);
  });

  it('at most once per 5 s; requests while waiting coalesce', async () => {
    const { deps, request } = setup();
    request();
    await vi.advanceTimersByTimeAsync(0);
    request(); // replaced again at once
    request();
    await vi.advanceTimersByTimeAsync(REATTACH_INTERVAL_MS - 100);
    expect(deps.attach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.whenEditor).toHaveBeenCalledTimes(2);
    expect(deps.attach).toHaveBeenCalledTimes(2);
  });

  it('nothing when no longer wanted (site off) or the editor never comes back', async () => {
    const off = setup();
    off.state.wanted = false;
    off.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(off.deps.whenEditor).not.toHaveBeenCalled();
    expect(off.deps.attach).not.toHaveBeenCalled();

    const gone = setup({ editor: [false] });
    gone.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(gone.deps.attach).not.toHaveBeenCalled();

    const turnedOff = setup();
    turnedOff.deps.whenEditor.mockImplementationOnce(async () => {
      turnedOff.state.wanted = false; // switched off while waiting for the editor
      return true;
    });
    turnedOff.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(turnedOff.deps.attach).not.toHaveBeenCalled();
  });
});

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => Object.assign(state, { settled: true, value }));
  return state;
}

describe('closesCard (keys typed in the text-event iframe)', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });
  it('Esc and typing keys close the card', () => {
    for (const k of ['Escape', 'a', 'Z', '1', ' ', '.', 'é', 'Enter', 'Backspace', 'Delete', 'Tab']) expect(closesCard(key(k)), k).toBe(true);
    expect(closesCard(key('a', { altKey: true }))).toBe(true); // Option+a types a character on a Mac
  });
  it('caret keys (keyup opens the card at the caret), modifiers and shortcuts do not', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Meta', 'Alt', 'CapsLock', 'F5', 'Process']) {
      expect(closesCard(key(k)), k).toBe(false);
    }
    expect(closesCard(key('c', { metaKey: true }))).toBe(false); // copy
    expect(closesCard(key('c', { ctrlKey: true }))).toBe(false);
  });
});

describe('onDocsKey: what a key typed in the text-event iframe does to the overlay', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });
  const fields = () => ({ closeCard: vi.fn(), closeUndo: vi.fn(), hideSelection: vi.fn() });

  it('Esc closes the card and the undo chip, and keeps the selection button away', () => {
    const f = fields();
    onDocsKey(key('Escape'), f);
    expect(f.closeCard).toHaveBeenCalledTimes(1);
    expect(f.closeUndo).toHaveBeenCalledTimes(1);
    expect(f.hideSelection).toHaveBeenCalledWith(true);
  });

  it('a typing key closes the card but leaves the undo chip, as in other fields', () => {
    for (const k of ['a', ' ', 'Enter', 'Backspace']) {
      const f = fields();
      onDocsKey(key(k), f);
      expect(f.closeCard, k).toHaveBeenCalledTimes(1);
      expect(f.closeUndo, k).not.toHaveBeenCalled();
      expect(f.hideSelection, k).toHaveBeenCalledWith(false);
    }
  });

  it('a caret key or a shortcut does nothing here', () => {
    for (const e of [key('ArrowLeft'), key('c', { metaKey: true })]) {
      const f = fields();
      onDocsKey(e, f);
      expect(f.closeCard).not.toHaveBeenCalled();
      expect(f.closeUndo).not.toHaveBeenCalled();
      expect(f.hideSelection).not.toHaveBeenCalled();
    }
  });
});
