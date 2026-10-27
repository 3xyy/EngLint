// The tools popover's follow-ups: their limits (the background checks them again) and how the results read
// when they go back to the model as context. Pure, so the content script, the background and the eval share it.

/** Follow-ups one popover allows; after that, a new request starts a new conversation. */
export const MAX_FOLLOW_UPS = 6;
/** The longest follow-up question. */
export const MAX_QUESTION_CHARS = 500;
/** The longest the shown results, or one earlier answer, may be when sent back. */
export const MAX_ECHO_CHARS = 10_000;

const numbered = (variants: readonly string[]) => variants.map((v, i) => `${i + 1}. ${v}`).join('\n');

export const shownVariants = (variants: readonly string[]) => `Versions:\n${numbered(variants)}`;

export const shownCritique = (c: { weakness: string; lightFix: string }) => `Weakness: ${c.weakness}\nLight-touch version: ${c.lightFix}`;

/** Sound like me's line above its version (the popover and the side panel show it too). */
export const tellsLine = (tells: readonly string[]) => (tells.length ? `Generic patterns found: ${tells.join(', ')}` : 'No generic patterns found.');

/** Sound like me found nothing generic and gave the passage back as it was. */
export const ALREADY_YOU = 'No generic patterns found. This already sounds like you.';

export const shownVoice = (v: { tells: readonly string[]; final: string; unchanged?: boolean }) =>
  v.unchanged ? ALREADY_YOU : `${tellsLine(v.tells)}\nVersion: ${v.final}`;

export const shownSynonyms = (options: readonly { text: string; nuance: string }[]) =>
  `Options:\n${options.map((o) => `- ${o.text} (${o.nuance})`).join('\n')}`;

/** An answer as it reads in a later follow-up's history: the message, then its versions, if any. */
export const shownAnswer = (a: { message: string; variants: readonly string[] }) =>
  a.variants.length ? `${a.message}\n${shownVariants(a.variants)}` : a.message;

/** `s` cut to `max` characters, ending in "…" when it was cut. */
export const clip = (s: string, max = MAX_ECHO_CHARS) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
