import { hostMatches } from '../core/modes';

/** Nearest explicit contenteditable attribute wins; `false` wins if nearer. */
function isEditableByAttribute(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const v = node.getAttribute('contenteditable');
    if (v === null) continue;
    const value = v.toLowerCase();
    if (value === 'false') return false;
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
  }
  return false;
}

/** Code editors: Monaco, CodeMirror 6 (.cm-editor > .cm-content) and 5, Ace. */
const CODE_EDITORS = '.monaco-editor, .cm-editor, .cm-content, .CodeMirror, .ace_editor';
/** An aria-label or role naming a code or terminal widget. */
const CODE_LABEL = /\b(code|terminal|console)\b/i;

/**
 * An explicit "no grammar checker here" on the field or an ancestor. Not spellcheck="false", data-gramm or
 * data-gramm_editor: editors set those to turn off the browser's or Grammarly's own checking (Gmail's compose
 * body has spellcheck="false"; every Quill root has data-gramm="false"), not to mark secrets.
 */
function optedOut(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.getAttribute('data-enable-grammarly')?.trim().toLowerCase() === 'false') return true;
  }
  return false;
}

/** Code editors, terminals and fields that opted out of grammar checkers: never read, never sent. */
function isCodeOrOptedOut(el: Element): boolean {
  if (optedOut(el) || el.closest(CODE_EDITORS)) return true;
  return CODE_LABEL.test(el.getAttribute('aria-label') ?? '') || CODE_LABEL.test(el.getAttribute('role') ?? '');
}

export function isCheckableField(el: Element): boolean {
  if (el.closest('[data-englint="off"]')) return false;
  if (isCodeOrOptedOut(el)) return false;

  // autocomplete is a token list ("billing cc-number"): any card or one-time-code token skips the field.
  const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  if (tokens.some((t) => t.startsWith('cc-') || t === 'one-time-code')) return false;

  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return false;
  if (tag === 'textarea') {
    if (el.hasAttribute('readonly') || el.hasAttribute('disabled')) return false;
    return el.closest('[contenteditable="false"]') === null;
  }
  return isEditableByAttribute(el);
}

/** The generic content script never runs where a dedicated adapter exists. */
export function isGenericHostExcluded(host: string): boolean {
  return hostMatches(host, 'docs.google.com');
}
