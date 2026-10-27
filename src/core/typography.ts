/**
 * Docs (and many editors) curl quotes, dashes and ellipses on their own; the model usually
 * answers with straight ones. Folding both sides lets `locateIssue` still find the span.
 * No fuzzy matching: only these characters change.
 */
const FOLD: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
  '–': '-',
  '—': '-',
  '\u00a0': ' ',
  '…': '...',
};

/**
 * `toOriginal[i]` is the original index of folded char `i`, plus one final entry for the end.
 * Every original char folds to at least one char, so the map never decreases; the three dots
 * of a folded `…` all map to the `…`.
 */
export function foldTypography(s: string): { folded: string; toOriginal: number[] } {
  let folded = '';
  const toOriginal: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!; // code units: none of the folded characters is astral
    const out = FOLD[ch] ?? ch;
    folded += out;
    for (let k = 0; k < out.length; k++) toOriginal.push(i);
  }
  toOriginal.push(s.length);
  return { folded, toOriginal };
}

/**
 * The one form a dictionary word takes, both when stored and when matched against a spelling error:
 * typography folded (so O’Brien and O'Brien agree), spaces and edge punctuation or symbols trimmed,
 * lowercased.
 */
export function dictionaryForm(word: string): string {
  return foldTypography(word)
    .folded.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .toLowerCase();
}

/** Carry the document's curled quotes into a replacement written with straight ones. */
export function carryTypography(docOriginal: string, replacement: string): string {
  let out = replacement;
  if (docOriginal.includes('’')) out = out.replace(/'/g, '’');
  if (docOriginal.includes('“') || docOriginal.includes('”')) out = out.replace(/"([^"]*)"/g, '“$1”');
  return out;
}
