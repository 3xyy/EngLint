// Local statistics for the Review tab's Overview. Nothing here leaves the browser.

export interface DocStats {
  words: number;
  characters: number;
  sentences: number;
  readingSeconds: number;
  speakingSeconds: number;
  avgSentenceWords: number;
  flesch: { score: number; label: string } | null;
  uniquePct: number;
  longPct: number;
}

const READING_WPM = 238;
const SPEAKING_WPM = 183;
/** Flesch reading ease needs enough text to mean anything. */
const FLESCH_MIN_WORDS = 30;
const LONG_WORD_LETTERS = 7;

/** Words: runs of letters, digits and apostrophes (straight or curled), without edge apostrophes. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/[\p{L}\p{N}'’]+/gu) ?? []) {
    const w = run.replace(/^['’]+|['’]+$/g, '');
    if (w !== '') out.push(w);
  }
  return out;
}

/** The words in `text`, counted as the Review tab's Overview counts them: the one word counter the tools share. */
export const countWords = (text: string): number => wordsOf(text).length;

/** Sentences end at . ! or ? followed by whitespace or the end; line breaks also end one. */
function countSentences(text: string): number {
  let n = 0;
  for (const line of text.split(/\r\n|\n|\r/)) {
    for (const part of line.split(/(?<=[.!?])\s+/)) if (/[\p{L}\p{N}]/u.test(part)) n++;
  }
  return n;
}

/**
 * Vowel groups, less a silent final e (but not "le"), a silent final "es" (unless after s, x, z, c, g, ch, sh)
 * and a silent final "ed" (unless after t or d); at least 1.
 */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let n = (w.match(/[aeiouy]+/g) ?? []).length;
  if (/[^l]e$/.test(w)) n--;
  // A consonant before "-les" or "-led" keeps the "-le" syllable (tables, handled), as a final "-le" does.
  else if (/[bcdfgkpstz]l(?:es|ed)$/.test(w)) return Math.max(1, n);
  else if (/es$/.test(w) && !/(?:[sxzcg]|ch|sh)es$/.test(w)) n--;
  else if (/ed$/.test(w) && !/[td]ed$/.test(w)) n--;
  return Math.max(1, n);
}

function fleschLabel(score: number): string {
  if (score >= 90) return 'Very easy';
  if (score >= 80) return 'Easy';
  if (score >= 70) return 'Fairly easy';
  if (score >= 60) return 'Plain English';
  if (score >= 50) return 'Fairly difficult';
  if (score >= 30) return 'Difficult';
  return 'Very difficult';
}

export function docStats(text: string): DocStats {
  const words = wordsOf(text);
  const n = words.length;
  if (n === 0) {
    return { words: 0, characters: text.length, sentences: 0, readingSeconds: 0, speakingSeconds: 0, avgSentenceWords: 0, flesch: null, uniquePct: 0, longPct: 0 };
  }
  const sentences = Math.max(1, countSentences(text));
  let flesch: DocStats['flesch'] = null;
  if (n >= FLESCH_MIN_WORDS) {
    const syl = words.reduce((sum, w) => sum + syllables(w), 0);
    const raw = 206.835 - 1.015 * (n / sentences) - 84.6 * (syl / n);
    const score = Math.min(100, Math.max(0, Math.round(raw)));
    flesch = { score, label: fleschLabel(score) };
  }
  const unique = new Set(words.map((w) => w.toLowerCase())).size;
  const long = words.filter((w) => (w.match(/\p{L}/gu) ?? []).length >= LONG_WORD_LETTERS).length;
  return {
    words: n,
    characters: text.length,
    sentences,
    readingSeconds: Math.round((n / READING_WPM) * 60),
    speakingSeconds: Math.round((n / SPEAKING_WPM) * 60),
    avgSentenceWords: Math.round((n / sentences) * 10) / 10,
    flesch,
    uniquePct: Math.round((unique / n) * 100),
    longPct: Math.round((long / n) * 100),
  };
}

/** "45 sec" under a minute, else whole minutes ("3 min"). */
export function formatDuration(seconds: number): string {
  return seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`;
}
