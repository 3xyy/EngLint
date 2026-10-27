import { isCheckableField } from './skip';

/**
 * EngLint's own elements in the page: the overlay (`englint-overlay`) and the field layers
 * (`englint-field-layer`). Never a field, and never walked into, whether their root is closed (production)
 * or open (the e2e build): focus inside one is focus in EngLint's UI.
 */
const isOwnUi = (node: EventTarget): boolean => node instanceof Element && node.localName.startsWith('englint-');

/** The element that really has focus, following open shadow roots down; EngLint's own UI gives its host. */
export function deepActiveElement(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el && !isOwnUi(el) && el.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * The field an element belongs to: for anything inside a contenteditable, its editing host (the
 * outermost editable element, whose parent is not editable), so nested editable children share one
 * session. Anything else is its own field.
 */
export function editingHost(el: Element): Element {
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return el;
  let host: HTMLElement = el;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

/**
 * Reports checkable fields as they gain focus: `onField` runs on every focus of one (and once at
 * start for a field that already has focus). A reported field that leaves the document gets one
 * `onGone`. Returns a function that stops watching.
 */
export function watchFields(
  doc: Document,
  onField: (el: Element) => void,
  onGone: (el: Element) => void,
): () => void {
  const tracked = new Set<Element>();

  const consider = (target: Element | null) => {
    if (!target || isOwnUi(target)) return;
    const el = editingHost(target);
    if (!el.isConnected || !isCheckableField(el)) return;
    tracked.add(el);
    onField(el);
  };

  // composedPath()[0] is the real target inside open shadow roots (event.target is retargeted). Focus moving
  // into EngLint's own UI (anywhere on the path) is not a field.
  const onFocusIn = (e: Event) => {
    const path = e.composedPath();
    if (path.some(isOwnUi)) return;
    const target = path[0];
    consider(target instanceof Element ? target : null);
  };
  doc.addEventListener('focusin', onFocusIn, true);

  const observer = new MutationObserver(() => {
    for (const el of tracked) {
      if (el.isConnected) continue;
      tracked.delete(el);
      onGone(el);
    }
  });
  observer.observe(doc, { childList: true, subtree: true });

  consider(deepActiveElement(doc));

  return () => {
    doc.removeEventListener('focusin', onFocusIn, true);
    observer.disconnect();
    tracked.clear();
  };
}
