import { z } from 'zod';
import type { Mode } from './types';

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

export const VARIANT_COUNT = 3;
/** The most characters a style profile keeps. */
export const MAX_PROFILE_CHARS = 1_200;
export const MAX_SYNONYMS = 8;
/** Sound like me: the most tells kept, and the most characters each keeps. */
export const MAX_TELLS = 5;
export const MAX_TELL_CHARS = 80;

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

export function cleanCritique(data: unknown): { weakness: string; lightFix: string } | null {
  const parsed = CritiqueOutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const weakness = parsed.data.weakness.trim();
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
