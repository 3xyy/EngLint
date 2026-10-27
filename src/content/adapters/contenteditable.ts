import { buildTextMap, plainSpaces, type TextMap } from './text-map';
import type { EditorAdapter, MeasureOptions } from './types';

/** A frame may never come (background tab): wait at most this long for one. */
const FRAME_CAP_MS = 100;
/** After an attempt nobody claimed: how long a change may still take to show up. */
const QUIET_MS = 150;
/** After an editor took the edit (cancelled the event): how long it may take to apply it. */
const HANDLED_MS = 250;
const MUTATIONS: MutationObserverInit = { characterData: true, childList: true, subtree: true };
/** Everything the text map depends on: text, structure, and the attributes that skip subtrees. */
const MAP_INPUTS: MutationObserverInit = {
  ...MUTATIONS,
  attributes: true,
  attributeFilter: ['contenteditable', 'data-placeholder'],
};

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const clips = (overflow: string) => overflow !== '' && overflow !== 'visible';
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function dataOf(text: string): DataTransfer {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  return data;
}

function beforeInputEvent(text: string, range: Range): InputEvent {
  const targetRanges =
    typeof StaticRange === 'function'
      ? [
          new StaticRange({
            startContainer: range.startContainer,
            startOffset: range.startOffset,
            endContainer: range.endContainer,
            endOffset: range.endOffset,
          }),
        ]
      : [];
  const event = new InputEvent('beforeinput', {
    inputType: 'insertReplacementText',
    dataTransfer: dataOf(text),
    targetRanges,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  if (typeof event.getTargetRanges !== 'function' || event.getTargetRanges().length !== targetRanges.length) {
    Object.defineProperty(event, 'getTargetRanges', { value: () => targetRanges });
  }
  return event;
}

function pasteEvent(text: string): ClipboardEvent {
  return new ClipboardEvent('paste', { clipboardData: dataOf(text), bubbles: true, cancelable: true, composed: true });
}

function insertViaCommand(text: string): void {
  const exec = (document as { execCommand?: Document['execCommand'] }).execCommand;
  if (typeof exec === 'function') exec.call(document, 'insertText', false, text); // '' deletes the selection
}

export function createContentEditableAdapter(root: HTMLElement, fieldId: string): EditorAdapter {
  let disposed = false;
  const cleanups = new Set<() => void>();

  function listen(
    target: EventTarget,
    type: string,
    cb: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ): () => void {
    if (disposed) return () => {};
    target.addEventListener(type, cb, opts);
    const off = () => {
      target.removeEventListener(type, cb, opts);
      cleanups.delete(off);
    };
    cleanups.add(off);
    return off;
  }

  // ---- the text map, built once per change of the host ----
  let cached: TextMap | null = null;
  const watcher = new MutationObserver(() => (cached = null));
  watcher.observe(root, MAP_INPUTS);
  cleanups.add(() => watcher.disconnect());
  listen(root, 'input', () => (cached = null));

  /** Pending mutation records count too, so a read in the same task as a change is never stale. */
  function textMap(): TextMap {
    if (disposed) return buildTextMap(root);
    if (watcher.takeRecords().length > 0) cached = null;
    return (cached ??= buildTextMap(root));
  }

  /** The selection of the host's tree (Chrome gives shadow roots their own). */
  function selection(): Selection | null {
    const tree = root.getRootNode() as { getSelection?: () => Selection | null };
    return typeof tree.getSelection === 'function' ? tree.getSelection() : document.getSelection();
  }

  function rangeOf(map: TextMap, start: number, end: number): Range | null {
    if (map.text.length === 0) return null;
    const from = map.toDom(start);
    const to = end > start ? map.toDom(end, 'before') : from;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  }

  /** Selects [start, end) in the current text; the range, or null if there is nothing to select. */
  function selectRange(start: number, end: number): Range | null {
    const range = rangeOf(textMap(), start, end);
    const sel = selection();
    if (!range || !sel) return null;
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
  }

  /**
   * The part of the viewport where the host's text can be seen: the host and its scrolling ancestors, up
   * to (not including) `until`, the underline layer's anchor, which clips the layer itself.
   */
  function visibleBox(until?: Element): Box {
    const box: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    for (let el: Element | null = root; el && el !== until && el !== document.body && el !== document.documentElement; ) {
      const cs = getComputedStyle(el);
      if (clips(cs.overflowX) || clips(cs.overflowY)) {
        const r = el.getBoundingClientRect();
        const left = r.left + el.clientLeft;
        const top = r.top + el.clientTop;
        box.left = Math.max(box.left, left);
        box.top = Math.max(box.top, top);
        box.right = Math.min(box.right, left + el.clientWidth);
        box.bottom = Math.min(box.bottom, top + el.clientHeight);
      }
      const parent: Node | null = el.parentNode;
      el = parent instanceof ShadowRoot ? parent.host : (el.parentElement ?? null);
    }
    return box;
  }

  /** One map read and one visible box per call; per range, only the text nodes it overlaps are measured. */
  function measure(ranges: { start: number; end: number }[], opts?: MeasureOptions): DOMRect[][] {
    const out: DOMRect[][] = ranges.map(() => []);
    if (disposed || ranges.length === 0) return out;
    const map = textMap();
    const clip = visibleBox(opts?.clipUntil);
    ranges.forEach(({ start, end }, i) => {
      // One range per text node: a range over whole elements would add their boxes too.
      for (const seg of map.segmentsIn(start, end)) {
        const range = document.createRange();
        range.setStart(seg.node, Math.max(start, seg.start) - seg.start);
        range.setEnd(seg.node, Math.min(end, seg.end) - seg.start);
        for (const r of Array.from(range.getClientRects())) {
          const left = Math.max(r.left, clip.left);
          const top = Math.max(r.top, clip.top);
          const right = Math.min(r.right, clip.right);
          const bottom = Math.min(r.bottom, clip.bottom);
          if (right <= left || bottom <= top) continue;
          out[i]!.push(new DOMRect(left, top, right - left, bottom - top));
        }
      }
    });
    return out;
  }

  /**
   * Lets the editor react to an attempt (its observers and microtasks run first), then waits until
   * `done()` holds after a DOM change, or until the next frame plus `ms` has passed.
   */
  async function settle(done: () => boolean, ms: number): Promise<void> {
    await nextTask();
    if (done()) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      let framed = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        timers.forEach(clearTimeout);
        resolve();
      };
      const observer = new MutationObserver(() => {
        if (done()) finish();
      });
      observer.observe(root, MUTATIONS);
      const afterFrame = () => {
        if (framed || finished) return;
        framed = true;
        timers.push(setTimeout(finish, ms));
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(afterFrame);
      timers.push(setTimeout(afterFrame, FRAME_CAP_MS));
    });
  }

  return {
    fieldId,
    element: root,

    async getText() {
      return textMap().text;
    },

    async rectsFor(start, end, opts) {
      return measure([{ start, end }], opts)[0]!;
    },

    async rectsForMany(ranges, opts) {
      return measure(ranges, opts);
    },

    async replace(start, end, text) {
      try {
        if (disposed || !root.isContentEditable) return false;
        root.focus({ preventScroll: true });
        const focused = (root.getRootNode() as Document | ShadowRoot).activeElement === root;
        const before = textMap().text;
        const want = plainSpaces(text); // Chrome may write the fix's spaces as NBSP; the map reads them as ' '
        const applied = () => {
          const now = textMap().text;
          // The length matters: a fix that is a prefix of the original ("the the" → "the") matches unchanged text.
          return now.length === before.length - (end - start) + want.length && now.slice(start, start + want.length) === want;
        };
        const unchanged = () => textMap().text === before;

        // 1. Chrome's own edit, which keeps undo. A model-driven editor may put it back.
        if (focused) {
          if (!selectRange(start, end)) return false;
          insertViaCommand(text);
          await settle(applied, QUIET_MS);
          if (applied()) return true;
          if (!unchanged()) return false; // changed, but not into the fix: never stack another edit on it
        }

        // 2. beforeinput. An editor that takes it (cancels it) owns the edit: it never also gets a paste,
        // however long it takes, so a slow editor can't receive the fix twice.
        let range = selectRange(start, end); // editors may have moved the selection: select again each time
        if (!range) return false;
        const taken = !root.dispatchEvent(beforeInputEvent(text, range));
        await settle(applied, taken ? HANDLED_MS : QUIET_MS);
        if (applied()) return true;
        if (taken || !unchanged()) return false;

        // 3. paste, only when nobody took the beforeinput and nothing changed.
        range = selectRange(start, end);
        if (!range) return false;
        const pasted = !root.dispatchEvent(pasteEvent(text));
        await settle(applied, pasted ? HANDLED_MS : QUIET_MS);
        return applied();
      } catch {
        return false;
      }
    },

    async select(start, end) {
      try {
        if (disposed) return;
        root.focus({ preventScroll: true });
        const range = selectRange(start, end);
        if (!range) return;
        const r = range.getBoundingClientRect();
        const box = visibleBox();
        const inView =
          r.top >= Math.max(box.top, 0) &&
          r.bottom <= Math.min(box.bottom, window.innerHeight) &&
          r.left >= Math.max(box.left, 0) &&
          r.right <= Math.min(box.right, window.innerWidth);
        // A range with no box can't be judged: scrolling its element into view is the best effort.
        if (!inView || (r.width === 0 && r.height === 0)) {
          const node = range.startContainer;
          (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      } catch {
        // selection is best effort
      }
    },

    caret() {
      const sel = selection();
      if (!sel?.isCollapsed || !sel.focusNode) return null;
      return textMap().toOffset(sel.focusNode, sel.focusOffset);
    },

    selection() {
      if (disposed) return null;
      const sel = selection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const map = textMap();
      const start = map.toOffset(range.startContainer, range.startOffset);
      const end = map.toOffset(range.endContainer, range.endOffset);
      return start !== null && end !== null && start < end ? { start, end } : null;
    },

    onChange(cb) {
      if (disposed) return () => {};
      let queued = false;
      let active = true;
      const fire = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (active) cb();
        });
      };
      const offInput = listen(root, 'input', fire);
      const observer = new MutationObserver(fire);
      observer.observe(root, MUTATIONS);
      const off = () => {
        active = false;
        offInput();
        observer.disconnect();
        cleanups.delete(off);
      };
      cleanups.add(off);
      return off;
    },

    onLayoutChange(cb) {
      if (disposed) return () => {};
      const offs = [
        listen(root, 'scroll', () => cb(root)),
        listen(window, 'scroll', (e) => cb(e.target), { capture: true }),
        listen(window, 'resize', () => cb()),
      ];
      let ro: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => cb());
        ro.observe(root);
      }
      const off = () => {
        offs.forEach((o) => o());
        ro?.disconnect();
        ro = null;
        cleanups.delete(off);
      };
      cleanups.add(off);
      return off;
    },

    isAlive() {
      if (!root.isConnected || !root.isContentEditable) return false;
      if (root.getClientRects().length > 0) return true;
      // No layout engine (happy-dom): fall back to connection alone.
      return document.body.getClientRects().length === 0;
    },

    dispose() {
      disposed = true;
      [...cleanups].forEach((off) => off());
      cleanups.clear();
      cached = null;
    },
  };
}
