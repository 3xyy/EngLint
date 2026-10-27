// The overlay's hover and active state: which issue is under the pointer, which has its card open, and the
// tint fade of issues that stop being active (overlay.css). Every hover or card change goes through
// `commit`, so the fade can't be skipped.

export interface CardRef {
  fieldId: string;
  issueId: string;
}

/** The parts of the overlay's state that say what is active, and what is fading out. */
export interface ActiveState {
  /** The issue under the pointer. With the card's issue, it is shown active (tint, darker underline). */
  hover: CardRef | null;
  card: CardRef | null;
  /** Issues that stopped being active, while their tint fades out. */
  fading: CardRef[];
}

/** overlay.css: the tint's fade-out. */
export const TINT_OUT_MS = 120;

export const sameCard = (a: CardRef | null, b: CardRef | null) =>
  a === b || (!!a && !!b && a.fieldId === b.fieldId && a.issueId === b.issueId);

/** The issue ids among `refs` that belong to `fieldId`. */
export const idsOf = (refs: (CardRef | null)[], fieldId: string) =>
  new Set(refs.flatMap((r) => (r?.fieldId === fieldId ? [r.issueId] : [])));

/**
 * The fading list after the active issues changed from `before` to `after`: an issue that stops being
 * active (no longer hovered, nor the card's) starts fading, once; one that is active again stops fading.
 * `started` holds the entries that just started, each its own object (its fade timer removes that entry).
 */
export function fadeStep(
  before: Pick<ActiveState, 'hover' | 'card'>,
  after: Pick<ActiveState, 'hover' | 'card'>,
  fading: readonly CardRef[],
): { fading: CardRef[]; started: CardRef[] } {
  const isActive = (r: CardRef) => sameCard(after.hover, r) || sameCard(after.card, r);
  let next = fading.filter((f) => !isActive(f));
  const started: CardRef[] = [];
  for (const r of [before.hover, before.card]) {
    if (!r || isActive(r) || next.some((f) => sameCard(f, r))) continue;
    const entry = { ...r };
    next = [...next, entry];
    started.push(entry);
  }
  return { fading: next, started };
}

interface StoreOf<S> {
  get(): S;
  set(patch: Partial<S>): void;
}

/**
 * Hover and card updates for `store`. `commit` is a store update: when the hover or the card changes, an
 * issue that stops being active fades its tint out for `fadeMs`, then leaves the fading list.
 */
export function createHoverState<S extends ActiveState>(
  store: StoreOf<S>,
  setTimeout: (cb: () => void, ms: number) => unknown,
  fadeMs = TINT_OUT_MS,
) {
  const commit = (patch: Partial<S>) => {
    const before = store.get();
    store.set(patch);
    if (!('hover' in patch) && !('card' in patch)) return;
    const after = store.get();
    const { fading, started } = fadeStep(before, after, after.fading);
    for (const entry of started) {
      setTimeout(() => store.set({ fading: store.get().fading.filter((f) => f !== entry) } as Partial<S>), fadeMs);
    }
    if (fading.length !== after.fading.length || fading.some((f, i) => f !== after.fading[i])) {
      store.set({ fading } as Partial<S>);
    }
  };
  const setHover = (hover: CardRef | null) => {
    if (!sameCard(store.get().hover, hover)) commit({ hover } as Partial<S>);
  };
  return { commit, setHover };
}
