import { precedingWords } from '../match';
import type { SourcedIssue } from '../sources';
import type { Mode } from '../types';
import {
  BOASTS_NEXT,
  CHATBOT_CLOSERS,
  CHATBOT_COMPLIMENTS,
  CHATBOT_HERE,
  CHATBOT_OPENERS,
  CHATBOT_PHRASES,
  INFLATED_PHRASES,
  NOT_A_SUBJECT,
  PERSONAL_SUBJECTS,
  PLURAL_SUBJECTS,
  ROLE_ADJECTIVES,
  RUNUPS,
  SALES_WORDS,
  SERVES_AS_ADVERBS,
  SERVES_AS_VERBS,
} from './catalogue';

/** A pattern match before it becomes an issue. `term` is what the writer would have to repeat to make it their own. */
interface Hit {
  name: string;
  start: number;
  end: number;
  replacement: string | null;
  term: string;
}

const normalize = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A phrase as a regex source: spaces flexible, either apostrophe. */
const phraseSource = (phrase: string) =>
  phrase
    .split(/\s+/)
    .map((word) => escapeRe(word).replace(/'/g, "['’]"))
    .join('\\s+');
const alternation = (phrases: readonly string[]) =>
  [...phrases].sort((a, b) => b.length - a.length).map(phraseSource).join('|');

const SENTENCE_END = /[.!?]+["”’)]*(?=\s|$)/g;

/** Index just past the sentence that contains `from`, including its closing punctuation. */
function sentenceEnd(text: string, from: number): number {
  SENTENCE_END.lastIndex = from;
  const m = SENTENCE_END.exec(text);
  return m ? m.index + m[0].length : text.length;
}

/** True when only whitespace, or an earlier sentence's end, precedes `index`. */
function opensSentence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  return before.trim() === '' || /[.!?]["”’)]*\s+$/.test(before);
}

/** Ranges inside straight, curled double or curled single quotation marks. An unclosed quote runs to the end. */
function quotedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (open === -1) open = i;
    else {
      ranges.push([open, i + 1]);
      open = -1;
    }
  }
  if (open !== -1) ranges.push([open, text.length]);
  for (const [opener, closer] of [
    ['“', '”'],
    ['‘', '’'],
  ] as const) {
    for (let i = text.indexOf(opener); i !== -1; i = text.indexOf(opener, i + 1)) {
      let j = i + 1;
      // A curled single quote followed by a letter is an apostrophe, not a closing quote.
      while (j < text.length && !(text[j] === closer && !(closer === '’' && /\p{L}/u.test(text[j + 1] ?? '')))) j++;
      ranges.push([i, Math.min(j + 1, text.length)]);
    }
  }
  return ranges;
}

