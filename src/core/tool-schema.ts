import { z } from 'zod';
import { changesClaims } from './claims';
import { atWordEdge, cutAtWord } from './context';
import { countWords } from './doc-stats';
import type { Mode } from './types';
import { versionFits, type WordLimitCut } from './word-limit';

/** Rewrite variants stage: the model returns versions; the client parser enforces the count. */
export const VariantsOutputSchema = z.object({ variants: z.array(z.string()) });
/** Essay critique stage. */
export const CritiqueOutputSchema = z.object({ weakness: z.string(), light_fix: z.string() });
export const SynonymsOutputSchema = z.object({
  options: z.array(z.object({ text: z.string(), nuance: z.string() })),
});
/** A follow-up's answer: the message, and new versions of the selection when the question asked for them. */
export const FollowUpOutputSchema = z.object({ message: z.string(), variants: z.array(z.string()).nullable() });
/** The style profile built from the writer's pasted pieces. */
export const StyleProfileOutputSchema = z.object({ profile: z.string() });
/** Sound like me: the generic patterns found, and the passage without them, in the writer's voice. */
export const VoiceOutputSchema = z.object({ tells: z.array(z.string()), final: z.string() });
/** Fit a word limit: cuts to pick from (an empty replacement deletes), and one full version at or under the target. */
export const WordLimitOutputSchema = z.object({
  cuts: z.array(z.object({ original: z.string(), replacement: z.string(), why: z.string() })),
  version: z.string(),
});

/** zod's own conversion keeps the shape exact; `$schema` is dropped because the API schema doesn't take it. */
function toApiSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema);
  return rest;
}
export const VARIANTS_JSON_SCHEMA = toApiSchema(VariantsOutputSchema);
export const CRITIQUE_JSON_SCHEMA = toApiSchema(CritiqueOutputSchema);
export const SYNONYMS_JSON_SCHEMA = toApiSchema(SynonymsOutputSchema);
export const FOLLOW_UP_JSON_SCHEMA = toApiSchema(FollowUpOutputSchema);
export const STYLE_PROFILE_JSON_SCHEMA = toApiSchema(StyleProfileOutputSchema);
export const VOICE_JSON_SCHEMA = toApiSchema(VoiceOutputSchema);
export const WORD_LIMIT_JSON_SCHEMA = toApiSchema(WordLimitOutputSchema);

export const VARIANT_COUNT = 3;
/** The most characters a style profile keeps. */
export const MAX_PROFILE_CHARS = 1_200;
export const MAX_SYNONYMS = 8;
/** Sound like me: the most tells kept, and the most characters each keeps. */
export const MAX_TELLS = 5;
export const MAX_TELL_CHARS = 80;
/** The longest critique weakness shown: one short sentence (the prompt asks for at most 12 words). */
export const MAX_WEAKNESS_CHARS = 140;
/** Fit a word limit: the most cuts one answer keeps, and the most characters a cut's why keeps (it asks for 8 words). */
export const MAX_CUTS = 12;
export const MAX_WHY_CHARS = 80;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * Exactly 3 variants, in the model's order, trimmed (an edge space would be applied as-is and double or
 * eat one). Extras are cut; variants equal to the original (after trimming) or blank are dropped; fewer
 * than 3 left is null (a bad response).
 */
export function cleanVariants(data: unknown, original: string): string[] | null {
  const parsed = VariantsOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const kept = parsed.data.variants.map((v) => v.trim()).filter((v) => v !== '' && v !== original.trim());
  return kept.length >= VARIANT_COUNT ? kept.slice(0, VARIANT_COUNT) : null;
}

/** `text` within `max` characters: cut at a word boundary and ended with "…" (mid-word only when no boundary is in reach). */
function clampAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - 1;
  const cut = cutAtWord(text, room).replace(/[\s,;:.!?—–-]+$/u, '');
  return `${cut || text.slice(0, room)}…`;
}
const clampWeakness = (text: string) => clampAtWord(text, MAX_WEAKNESS_CHARS);

/** The weakness (clamped to MAX_WEAKNESS_CHARS) and the light fix, trimmed; null when either is blank. */
export function cleanCritique(data: unknown): { weakness: string; lightFix: string } | null {
  const parsed = CritiqueOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const weakness = clampWeakness(parsed.data.weakness.trim());
  const lightFix = parsed.data.light_fix.trim();
  return weakness && lightFix ? { weakness, lightFix } : null;
}

/**
 * A follow-up's answer: the message trimmed (blank is null, a bad response), and the variants trimmed, without
 * blanks, copies of the original or duplicates, at most 3 (1 in Essay, where a follow-up gives one light touch
 * at most). No variants left is still an answer: the message alone.
 */
export function cleanFollowUp(data: unknown, original: string, mode: Mode): { message: string; variants: string[] } | null {
  const parsed = FollowUpOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const message = parsed.data.message.trim();
  if (!message) return null;
  const max = mode === 'essay' ? 1 : VARIANT_COUNT;
  const seen = new Set([original.trim()]);
  const variants: string[] = [];
  for (const v of (parsed.data.variants ?? []).map((x) => x.trim())) {
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    variants.push(v);
    if (variants.length === max) break;
  }
  return { message, variants };
}

