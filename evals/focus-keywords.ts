/** Words a critique uses when it names the flagged problem itself (not just the sentence it sits in). */
export const FOCUS_KEYWORDS: Record<string, RegExp> = {
  long_sentence: /\b(long|length|lengthy|run-?on|clauses?|split|break (it )?up|too (much|many)|several ideas)\b/i,
  unclear_reference: /\b(who|whom|unclear|ambigu\w*|refers?|referring|pronouns?|which (one|person))\b/i,
  vague_word: /\b(vague|nice|things?|stuff|specific|general|concrete)\b/i,
  sentence_variety: /\b(start\w*|open\w*|begin\w*|repeat\w*|vari\w*|same|rhythm|monoton\w*)\b/i,
};