const wordBefore = (text: string, index: number): string =>
  /([\p{L}']+)\s+$/u.exec(text.slice(0, index))?.[1]?.toLowerCase() ?? '';
const wordAfter = (text: string, index: number): string =>
  /^\s+([\p{L}\p{N}']+)/u.exec(text.slice(index))?.[1]?.toLowerCase() ?? '';

/** The words just before `index`, nearest last. */
const wordsBefore = (text: string, index: number, count: number): string[] =>
  (text.slice(0, index).match(/[\p{L}']+/gu) ?? []).slice(-count).map((w) => w.toLowerCase());

function* matches(text: string, source: string): Generator<RegExpExecArray> {
  const re = new RegExp(source, 'giu');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    yield m;
    if (m[0] === '') re.lastIndex++;
  }
}

const LEAD = String.raw`(?<![\p{L}\p{N}'’])`;
const TAIL = String.raw`(?![\p{L}\p{N}])`;

function notXButY(text: string): Hit[] {
  const out: Hit[] = [];
  const add = (m: RegExpExecArray, term: string) =>
    out.push({ name: 'not_x_but_y', start: m.index, end: m.index + m[0].length, replacement: null, term });
  for (const m of matches(text, String.raw`${LEAD}not\s+(?:just|merely|simply)\b[^.!?;\n]{1,100}?,\s*but\b[^.!?;\n]*`))
    add(m, 'not just');
  for (const m of matches(
    text,
    String.raw`${LEAD}(?:it|this|that)(?:['’]s|\s+is|\s+was)\s+not\s+[^.!?;,\n]{1,60}?[,;]\s*(?:it|this|that)(?:['’]s|\s+is|\s+was)\s+(?:about|a|an|the|more|really|simply)\b[^.!?\n]*`,
  ))
    add(m, "it's not");
  for (const m of matches(
    text,
    String.raw`${LEAD}(?:doesn['’]t|does\s+not|didn['’]t|isn['’]t)\s+mean\b[^.!?\n]{1,80}\.\s+(?:it|that|this)\s+means\b[^.!?\n]*`,
  ))
    add(m, "doesn't mean");
  return out;
}

/** Capitalizes the first letter, unless the word already has a capital inside it (iPhone, eBay). */
const capitalize = (s: string) =>
  /^["\u201c\u2018(]*\p{Ll}\p{L}*\p{Lu}/u.test(s) ? s : s.replace(/^(["“‘(]*)(\p{L})/u, (_, lead: string, c: string) => lead + c.toUpperCase());

function runups(text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of matches(text, `${LEAD}(?:${alternation(RUNUPS.map((r) => r.lead))})${TAIL}`)) {
    if (!opensSentence(text, m.index)) continue;
    const entry = RUNUPS.find((r) => normalize(r.lead) === normalize(m[0]));
    const afterLead = m.index + m[0].length;
    const stop = sentenceEnd(text, afterLead);
    const rest = text.slice(afterLead, stop).replace(/^[\s,]+/, '');
    const words = rest.match(/[\p{L}\p{N}'’]+/gu)?.length ?? 0;
    const fixable = entry?.fixable === true && words >= 2 && /^[\p{L}\p{N}"“‘(]/u.test(rest);
    out.push({
      name: 'runup',
      start: m.index,
      end: fixable ? stop : afterLead,
      replacement: fixable ? capitalize(rest) : null,
      term: normalize(m[0]),
    });
  }
  return out;
}

function inflated(text: string): Hit[] {
  const out: Hit[] = [];
  const add = (m: RegExpExecArray) =>
    out.push({ name: 'inflated', start: m.index, end: m.index + m[0].length, replacement: null, term: normalize(m[0]) });
  for (const m of matches(text, `${LEAD}(?:${alternation(INFLATED_PHRASES)})${TAIL}`)) add(m);
  for (const m of matches(text, String.raw`${LEAD}plays?\s+an?\s+(?:${ROLE_ADJECTIVES.join('|')})\s+role${TAIL}`)) add(m);
  return out;
}

function sales(text: string, mode: Mode): Hit[] {
  if (mode === 'casual') return [];
  const out: Hit[] = [];
  const words = alternation(SALES_WORDS.map((w) => w.replace(' ', '-')));
  for (const m of matches(text, String.raw`(?<![\p{L}\p{N}-])(?:${words})${TAIL}`)) {
    // A capitalized word inside a sentence is a name ("the Revolutionary War"), not sales talk.
    if (/^\p{Lu}/u.test(m[0]) && !opensSentence(text, m.index)) continue;
    out.push({ name: 'sales', start: m.index, end: m.index + m[0].length, replacement: null, term: normalize(m[0]) });
  }
  return out;
}

function servesAs(text: string): Hit[] {
  const out: Hit[] = [];
  const add = (m: RegExpExecArray, replacement: string | null) =>
    out.push({ name: 'serves_as', start: m.index, end: m.index + m[0].length, replacement, term: normalize(m[0]) });
  for (const m of matches(text, String.raw`${LEAD}(${SERVES_AS_VERBS.join('|')})\s+as${TAIL}`)) {
    // "stands as tall as": the "as" belongs to a comparison.
    if (/^\s+[\p{L}'-]+\s+as(?![\p{L}])/iu.test(text.slice(m.index + m[0].length))) continue;
    if (wordAfter(text, m.index + m[0].length) === '') continue;
    // "I will serve as the treasurer": a person taking a role.
    if (wordsBefore(text, m.index, 2).some((w) => PERSONAL_SUBJECTS.includes(w))) continue;
    const before = wordBefore(text, m.index);
    // "quietly stands as" → "quietly is" reads badly, so an adverb before the verb leaves it comment-only.
    const adverb = SERVES_AS_ADVERBS.includes(before) || /ly$/.test(before);
    if (/^(?:serves|stands)$/i.test(m[1]!)) {
      add(m, adverb ? null : 'is');
      continue;
    }
    const plural =
      !adverb &&
      (PLURAL_SUBJECTS.includes(before) || (/s$/.test(before) && !/(?:ss|us|is)$/.test(before) && !NOT_A_SUBJECT.includes(before)));
    add(m, plural ? 'are' : null);
  }
  const boastNext = new Set(BOASTS_NEXT);
  for (const m of matches(text, `${LEAD}boasts${TAIL}`)) {
    const next = wordAfter(text, m.index + m[0].length);
    if (boastNext.has(next) || /^\d/.test(next)) add(m, 'has');
  }
  return out;
}

function chatbot(text: string): Hit[] {
  const out: Hit[] = [];
  const add = (m: RegExpExecArray) =>
    out.push({ name: 'chatbot', start: m.index, end: m.index + m[0].length, replacement: null, term: normalize(m[0]) });
  for (const m of matches(text, `${LEAD}(?:${alternation(CHATBOT_PHRASES)})${TAIL}`)) add(m);
  for (const m of matches(text, `${LEAD}(?:${alternation(CHATBOT_COMPLIMENTS)})(?=[!.,])`)) {
    // Mid-paragraph it is more often dialogue ("Great question, said my teacher") than a chatbot's opener.
    if (text.slice(0, m.index).trim() === '') add(m);
  }
  for (const m of matches(text, `${LEAD}(?:${alternation(CHATBOT_CLOSERS)})(?=[!.]*["”)]*\\s*$)`)) add(m);
  for (const m of matches(text, `${LEAD}(?:${alternation(CHATBOT_OPENERS)})!\\s+(?:${alternation(CHATBOT_HERE)})${TAIL}`)) add(m);
  return out;
}

const REASON: Record<string, string> = {
  not_x_but_y: 'A staged contrast.',
  runup: 'An announcement before the point.',
  inflated: 'Claims significance without showing it.',
  sales: 'Sales language.',
  serves_as: 'A fancy stand-in for a plain verb.',
  chatbot: 'Left over from a chatbot answer.',
};

/**
 * Strong generic-phrasing patterns in one paragraph, found locally. Nothing fires inside quotation marks or on
 * a phrase the writer uses three or more times. Patterns are tried in the order listed; where two overlap,
 * the earlier one wins.
 */
export function detectTells(paragraph: string, mode: Mode): SourcedIssue[] {
  const quoted = quotedRanges(paragraph);
  const insideQuote = (hit: Hit) => quoted.some(([a, b]) => hit.start >= a && hit.start < b);
  const hits = [
    ...notXButY(paragraph),
    ...runups(paragraph),
    ...inflated(paragraph),
    ...sales(paragraph, mode),
    ...servesAs(paragraph),
    ...chatbot(paragraph),
  ].filter((h) => !insideQuote(h));
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.term, (counts.get(h.term) ?? 0) + 1);

  const kept: Hit[] = [];
  for (const hit of hits) {
    if ((counts.get(hit.term) ?? 0) >= 3) continue;
    if (kept.some((k) => hit.start < k.end && k.start < hit.end)) continue;
    kept.push(hit);
  }
  return kept
    .sort((a, b) => a.start - b.start)
    .map((h) => ({
      original: paragraph.slice(h.start, h.end),
      replacement: h.replacement,
      before: precedingWords(paragraph, h.start),
      category: 'delivery',
      severity: 'suggestion',
      kind: 'generic_phrasing',
      reason: REASON[h.name] ?? 'Generic phrasing.',
      source: 'tells',
      ruleId: `tell:${h.name}`,
      at: h.start,
    }));
}