/** Re-cases an option to the target's pattern: ALL CAPS stays ALL CAPS, a leading capital stays capital. */
export function matchCase(target: string, option: string): string {
  const letters = target.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return option.toUpperCase();
  }
  const first = target.match(/\p{L}/u)?.[0];
  if (first && first !== first.toLowerCase() && first === first.toUpperCase()) {
    return option.replace(/\p{L}/u, (c) => c.toUpperCase());
  }
  return option;
}

/** Up to 8 options in the target's case: no blanks, no copy of the target, no duplicates; none left is null. */
export function cleanSynonyms(data: unknown, target: string): { text: string; nuance: string }[] | null {
  const parsed = SynonymsOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const seen = new Set([norm(target).toLowerCase()]);
  const out: { text: string; nuance: string }[] = [];
  for (const o of parsed.data.options) {
    const text = matchCase(target, norm(o.text));
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, nuance: norm(o.nuance) });
    if (out.length === MAX_SYNONYMS) break;
  }
  return out.length >= 1 ? out : null;
}

/** The profile, trimmed and cut to MAX_PROFILE_CHARS; null when it is empty. */
export function cleanStyleProfile(data: unknown): string | null {
  const parsed = StyleProfileOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const profile = parsed.data.profile.trim().slice(0, MAX_PROFILE_CHARS).trimEnd();
  return profile === '' ? null : profile;
}

/**
 * Sound like me: the tells with their whitespace collapsed, each cut to MAX_TELL_CHARS, without blanks or repeats
 * (in any case), at most MAX_TELLS; and the final version trimmed. A blank final is null (a bad response). The
 * original back is an answer only with no tells (the passage already sounds like the writer); with tells it is null.
 */
export function cleanVoice(data: unknown, original: string): { tells: string[]; final: string } | null {
  const parsed = VoiceOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const final = parsed.data.final.trim();
  if (final === '') return null;
  const tells: string[] = [];
  const seen = new Set<string>();
  for (const t of parsed.data.tells.map((x) => norm(x).slice(0, MAX_TELL_CHARS).trimEnd())) {
    if (t === '' || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    tells.push(t);
    if (tells.length === MAX_TELLS) break;
  }
  if (final === original.trim() && tells.length > 0) return null;
  return { tells, final };
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Where `original` first occurs in `text` at word edges without overlapping any of `taken`; -1 when nowhere. */
function freeOccurrence(text: string, original: string, taken: readonly { start: number; end: number }[]): number {
  for (let at = text.indexOf(original); at !== -1; at = text.indexOf(original, at + 1)) {
    const span = { start: at, end: at + original.length };
    if (atWordEdge(text, span.start) && atWordEdge(text, span.end) && !taken.some((t) => overlaps(t, span))) return at;
  }
  return -1;
}

/**
 * Fit a word limit's answer, made safe to show and apply to `selection`. The cuts keep the model's order (the least
 * loss of meaning first), at most MAX_CUTS: each is trimmed and found in the selection at its first occurrence at word
 * edges that overlaps no cut kept before it nor `taken` (the cuts already shown); one found nowhere is dropped. Its
 * savings are counted locally, and one that saves no word is dropped. One that changes a number, name, date or quote
 * (the strict claims rule) is flagged `changesFacts`. The version is kept, trimmed, only at or under `target` words and
 * at least 80% of it, by the local count (versionFits): further under is a summary. `versionChangesFacts`: the version
 * changes a number, name, date or quote of the selection (the lenient rule: sentence openers may go or change); false
 * without a version. Null when the answer doesn't match the schema.
 */
export function cleanWordLimit(
  data: unknown,
  selection: string,
  target: number,
  taken: readonly { start: number; end: number }[] = [],
): { cuts: WordLimitCut[]; version: string | null; versionChangesFacts: boolean } | null {
  const parsed = WordLimitOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const cuts: WordLimitCut[] = [];
  for (const c of parsed.data.cuts) {
    const original = c.original.trim();
    const replacement = c.replacement.trim();
    if (original === '') continue;
    const saves = countWords(original) - countWords(replacement);
    if (saves < 1) continue;
    const start = freeOccurrence(selection, original, [...taken, ...cuts]);
    if (start === -1) continue;
    const why = clampAtWord(norm(c.why), MAX_WHY_CHARS);
    cuts.push({ start, end: start + original.length, original, replacement, why, saves, changesFacts: changesClaims(original, replacement) });
    if (cuts.length === MAX_CUTS) break;
  }
  const trimmed = parsed.data.version.trim();
  const words = countWords(trimmed);
  const version = words >= 1 && versionFits(words, target) ? trimmed : null;
  return { cuts, version, versionChangesFacts: version !== null && changesClaims(selection, version, { sentenceStarts: 'lenient' }) };
}
