import { z } from 'zod';
import { cut, guardAdvice, type EssayGuard } from './review-schema';

export const CATEGORIES = ['spelling', 'grammar', 'punctuation', 'word_choice', 'clarity', 'engagement', 'delivery'] as const;
export const SEVERITIES = ['error', 'suggestion'] as const;

/** One issue as EngLint uses it. Also the per-issue check applied after parsing. */
export const IssueSchema = z.object({
  original: z.string(),
  replacement: z.string().nullable(),
  before: z.string(),
  // kind before category: the model names the kind first, and a known kind decides the family.
  kind: z.string(),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  reason: z.string(),
});

/** The reply EngLint asks the model for (and the JSON schema sent to the API). */
export const LiveCheckOutputSchema = z.object({
  results: z.array(
    z.object({
      paragraph_id: z.string(),
      issues: z.array(IssueSchema),
    }),
  ),
});
export type LiveCheckOutput = z.infer<typeof LiveCheckOutputSchema>;

/**
 * The JSON schema sent as output_config.format. SDK 0.135.0's zodOutputFormat moves `enum` into a
 * description, which leaves category and severity unconstrained; zod's own conversion keeps the
 * enums. `$schema` is dropped because the API schema doesn't take it.
 */
export const LIVE_CHECK_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _, ...schema } = z.toJSONSchema(LiveCheckOutputSchema);
  return schema;
})();

// Parse-time shape: category and severity are plain strings, so one invented value
// costs one issue instead of the whole batch.
const WireOutputSchema = z.object({
  results: z.array(
    z.object({
      paragraph_id: z.string(),
      issues: z.array(IssueSchema.extend({ category: z.string(), severity: z.string() })),
    }),
  ),
});

/** Throws (ZodError) only when the top-level shape is wrong; drops and counts invalid issues. */
export function parseLiveCheckOutput(data: unknown): { output: LiveCheckOutput; droppedInvalid: number } {
  let droppedInvalid = 0;
  const results = WireOutputSchema.parse(data).results.map((r) => ({
    paragraph_id: r.paragraph_id,
    issues: r.issues.flatMap((issue) => {
      const checked = IssueSchema.safeParse(issue);
      if (checked.success) return [checked.data];
      droppedInvalid++;
      return [];
    }),
  }));
  return { output: { results }, droppedInvalid };
}

export const NOTE_TYPES = ['tense_shift', 'overused_word', 'ambiguous', 'inconsistency'] as const;

/** One observation about the whole text, with the passages it points at. */
export interface DocNote {
  type: (typeof NOTE_TYPES)[number];
  text: string;
  quotes: string[];
  /** How many times, for an overused word; null otherwise. */
  count: number | null;
}

const DocNoteSchema = z.object({
  type: z.enum(NOTE_TYPES),
  text: z.string(),
  quotes: z.array(z.string()),
  count: z.number().int().nullable(),
});

/** The Deep check reply (and the JSON schema sent to the API): the live-check results plus notes about the whole text. */
export const DeepCheckOutputSchema = LiveCheckOutputSchema.extend({ notes: z.array(DocNoteSchema) });
export type DeepCheckOutput = z.infer<typeof DeepCheckOutputSchema>;
/** `z.int()` emits safe-integer minimum/maximum, which the API's structured outputs reject: the type stays, the bounds go. */
function withoutNumberBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutNumberBounds);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => k !== 'minimum' && k !== 'maximum')
      .map(([k, v]) => [k, withoutNumberBounds(v)]),
  );
}
export const DEEP_CHECK_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _, ...schema } = z.toJSONSchema(DeepCheckOutputSchema);
  return withoutNumberBounds(schema) as Record<string, unknown>;
})();

const MAX_NOTES = 8;
const MAX_NOTE_QUOTES = 3;
const MAX_NOTE_TEXT = 300;
const MAX_NOTE_QUOTE = 200;

// Parse-time shape: a note's type is a plain string and count may be absent, so one bad note costs one note.
const WireNoteSchema = DocNoteSchema.extend({ type: z.string(), count: z.number().int().nullish() });

/**
 * Like parseLiveCheckOutput, plus the notes: an invalid issue or note is dropped (issues are counted), note text
 * and quotes are cut to their limits, at most 8 notes and 3 quotes each are kept, and a missing count is null.
 * With `guard` in Essay, a note's long quoted passages missing from the text become "…", and a note left with under 3 words is dropped.
 * Throws (ZodError) only when the top-level shape is wrong.
 */
export function parseDeepCheckOutput(data: unknown, guard?: EssayGuard): { output: DeepCheckOutput; droppedInvalid: number } {
  const { output, droppedInvalid } = parseLiveCheckOutput(data);
  const wire = z.object({ notes: z.array(z.unknown()).optional() }).parse(data);
  const notes: DocNote[] = [];
  for (const raw of wire.notes ?? []) {
    const note = WireNoteSchema.safeParse(raw);
    if (!note.success || !(NOTE_TYPES as readonly string[]).includes(note.data.type)) continue;
    const text = cut(guardAdvice(note.data.text, guard), MAX_NOTE_TEXT);
    if (text === '') continue;
    notes.push({
      type: note.data.type as DocNote['type'],
      text,
      quotes: note.data.quotes.map((q) => cut(q, MAX_NOTE_QUOTE)).filter((q) => q !== '').slice(0, MAX_NOTE_QUOTES),
      count: note.data.type === 'overused_word' && note.data.count != null && note.data.count >= 1 ? note.data.count : null,
    });
    if (notes.length === MAX_NOTES) break;
  }
  return { output: { ...output, notes }, droppedInvalid };
}
