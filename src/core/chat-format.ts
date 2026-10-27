import { z } from 'zod';
import { changesClaims } from './claims';
import { addsTooManyForEssay } from './match';
import type { CheckStatus, Mode } from './types';
import { foldTypography } from './typography';

/** The long-lived port between the side panel's Chat and the background. */
export const CHAT_PORT = 'englint-chat';

/** The line that ends a chat answer's text and starts its edits (a JSON array). */
export const EDITS_SENTINEL = '@@EDITS@@';
export const MAX_EDITS = 8;
export const MAX_EDIT_ORIGINAL = 300;
/** The longest message the writer can send in one turn. */
export const MAX_CHAT_MESSAGE = 2000;
/** The most selected text sent with a message (a longer selection is cut, with "…"). */
export const MAX_CHAT_SELECTION = 4000;

/** A change the chat proposes: replace `original` (text in the document now) with `replacement`. */
export interface Edit {
  original: string;
  replacement: string;
}

/** One stored turn. User turns hold the writer's words; assistant turns the answer and its edits. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  edits?: Edit[];
}

export type ChatFocus = { start: number; end: number } | null;

/** Panel → background. */
export type ChatClientMessage =
  | { type: 'send'; tabId: number; fieldId: string; mode: Mode; text: string; focus: ChatFocus; message: string }
  | { type: 'reset'; tabId: number; fieldId: string };

/**
 * Background → panel. `delta` carries the model's raw text as it arrives: the panel shows
 * `visibleSoFar(everything so far)`, which hides the edits. `done` ends a turn that was kept; `status`
 * ends one that wasn't (the text shown so far stays as it is).
 */
export type ChatServerMessage =
  | { type: 'delta'; text: string }
  | { type: 'done'; message: string; edits: Edit[] }
  | { type: 'status'; status: CheckStatus };

const EditSchema = z.object({ original: z.string(), replacement: z.string() });

export const ChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  edits: z.array(EditSchema).optional(),
});

const FieldId = z.string().min(1).max(200);
const TabId = z.number().int().nonnegative();
const Offset = z.number().int().nonnegative();
const ClientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send'),
    tabId: TabId,
    fieldId: FieldId,
    mode: z.enum(['essay', 'standard', 'casual']),
    text: z.string(),
    focus: z.object({ start: Offset, end: Offset }).nullable(),
    message: z.string(),
  }),
  z.object({ type: z.literal('reset'), tabId: TabId, fieldId: FieldId }),
]);

/** A port message from the panel, or null when it isn't one. */
export function parseChatClientMessage(raw: unknown): ChatClientMessage | null {
  const r = ClientSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// The sentinel on a line of its own (spaces around it allowed).
const SENTINEL_LINE = /(^|\r?\n)[ \t]*@@EDITS@@[ \t]*(?=\r?\n|$)/;

function parseEdits(json: string): Edit[] {
  const body = json.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const edits: Edit[] = [];
  for (const item of data) {
    const e = EditSchema.safeParse(item);
    if (!e.success) continue;
    const { original, replacement } = e.data;
    if (original.trim() === '' || original.length > MAX_EDIT_ORIGINAL || original === replacement) continue;
    edits.push({ original, replacement });
    if (edits.length === MAX_EDITS) break;
  }
  return edits;
}

/** A finished answer: the text before the sentinel line, and the valid edits after it (none if the JSON is bad). */
export function splitAnswer(raw: string): { message: string; edits: Edit[] } {
  const m = SENTINEL_LINE.exec(raw);
  if (!m) return { message: raw.trim(), edits: [] };
  return { message: raw.slice(0, m.index).trim(), edits: parseEdits(raw.slice(m.index + m[0].length)) };
}

/** What to show of an answer still streaming: the text before the sentinel, or before a last line that could become it. */
export function visibleSoFar(raw: string): string {
  const m = SENTINEL_LINE.exec(raw);
  if (m) return raw.slice(0, m.index).trimEnd();
  const lineStart = raw.lastIndexOf('\n') + 1;
  const last = raw.slice(lineStart).trimStart();
  if (last !== '' && EDITS_SENTINEL.startsWith(last)) return raw.slice(0, lineStart).trimEnd();
  return raw.trimEnd();
}

/**
 * Where an edit's `original` is in `text`: its one occurrence, in `text`'s own offsets, or why there isn't one.
 * Curled quotes, dashes, NBSP and ellipses are folded on both sides (the model writes straight ones); a match
 * must start and end on whole characters of the text, never inside a folded `…`. No fuzzy matching, and no
 * guessing between repeats: an edit carries no neighbours to tell them apart.
 */
export function locateEdit(text: string, original: string): { start: number; end: number } | 'missing' | 'ambiguous' {
  return locateIn(foldTypography(text), original);
}

type Folded = ReturnType<typeof foldTypography>;

/** locateEdit on a text folded already, so many edits can share one fold of it. */
function locateIn({ folded, toOriginal }: Folded, original: string): { start: number; end: number } | 'missing' | 'ambiguous' {
  const needle = foldTypography(original).folded;
  if (needle === '') return 'missing';
  const onBoundary = (i: number) => i === 0 || toOriginal[i] !== toOriginal[i - 1];
  let found: number | null = null;
  for (let i = folded.indexOf(needle); i !== -1; i = folded.indexOf(needle, i + 1)) {
    if (!onBoundary(i) || !onBoundary(i + needle.length)) continue;
    if (found !== null) return 'ambiguous';
    found = i;
  }
  if (found === null) return 'missing';
  return { start: toOriginal[found]!, end: toOriginal[found + needle.length]! };
}

export type ApplyCheck = 'ok' | 'ambiguous' | 'blocked' | 'too_big' | 'missing';

/**
 * Whether a chat edit may be applied to `text` in one click: its original occurs exactly once (see locateEdit),
 * in Essay it adds at most 3 new words, as a suggestion may, and the replacement changes no claim (a number,
 * date, name or quote). Where the original is comes first: a missing or repeated original says so before the
 * change itself is judged. `too_big` (Essay only) shows the original without its replacement; `blocked`,
 * `ambiguous` and `missing` offer Copy.
 */
export function canApply(text: string, edit: Edit, mode: Mode): ApplyCheck {
  return judge(text, foldTypography(text), edit, mode);
}

/** canApply for each of `edits`, in order, folding `text` once for all of them. */
export function canApplyAll(text: string, edits: readonly Edit[], mode: Mode): ApplyCheck[] {
  if (edits.length === 0) return [];
  const folded = foldTypography(text);
  return edits.map((edit) => judge(text, folded, edit, mode));
}

function judge(text: string, folded: Folded, edit: Edit, mode: Mode): ApplyCheck {
  const at = locateIn(folded, edit.original);
  if (typeof at === 'string') return at;
  const docOriginal = text.slice(at.start, at.end);
  // Before the claims guard: an essay edit too big to suggest never shows its replacement, claims or not.
  if (mode === 'essay' && addsTooManyForEssay(docOriginal, edit.replacement)) return 'too_big';
  if (changesClaims(docOriginal, edit.replacement)) return 'blocked';
  return 'ok';
}
