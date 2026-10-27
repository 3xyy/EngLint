/**
 * Edits EngLint never shows, whatever the model says. Both are style or contested points the
 * model gets wrong (measured by the eval), and precision beats recall:
 * - adding or removing a comma right before "and" / "or" (the serial comma)
 * - swapping who ↔ whom
 */
export function isSuppressedEdit(original: string, replacement: string | null): boolean {
  if (replacement === null || original === replacement) return false;
  return isConjunctionCommaOnly(original, replacement) || isWhoWhomSwap(original, replacement);
}

function isConjunctionCommaOnly(a: string, b: string): boolean {
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  if (longer.length !== shorter.length + 1) return false;
  let i = 0;
  while (i < shorter.length && longer[i] === shorter[i]) i++;
  return (
    longer[i] === ',' &&
    longer.slice(0, i) + longer.slice(i + 1) === shorter &&
    /^ (?:and|or)\b/.test(longer.slice(i + 1))
  );
}

function isWhoWhomSwap(a: string, b: string): boolean {
  const whomCount = (s: string) => s.match(/\bwhom\b/gi)?.length ?? 0;
  const asWho = (s: string) => s.toLowerCase().replace(/\bwhom\b/g, 'who');
  return whomCount(a) !== whomCount(b) && asWho(a) === asWho(b);
}

// Apostrophe-less forms that are also everyday words: adding the apostrophe is a real fix.
const COLLISIONS = new Set(['its', 'were', 'well', 'wed', 'ill', 'shell', 'hell', 'id']);
const CHAT_SLANG = new Set([
  'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'dunno', 'lemme', 'gimme', 'ya', 'u', 'ur', 'tho', 'thru', 'cuz',
  'coz', 'nite', 'tonite', 'lol', 'idk', 'tbh', 'omg', 'pls', 'plz', 'thx', 'ok', 'yeah', 'yep', 'nah', "ain't",
  'aint', "y'all", 'yall',
]);
const APOSTROPHES = /['’]/g;

/**
 * Casual-mode edits EngLint never shows: the model keeps making them although the prompt says
 * not to (measured by the eval). Wrong-word fixes (were → we're, its → it's) and real typos still pass.
 */
export function isCasualSuppressedEdit(original: string, replacement: string | null): boolean {
  if (replacement === null || original === replacement) return false;
  return (
    isApostropheOrCaseOnly(original, replacement) ||
    isDroppedGRestored(original, replacement) ||
    CHAT_SLANG.has(original.trim().toLowerCase())
  );
}

function isApostropheOrCaseOnly(a: string, b: string): boolean {
  const bare = (s: string) => s.replace(APOSTROPHES, '').toLowerCase();
  if (bare(a) !== bare(b)) return false;
  // Stripping apostrophes leaves whitespace alone, so the words line up.
  const bWords = b.split(/\s+/);
  return !a.split(/\s+/).some((w, i) => w !== bWords[i] && COLLISIONS.has(bare(w)));
}

function isDroppedGRestored(a: string, b: string): boolean {
  const m = /^(\S+)in['’]?$/i.exec(a.trim());
  return m !== null && b.trim().toLowerCase() === `${m[1]}ing`.toLowerCase();
}
