import { snapToWords, trimRange } from '../../core/context';
import { MAX_WORD_LIMIT_CHARS } from '../../core/word-limit';
import type { EditorAdapter } from '../adapters/types';

/** Above this many characters (after trimming) the tools don't run: the controller shows a notice instead. */
export const MAX_SELECTION_CHARS = 2000;

/**
 * How far a selection's text is over the tools' limits: 'rewrites', over MAX_SELECTION_CHARS (only Fit a word limit
 * takes it); 'all', over MAX_WORD_LIMIT_CHARS too; undefined when every tool takes it.
 */
export function overLimit(text: string): 'rewrites' | 'all' | undefined {
  if (text.length > MAX_WORD_LIMIT_CHARS) return 'all';
  return text.length > MAX_SELECTION_CHARS ? 'rewrites' : undefined;
}

export interface FieldSelection {
  start: number;
  end: number;
  text: string;
  /** Longer than MAX_SELECTION_CHARS: the range is still given, but no request should be made. */
  tooLong?: true;
}

/**
 * The field's selection, trimmed to its non-whitespace (edge spaces from a double-click, or that Docs
 * strips from a paste, must never be eaten or doubled by an apply), then grown to whole words: a request
 * never sees part of a word, and an apply replaces the same whole words. Null when collapsed, outside the
 * field, or only whitespace.
 */
export async function readFieldSelection(adapter: EditorAdapter): Promise<FieldSelection | null> {
  const raw = await adapter.selection?.();
  if (!raw) return null;
  const text = await adapter.getText();
  const trimmed = trimRange(text, Math.max(0, raw.start), Math.min(text.length, raw.end));
  if (!trimmed) return null;
  const range = snapToWords(text, trimmed.start, trimmed.end);
  const out: FieldSelection = { ...range, text: text.slice(range.start, range.end) };
  if (out.text.length > MAX_SELECTION_CHARS) out.tooLong = true;
  return out;
}

/**
 * The document's selected text, for the side panel (no field EngLint edits holds it). In Chrome it also
 * covers a selection inside a text box: a textarea or an <input>, also in a shadow root.
 */
export function readPageSelection(doc: Document): string {
  return doc.getSelection()?.toString() ?? '';
}
