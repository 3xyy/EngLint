// The Citation finder's sources and their formatted citations. Pure: no WXT imports.
//
// A source's URL always comes from a web_search_tool_result block in the response. The model's own text
// only chooses among those URLs and adds a note; a URL it writes that the search didn't return is never kept.
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatFocus } from './chat-format';
import { MAX_CLAIM_CONTEXT_CHARS } from './review';
import { cut } from './review-schema';

export interface Source {
  url: string;
  title: string;
  /** The first passage the model cited from this page, or null. */
  snippet: string | null;
  /** The result's page_age as the search gave it ("April 30, 2025", "3 days ago"), or null. */
  pageAge: string | null;
  /** What the model says this source has to do with the claim, or null. */
  note: string | null;
}

export type CitationStyle = 'mla' | 'apa' | 'chicago';
export const CITATION_STYLES: readonly CitationStyle[] = ['mla', 'apa', 'chicago'];

/** The line the model writes before its JSON list of chosen sources. */
export const SOURCES_SENTINEL = '@@SOURCES@@';
export const MAX_SOURCES = 4;
/** With nothing chosen or cited, this many of the first results are shown. */
export const FALLBACK_SOURCES = 3;
export const MAX_NOTE_CHARS = 240;

/** A URL with its fragment and one trailing slash dropped, for comparing the model's URLs with the results'. */
export function normalizeUrl(url: string): string {
  const hash = url.indexOf('#');
  const bare = (hash === -1 ? url : url.slice(0, hash)).trim();
  return bare.endsWith('/') ? bare.slice(0, -1) : bare;
}

/** Whether `url` is an http(s) address: the only kind shown as a link. */
export const isWebUrl = (url: string) => /^https?:\/\//i.test(url.trim());

interface Result {
  url: string;
  title: string;
  pageAge: string | null;
}

/**
 * The JSON array that starts at the first `[` of `rest`, up to its own closing bracket (brackets inside strings
 * don't count), so text after the list such as "See [1]." leaves it intact. Null when it never closes.
 */
function firstArray(rest: string): string | null {
  const open = rest.indexOf('[');
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < rest.length; i++) {
    const c = rest[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return rest.slice(open, i + 1);
  }
  return null;
}

/** The model's list after the sentinel, as parsed, or null when there is no sentinel or no well-formed JSON array. */
function listAfterSentinel(text: string): unknown[] | null {
  const at = text.lastIndexOf(SOURCES_SENTINEL);
  if (at === -1) return null;
  const json = firstArray(text.slice(at + SOURCES_SENTINEL.length));
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

/** Web addresses in a note: one in parentheses (with them), or any http(s):// or www. token. */
const NOTE_URLS = [/\s*\((?:https?:\/\/|www\.)[^\s)]*\)/gi, /\b(?:https?:\/\/|www\.)\S+/gi];

/**
 * A note as shown: web addresses taken out (a note never shows a URL, which might be one the search didn't
 * return), spaces tidied, cut to MAX_NOTE_CHARS. Null when nothing is left.
 */
function cleanNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  let t = note;
  for (const re of NOTE_URLS) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
  return t === '' ? null : cut(t, MAX_NOTE_CHARS);
}

/**
 * The sources to show from a web search response:
 * - the entries the model listed after the sentinel whose URL (normalized) is one the search returned;
 * - none when that list is empty: the model found nothing relevant;
 * - else (no sentinel, malformed JSON, or every entry dropped) the returned URLs the model cited, in citation order;
 * - else the first 3 results, with no note.
 * At most 4, each URL once. A search error block, or a result that isn't an http(s) URL, contributes nothing.
 */
export function sourcesFromResponse(content: Anthropic.ContentBlock[]): Source[] {
  const results = new Map<string, Result>();
  const snippets = new Map<string, string>();
  const citedOrder: string[] = [];
  let text = '';

  for (const block of content) {
    if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) continue; // web_search_tool_result_error
      for (const r of block.content) {
        if (r.type !== 'web_search_result' || typeof r.url !== 'string' || !isWebUrl(r.url)) continue;
        const key = normalizeUrl(r.url);
        if (!results.has(key)) results.set(key, { url: r.url, title: typeof r.title === 'string' ? r.title : '', pageAge: r.page_age ?? null });
      }
    } else if (block.type === 'text') {
      // Citations split the model's prose into many text blocks; the sentinel can land anywhere in them.
      text += block.text;
      for (const c of block.citations ?? []) {
        if (c.type !== 'web_search_result_location' || typeof c.url !== 'string') continue;
        const key = normalizeUrl(c.url);
        if (!snippets.has(key) && typeof c.cited_text === 'string' && c.cited_text.trim() !== '') snippets.set(key, c.cited_text.trim());
        if (!citedOrder.includes(key)) citedOrder.push(key);
      }
    }
  }

  const source = (key: string, note: unknown): Source => {
    const r = results.get(key)!;
    return { url: r.url, title: r.title, snippet: snippets.get(key) ?? null, pageAge: r.pageAge, note: cleanNote(note) };
  };

  const chosen: Source[] = [];
  const seen = new Set<string>();
  const listed = listAfterSentinel(text);
  if (listed !== null && listed.length === 0) return [];
  for (const e of listed ?? []) {
    if (typeof e !== 'object' || e === null || typeof (e as { url?: unknown }).url !== 'string') continue;
    const key = normalizeUrl((e as { url: string }).url);
    if (chosen.length >= MAX_SOURCES || seen.has(key) || !results.has(key)) continue;
    seen.add(key);
    chosen.push(source(key, (e as { note?: unknown }).note));
  }
  if (chosen.length > 0) return chosen;

  const cited = citedOrder.filter((key) => results.has(key)).slice(0, MAX_SOURCES);
  if (cited.length > 0) return cited.map((key) => source(key, null));

  return [...results.keys()].slice(0, FALLBACK_SOURCES).map((key) => source(key, null));
}

