import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ActiveState,
  type CardRef,
  createHoverState,
  fadeStep,
  idsOf,
  TINT_OUT_MS,
} from '../../src/content/overlay/hover-state';

const A: CardRef = { fieldId: 'f', issueId: 'a' };
const B: CardRef = { fieldId: 'f', issueId: 'b' };
const C: CardRef = { fieldId: 'g', issueId: 'a' };
const ids = (refs: CardRef[]) => refs.map((r) => `${r.fieldId}/${r.issueId}`);
const none = { hover: null, card: null };

afterEach(() => {
  vi.useRealTimers();
});

describe('fadeStep: which tints fade out', () => {
  it('the hover leaving an issue starts its fade; nothing was fading', () => {
    const { fading, started } = fadeStep({ hover: A, card: null }, none, []);
    expect(ids(fading)).toEqual(['f/a']);
    expect(started).toEqual([fading[0]]);
  });

  it('moving from one issue to another fades the first only', () => {
    const { fading, started } = fadeStep({ hover: A, card: null }, { hover: B, card: null }, []);
    expect(ids(fading)).toEqual(['f/a']);
    expect(ids(started)).toEqual(['f/a']);
  });

  it('an issue that is active again stops fading', () => {
    const was = fadeStep({ hover: A, card: null }, none, []).fading;
    const { fading, started } = fadeStep(none, { hover: A, card: null }, was);
    expect(fading).toEqual([]);
    expect(started).toEqual([]);
  });

  it("the card's issue stays active when the hover leaves it; it fades when the card closes", () => {
    expect(fadeStep({ hover: A, card: A }, { hover: null, card: A }, [])).toEqual({ fading: [], started: [] });
    expect(ids(fadeStep({ hover: null, card: A }, none, []).fading)).toEqual(['f/a']);
  });

  it('hover and card on different issues both going: both fade, each once', () => {
    const { fading, started } = fadeStep({ hover: B, card: A }, none, []);
    expect(ids(fading)).toEqual(['f/b', 'f/a']);
    expect(started).toHaveLength(2);
    expect(ids(fadeStep({ hover: A, card: A }, none, []).fading)).toEqual(['f/a']); // the same issue: one fade
  });

  it('an issue already fading is not added again, and its entry is kept (its timer removes that entry)', () => {
    const entry = { ...A };
    const { fading, started } = fadeStep({ hover: A, card: null }, none, [entry]);
    expect(fading).toEqual([entry]);
    expect(fading[0]).toBe(entry);
    expect(started).toEqual([]);
  });

  it('issues are told apart by field and id', () => {
    const { fading } = fadeStep({ hover: C, card: null }, { hover: A, card: null }, []);
    expect(ids(fading)).toEqual(['g/a']);
    expect(idsOf([A, null, B, C], 'f')).toEqual(new Set(['a', 'b']));
    expect(idsOf([A, null, B, C], 'g')).toEqual(new Set(['a']));
  });

  it('no change of what is active: nothing new fades', () => {
    expect(fadeStep({ hover: A, card: null }, { hover: A, card: null }, [])).toEqual({ fading: [], started: [] });
    expect(fadeStep(none, none, [])).toEqual({ fading: [], started: [] });
  });
});

describe('createHoverState: the fade timers', () => {
  type S = ActiveState & { cardAt: number | null };
  function store(initial: S) {
    let state = initial;
    const sets: Partial<S>[] = [];
    return {
      get: () => state,
      set(patch: Partial<S>) {
        sets.push(patch);
        state = { ...state, ...patch };
      },
      sets,
    };
  }

  it('a tint that stops being active is in the fading list for TINT_OUT_MS, then leaves it', () => {
    vi.useFakeTimers();
    const s = store({ hover: null, card: null, fading: [], cardAt: null });
    const { setHover } = createHoverState(s, (cb, ms) => setTimeout(cb, ms));
    setHover(A);
    expect(s.get().fading).toEqual([]);
    setHover(null);
    expect(ids(s.get().fading)).toEqual(['f/a']);
    vi.advanceTimersByTime(TINT_OUT_MS - 1);
    expect(ids(s.get().fading)).toEqual(['f/a']);
    vi.advanceTimersByTime(1);
    expect(s.get().fading).toEqual([]);
  });

  it("coming back during the fade stops it, and the old timer doesn't end a later fade early", () => {
    vi.useFakeTimers();
    const s = store({ hover: null, card: null, fading: [], cardAt: null });
    const { setHover } = createHoverState(s, (cb, ms) => setTimeout(cb, ms));
    setHover(A);
    setHover(null); // fade 1 starts at 0
    vi.advanceTimersByTime(50);
    setHover(A);
    expect(s.get().fading).toEqual([]);
    setHover(null); // fade 2 starts at 50
    vi.advanceTimersByTime(TINT_OUT_MS - 50); // fade 1's timer: its entry is gone already
    expect(ids(s.get().fading)).toEqual(['f/a']);
    vi.advanceTimersByTime(50);
    expect(s.get().fading).toEqual([]);
  });

  it('commit sets the whole patch at once (the card and its place together); setHover skips no-ops', () => {
    const s = store({ hover: null, card: null, fading: [], cardAt: null });
    const { commit, setHover } = createHoverState(s, () => {});
    commit({ card: A, cardAt: 7 });
    expect(s.sets[0]).toEqual({ card: A, cardAt: 7 });
    commit({ cardAt: 9 }); // neither hover nor card: no fade work
    expect(s.sets).toHaveLength(2);
    setHover(null); // no hover already: skipped
    setHover({ ...A }); // a change
    setHover({ ...A }); // an equal issue again: skipped
    expect(s.sets).toHaveLength(3);
    expect(s.sets[2]).toEqual({ hover: A });
  });
});
