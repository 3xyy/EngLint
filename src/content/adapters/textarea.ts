import type { EditorAdapter } from './types';

const MIRROR_STYLES = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'direction',
  'textAlign',
  'wordBreak',
  'hyphens',
  'fontStretch',
  'fontVariant',
  'fontFeatureSettings',
  'textRendering',
] as const;

export function createTextareaAdapter(el: HTMLTextAreaElement, fieldId: string): EditorAdapter {
  let host: HTMLElement | null = null;
  let mirror: HTMLDivElement | null = null;
  let disposed = false;
  const cleanups = new Set<() => void>();

  // The mirror lives in a closed shadow root so page CSS, page scripts and
  // page MutationObservers cannot see or affect it.
  function getMirror(): HTMLDivElement {
    if (!mirror) {
      host = document.createElement('div');
      host.style.cssText =
        'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: visible; pointer-events: none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      mirror = document.createElement('div');
      mirror.setAttribute('aria-hidden', 'true');
      shadow.appendChild(mirror);
      document.documentElement.appendChild(host);
    }
    return mirror;
  }

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

  function insertViaCommand(text: string): boolean {
    try {
      const exec = (document as { execCommand?: Document['execCommand'] }).execCommand;
      return typeof exec === 'function' && exec.call(document, 'insertText', false, text) === true;
    } catch {
      return false;
    }
  }

  /**
   * Viewport rects for each range, clipped to the textarea's client box (its own scroll), whichever layer
   * draws them: nothing between the field and its layer's anchor clips (overlay/anchor.ts). The mirror is
   * styled once (one getComputedStyle, one layout) per call, whatever the number of ranges.
   */
  function measure(ranges: { start: number; end: number }[]): DOMRect[][] {
    const out: DOMRect[][] = ranges.map(() => []);
    if (disposed || ranges.length === 0) return out;
    const m = getMirror();
    const cs = getComputedStyle(el);
    for (const prop of MIRROR_STYLES) m.style[prop] = cs[prop];
    const box = el.getBoundingClientRect();
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    // A visible scrollbar narrows the text area; reserve it so lines wrap identically.
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - bl - br);
    const side = cs.direction === 'rtl' ? 'paddingLeft' : 'paddingRight';
    m.style.boxSizing = 'border-box';
    m.style.width = `${box.width}px`;
    m.style.height = `${box.height}px`;
    m.style[side] = `${(parseFloat(cs[side]) || 0) + scrollbar}px`;
    m.style.borderStyle = 'solid';
    m.style.borderColor = 'transparent';
    m.style.whiteSpace = cs.whiteSpace || 'pre-wrap';
    m.style.overflowWrap = cs.overflowWrap || 'break-word';
    m.style.position = 'fixed';
    m.style.visibility = 'hidden';
    m.style.overflow = 'hidden';
    m.style.pointerEvents = 'none';
    m.style.left = `${box.left}px`;
    m.style.top = `${box.top}px`;

    // Safety net in case the fixed host is displaced by the page.
    const placed = m.getBoundingClientRect();
    const dx = box.left - placed.left;
    const dy = box.top - placed.top;
    const clip = {
      left: box.left + bl,
      top: box.top + bt,
      right: box.left + bl + el.clientWidth,
      bottom: box.top + bt + el.clientHeight,
    };
    const clipped = (rects: DOMRectList): DOMRect[] => {
      const kept: DOMRect[] = [];
      for (const r of Array.from(rects)) {
        const left = Math.max(r.left + dx, clip.left);
        const top = Math.max(r.top + dy, clip.top);
        const right = Math.min(r.right + dx, clip.right);
        const bottom = Math.min(r.bottom + dy, clip.bottom);
        if (right <= left || bottom <= top) continue;
        kept.push(new DOMRect(left, top, right - left, bottom - top));
      }
      return kept;
    };

    // Spans can't overlap, so an overlapping range waits for a later pass (normally there is one).
    const order = ranges.map((_, i) => i).sort((a, b) => ranges[a]!.start - ranges[b]!.start);
    const passes: number[][] = [];
    for (const i of order) {
      const pass = passes.find((p) => ranges[p[p.length - 1]!]!.end <= ranges[i]!.start);
      if (pass) pass.push(i);
      else passes.push([i]);
    }

    const text = el.value;
    try {
      for (const pass of passes) {
        const nodes: Node[] = [];
        const spans: [number, HTMLSpanElement][] = [];
        let at = 0;
        for (const i of pass) {
          const { start, end } = ranges[i]!;
          const span = document.createElement('span');
          span.textContent = text.slice(start, end);
          nodes.push(document.createTextNode(text.slice(at, start)), span);
          spans.push([i, span]);
          at = end;
        }
        nodes.push(document.createTextNode(`${text.slice(at)}\u200b`));
        m.replaceChildren(...nodes);
        m.scrollTop = el.scrollTop;
        m.scrollLeft = el.scrollLeft;
        for (const [i, span] of spans) out[i] = clipped(span.getClientRects());
      }
    } finally {
      m.replaceChildren(); // no page text lingers in the mirror
    }
    return out;
  }

  return {
    fieldId,
    element: el,

    async getText() {
      return el.value;
    },

    async rectsFor(start, end) {
      return measure([{ start, end }])[0]!;
    },

    async rectsForMany(ranges) {
      return measure(ranges);
    },

    async replace(start, end, text) {
      try {
        if (disposed || el.readOnly || el.disabled) return false;
        el.focus({ preventScroll: true });
        el.setSelectionRange(start, end);
        const focused = (el.getRootNode() as Document | ShadowRoot).activeElement === el;
        if (!(focused && insertViaCommand(text))) {
          el.setRangeText(text, start, end, 'end');
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              inputType: 'insertReplacementText',
              data: text,
            }),
          );
        }
        return el.value.slice(start, start + text.length) === text;
      } catch {
        return false;
      }
    },

    async select(start, end) {
      try {
        el.focus();
        el.setSelectionRange(start, end);
        // Best effort: nudge the caret line into view if it is below the fold.
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 0;
        if (lineHeight && el.scrollHeight > el.clientHeight) {
          const lines = el.value.slice(0, start).split('\n').length - 1;
          const y = lines * lineHeight;
          if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - lineHeight) {
            el.scrollTop = Math.max(0, y - el.clientHeight / 2);
          }
        }
      } catch {
        // selection is best effort
      }
    },

    caret() {
      return el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    },

    selection() {
      const { selectionStart: start, selectionEnd: end } = el;
      return start !== null && end !== null && start < end ? { start, end } : null;
    },

    onChange(cb) {
      return listen(el, 'input', cb);
    },

    onLayoutChange(cb) {
      if (disposed) return () => {};
      const offs = [
        listen(el, 'scroll', () => cb(el)),
        listen(window, 'scroll', (e) => cb(e.target), { capture: true }),
        listen(window, 'resize', () => cb()),
      ];
      let ro: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => cb());
        ro.observe(el);
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
      if (!el.isConnected) return false;
      if (el.getClientRects().length > 0) return true;
      // No layout engine (happy-dom): fall back to connection alone.
      return document.body.getClientRects().length === 0;
    },

    dispose() {
      disposed = true;
      [...cleanups].forEach((off) => off());
      host?.remove();
      host = null;
      mirror = null;
    },
  };
}