// ---- formatted citations ----

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** MLA's month forms: months of five letters or more are abbreviated (Sept. for September). */
const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

interface Day {
  year: number;
  /** 0–11. */
  month: number;
  day: number;
}

const dayOf = (d: Date): Day => ({ year: d.getFullYear(), month: d.getMonth(), day: d.getDate() });

/** A month name or abbreviation of three letters or more ("Apr", "Sept", "April") as 0–11, or -1. */
function monthIndex(name: string): number {
  const n = name.toLowerCase();
  return n.length < 3 ? -1 : MONTHS.findIndex((m) => m.toLowerCase().startsWith(n));
}

/** The day, or null when the month has no such day. */
function realDay(year: number, month: number, day: number): Day | null {
  if (month < 0) return null;
  const check = new Date(year, month, day);
  return check.getFullYear() === year && check.getMonth() === month && check.getDate() === day ? { year, month, day } : null;
}

/**
 * The calendar day a page age names, as written, or null. Only a date with an explicit day counts: an ISO date
 * (2025-04-30, any time after it ignored), "April 30, 2025" or "30 April 2025" (months may be abbreviated, a
 * weekday may come first, and a time may follow, as in "Wed, 30 Apr 2025 03:00:00 GMT"). Nothing goes through
 * Date.parse, so no time zone moves the day. "May 2019", "2019-05", "3 days ago" and years before 1990 give null.
 */
function pageDay(pageAge: string | null): Day | null {
  if (!pageAge) return null;
  const s = pageAge.trim().replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
  let day: Day | null = null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?![\d-])/.exec(s);
  const mdy = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/i.exec(s);
  const dmy = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})(?!\d)/i.exec(s);
  if (iso) day = realDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  else if (mdy) day = realDay(Number(mdy[3]), monthIndex(mdy[1]!), Number(mdy[2]));
  else if (dmy) day = realDay(Number(dmy[3]), monthIndex(dmy[2]!), Number(dmy[1]));
  return day && day.year >= 1990 ? day : null;
}

const mlaDate = (d: Day) => `${d.day} ${MLA_MONTHS[d.month]} ${d.year}`;
const longDate = (d: Day) => `${MONTHS[d.month]} ${d.day}, ${d.year}`;
const apaDate = (d: Day) => `${d.year}, ${MONTHS[d.month]} ${d.day}`;

/** The host without "www.", or the URL itself when it doesn't parse. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

/** The title followed by a period, unless it already ends in one, or in ? or !. */
const titled = (title: string) => (/[.?!]$/.test(title) ? title : `${title}.`);

/**
 * A citation for `source` in `style`. There is no author (the search gives none, and none is invented); the
 * site is the host without "www."; the date is the page age's day, when it names one. `accessed` is the day the
 * search ran, in local time.
 */
export function formatCitation(style: CitationStyle, source: Source, accessed: Date): string {
  const site = siteOf(source.url);
  const title = source.title.trim() || site;
  const day = pageDay(source.pageAge);
  const seen = dayOf(accessed);
  switch (style) {
    case 'mla': {
      const bare = source.url.replace(/^https?:\/\//i, '');
      return `“${titled(title)}” ${site}, ${day ? `${mlaDate(day)}, ` : ''}${bare}. Accessed ${mlaDate(seen)}.`;
    }
    case 'apa':
      return `${titled(title)} (${day ? apaDate(day) : 'n.d.'}). ${site}. ${source.url}`;
    case 'chicago':
      return `“${titled(title)}” ${site}. ${day ? `Last modified ${longDate(day)}` : `Accessed ${longDate(seen)}`}. ${source.url}.`;
  }
}

// ---- the claim ----

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

/**
 * The selected claim, trimmed, and up to MAX_CLAIM_CONTEXT_CHARS of the text on each side of it; null with no
 * selection (a caret, or only spaces selected). The context never starts or ends inside a surrogate pair.
 */
export function claimAround(text: string, focus: ChatFocus): { claim: string; before: string; after: string } | null {
  if (!focus || focus.end <= focus.start) return null;
  const raw = text.slice(focus.start, focus.end);
  const claim = raw.trim();
  if (claim === '') return null;
  const start = focus.start + (raw.length - raw.trimStart().length);
  const end = start + claim.length;
  let before = text.slice(Math.max(0, start - MAX_CLAIM_CONTEXT_CHARS), start);
  if (before.length > 0 && isLow(before.charCodeAt(0))) before = before.slice(1);
  let after = text.slice(end, end + MAX_CLAIM_CONTEXT_CHARS);
  if (after.length > 0 && isHigh(after.charCodeAt(after.length - 1))) after = after.slice(0, -1);
  return { claim, before, after };
}
