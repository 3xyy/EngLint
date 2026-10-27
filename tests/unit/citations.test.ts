import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { claimAround, formatCitation, normalizeUrl, sourcesFromResponse, type Source } from '../../src/core/citations';

// Hand-built web search responses, in the shapes the Messages API returns them.
const result = (url: string, title: string, page_age: string | null = null) => ({ type: 'web_search_result', url, title, page_age, encrypted_content: 'enc' });
const results = (...content: unknown[]) => ({ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', caller: { type: 'direct' }, content });
const searchError = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', caller: { type: 'direct' }, content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } };
const cite = (url: string, cited_text: string) => ({ type: 'web_search_result_location', url, title: 'cited title', cited_text, encrypted_index: 'i' });
const text = (t: string, citations: unknown[] | null = null) => ({ type: 'text', text: t, citations });
const search = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'sleep memory' }, caller: { type: 'direct' } };
const blocks = (...b: unknown[]) => b as Anthropic.ContentBlock[];
const sentinel = (entries: unknown) => text(`\n@@SOURCES@@\n${JSON.stringify(entries)}`);

const A = 'https://a.example.org/study';
const B = 'https://b.example.org/report';
const C = 'https://c.example.org/page';
const MADE_UP = 'https://made-up.example/x';
const RESULTS = results(result(A, 'Study A', 'April 30, 2025'), result(B, 'Report B', '2 days ago'), result(C, 'Page C'));
const PROSE = [
  text("I'll look for sources."),
  search,
  RESULTS,
  text('A study found the effect.', [cite(A, 'Sleep doubled recall.')]),
  text(' A report agrees.', [cite(B, 'Recall rose after sleep.')]),
];

describe('sourcesFromResponse', () => {
  it('keeps only sentinel entries whose URL came back in the results; a made-up URL never appears', () => {
    const out = sourcesFromResponse(blocks(...PROSE, sentinel([{ url: A, note: 'Supports it.' }, { url: MADE_UP, note: 'Invented.' }])));
    expect(out).toEqual<Source[]>([{ url: A, title: 'Study A', snippet: 'Sleep doubled recall.', pageAge: 'April 30, 2025', note: 'Supports it.' }]);
  });

  it('keeps both listed result URLs with their titles, snippets and page ages', () => {
    const out = sourcesFromResponse(
      blocks(...PROSE, sentinel([{ url: A, note: 'Supports it.' }, { url: MADE_UP, note: 'Invented.' }, { url: B, note: 'Agrees.' }])),
    );
    expect(out).toEqual<Source[]>([
      { url: A, title: 'Study A', snippet: 'Sleep doubled recall.', pageAge: 'April 30, 2025', note: 'Supports it.' },
      { url: B, title: 'Report B', snippet: 'Recall rose after sleep.', pageAge: '2 days ago', note: 'Agrees.' },
    ]);
    expect(JSON.stringify(out)).not.toContain('made-up');
  });

  it('gives a listed result with no citation a null snippet', () => {
    const out = sourcesFromResponse(blocks(...PROSE, sentinel([{ url: C, note: 'Background.' }])));
    expect(out).toEqual<Source[]>([{ url: C, title: 'Page C', snippet: null, pageAge: null, note: 'Background.' }]);
  });

  it('takes the snippet from the first citation of a URL', () => {
    const out = sourcesFromResponse(blocks(...PROSE, text('More.', [cite(A, 'A later quote.')]), sentinel([{ url: A, note: 'n' }])));
    expect(out[0]!.snippet).toBe('Sleep doubled recall.');
  });

  it('finds the sentinel when it is split across text blocks, and inside a code fence', () => {
    const split = sourcesFromResponse(blocks(...PROSE, text('\n@@SOUR'), text(`CES@@\n[{"url":"${B}","note":"Agrees."}]`)));
    expect(split.map((s) => s.url)).toEqual([B]);
    const fenced = sourcesFromResponse(blocks(...PROSE, text(`\n@@SOURCES@@\n\`\`\`json\n[{"url":"${B}","note":"Agrees."}]\n\`\`\``)));
    expect(fenced.map((s) => [s.url, s.note])).toEqual([[B, 'Agrees.']]);
  });

  it('without the sentinel, keeps the cited result URLs in citation order, with no note', () => {
    const out = sourcesFromResponse(
      blocks(search, RESULTS, text('One.', [cite(B, 'Recall rose after sleep.')]), text('Two.', [cite(A, 'Sleep doubled recall.'), cite(B, 'again')])),
    );
    expect(out).toEqual<Source[]>([
      { url: B, title: 'Report B', snippet: 'Recall rose after sleep.', pageAge: '2 days ago', note: null },
      { url: A, title: 'Study A', snippet: 'Sleep doubled recall.', pageAge: 'April 30, 2025', note: null },
    ]);
  });

  it('reads an empty list after the sentinel as none, even when the search returned and cited pages', () => {
    expect(sourcesFromResponse(blocks(...PROSE, sentinel([])))).toEqual([]);
    expect(sourcesFromResponse(blocks(...PROSE, text('\n@@SOURCES@@\n[ ]\nNothing here supports it.')))).toEqual([]);
  });

  it('falls back to the cited URLs when nothing in the sentinel list survives, or it is not JSON', () => {
    expect(sourcesFromResponse(blocks(...PROSE, sentinel([{ url: MADE_UP, note: 'x' }]))).map((s) => s.url)).toEqual([A, B]);
    expect(sourcesFromResponse(blocks(...PROSE, sentinel([{ note: 'no url' }, null]))).map((s) => s.url)).toEqual([A, B]);
    expect(sourcesFromResponse(blocks(...PROSE, text('\n@@SOURCES@@\n[{"url": "https://a.exa'))).map((s) => s.url)).toEqual([A, B]);
    expect(sourcesFromResponse(blocks(...PROSE, text('\n@@SOURCES@@\n{"url": "x"}'))).map((s) => s.url)).toEqual([A, B]);
  });

  it('reads the list up to its own closing bracket: a bracket in a note, or text after the list, does not break it', () => {
    const after = sourcesFromResponse(blocks(...PROSE, text(`\n@@SOURCES@@\n[{"url":"${B}","note":"Agrees [strongly], \\"really]\\"."}]\nSee [1].`)));
    expect(after.map((s) => [s.url, s.note])).toEqual([[B, 'Agrees [strongly], "really]".']]);
    const nested = sourcesFromResponse(blocks(...PROSE, text(`\n@@SOURCES@@\n[{"url":"${C}","note":"n","tags":[1,[2]]}] (end)`)));
    expect(nested.map((s) => [s.url, s.note])).toEqual([[C, 'n']]);
  });

  it('never keeps a cited URL that is not among the results', () => {
    const out = sourcesFromResponse(blocks(RESULTS, text('One.', [cite(MADE_UP, 'invented'), cite(C, 'from C')])));
    expect(out.map((s) => s.url)).toEqual([C]);
  });

  it('with nothing cited, keeps the first 3 results with no note and no snippet', () => {
    const four = results(result(A, 'Study A'), result(B, 'Report B'), result(C, 'Page C'), result('https://d.example.org/', 'Page D'));
    const out = sourcesFromResponse(blocks(search, four, text('Nothing fits.')));
    expect(out).toEqual<Source[]>([
      { url: A, title: 'Study A', snippet: null, pageAge: null, note: null },
      { url: B, title: 'Report B', snippet: null, pageAge: null, note: null },
      { url: C, title: 'Page C', snippet: null, pageAge: null, note: null },
    ]);
  });

  it('ignores a search error block, and gives nothing when there are no results', () => {
    expect(sourcesFromResponse(blocks(search, searchError, ...PROSE.slice(2), sentinel([{ url: A, note: 'n' }]))).map((s) => s.url)).toEqual([A]);
    expect(sourcesFromResponse(blocks(search, searchError, text('Search failed.'), sentinel([{ url: A, note: 'n' }])))).toEqual([]);
    expect(sourcesFromResponse(blocks(text('No search.')))).toEqual([]);
  });

  it('matches a URL with a fragment or trailing slash, and shows the URL as the results gave it', () => {
    const out = sourcesFromResponse(blocks(results(result('https://x.org/a/#s', 'X')), sentinel([{ url: 'https://x.org/a', note: 'n' }])));
    // The note shows the sentinel entry matched (the first-results fallback would give no note).
    expect(out.map((s) => [s.url, s.note])).toEqual([['https://x.org/a/#s', 'n']]);
  });

  it('keeps at most 4 sources, each once', () => {
    const urls = ['1', '2', '3', '4', '5'].map((n) => `https://s${n}.example.org/`);
    const many = results(...urls.map((u, i) => result(u, `S${i + 1}`)));
    const out = sourcesFromResponse(blocks(many, sentinel([urls[0], urls[0], ...urls.slice(1)].map((url) => ({ url, note: 'n' })))));
    expect(out.map((s) => s.url)).toEqual(urls.slice(0, 4));
    const cited = sourcesFromResponse(blocks(many, text('All.', urls.map((u) => cite(u, 'q')))));
    expect(cited).toHaveLength(4);
  });

  it('keeps the first result for a URL that came back twice', () => {
    const out = sourcesFromResponse(blocks(results(result(A, 'First')), results(result(A, 'Second')), sentinel([{ url: A, note: 'n' }])));
    expect(out.map((s) => s.title)).toEqual(['First']);
  });

  it('takes web addresses out of a note, and reads a note that was only an address as none', () => {
    const notes = (...n: string[]) =>
      sourcesFromResponse(blocks(...PROSE, sentinel([{ url: A, note: n[0] }, { url: B, note: n[1] }, { url: C, note: n[2] }]))).map((s) => s.note);
    expect(notes('Supports it (https://evil.example/x).', 'Agrees, per http://a.b/c and www.fake.org/page today.', 'https://only.example/')).toEqual([
      'Supports it.',
      'Agrees, per and today.',
      null,
    ]);
    expect(notes('Wwww.nope is a word, as is awww.', 'Fine.', 'Fine.')[0]).toBe('Wwww.nope is a word, as is awww.');
  });

  it('cuts a note over 240 characters, and reads a blank or missing note as none', () => {
    const long = 'n'.repeat(300);
    const out = sourcesFromResponse(blocks(...PROSE, sentinel([{ url: A, note: long }, { url: B, note: '   ' }, { url: C }])));
    expect(out[0]!.note).toHaveLength(240);
    expect(out[0]!.note!.endsWith('…')).toBe(true);
    expect(out[1]!.note).toBeNull();
    expect(out[2]!.note).toBeNull();
    expect(sourcesFromResponse(blocks(...PROSE, sentinel([{ url: A, note: 'n'.repeat(240) }])))[0]!.note).toBe('n'.repeat(240));
  });

  it('skips entries without a string URL', () => {
    const out = sourcesFromResponse(blocks(...PROSE, sentinel([{ note: 'no url' }, { url: 5 }, 'text', null, { url: B, note: 'n' }])));
    expect(out.map((s) => s.url)).toEqual([B]);
  });

  it('never shows a result whose URL is not http or https', () => {
    const bad = results(result('javascript:alert(1)', 'Bad'), result('data:text/html,hi', 'Data'), result(A, 'Study A'));
    expect(sourcesFromResponse(blocks(bad, sentinel([{ url: 'javascript:alert(1)', note: 'n' }, { url: A, note: 'n' }]))).map((s) => s.url)).toEqual([A]);
    expect(sourcesFromResponse(blocks(bad, text('none'))).map((s) => s.url)).toEqual([A]);
  });
});

describe('normalizeUrl', () => {
  it('drops the fragment and a trailing slash, and nothing else', () => {
    expect(normalizeUrl('https://x.org/a/#s')).toBe('https://x.org/a');
    expect(normalizeUrl('https://x.org/a/')).toBe('https://x.org/a');
    expect(normalizeUrl('https://x.org/a#s')).toBe('https://x.org/a');
    expect(normalizeUrl('https://x.org/a?q=1#f')).toBe('https://x.org/a?q=1');
    expect(normalizeUrl('https://x.org/')).toBe('https://x.org');
    expect(normalizeUrl(' https://x.org/A ')).toBe('https://x.org/A');
  });
});

describe('formatCitation', () => {
  const accessed = new Date(2026, 9, 25);
  const SRC: Source = { url: 'https://www.example.org/sleep/memory-study', title: 'Sleep Strengthens Memory', snippet: null, pageAge: 'April 30, 2025', note: null };
  const undated: Source = { ...SRC, pageAge: null };

  it('MLA, with and without a date', () => {
    expect(formatCitation('mla', SRC, accessed)).toBe(
      '“Sleep Strengthens Memory.” example.org, 30 Apr. 2025, www.example.org/sleep/memory-study. Accessed 25 Oct. 2026.',
    );
    expect(formatCitation('mla', undated, accessed)).toBe('“Sleep Strengthens Memory.” example.org, www.example.org/sleep/memory-study. Accessed 25 Oct. 2026.');
  });

  it('APA, with and without a date', () => {
    expect(formatCitation('apa', SRC, accessed)).toBe('Sleep Strengthens Memory. (2025, April 30). example.org. https://www.example.org/sleep/memory-study');
    expect(formatCitation('apa', undated, accessed)).toBe('Sleep Strengthens Memory. (n.d.). example.org. https://www.example.org/sleep/memory-study');
  });

  it('Chicago, with and without a date', () => {
    expect(formatCitation('chicago', SRC, accessed)).toBe(
      '“Sleep Strengthens Memory.” example.org. Last modified April 30, 2025. https://www.example.org/sleep/memory-study.',
    );
    expect(formatCitation('chicago', undated, accessed)).toBe(
      '“Sleep Strengthens Memory.” example.org. Accessed October 25, 2026. https://www.example.org/sleep/memory-study.',
    );
  });

  it('adds no period after a title ending in ?, ! or .', () => {
    const q = { ...SRC, title: 'Does Sleep Help Memory?' };
    expect(formatCitation('mla', q, accessed)).toBe('“Does Sleep Help Memory?” example.org, 30 Apr. 2025, www.example.org/sleep/memory-study. Accessed 25 Oct. 2026.');
    expect(formatCitation('apa', q, accessed)).toBe('Does Sleep Help Memory? (2025, April 30). example.org. https://www.example.org/sleep/memory-study');
    expect(formatCitation('chicago', q, accessed)).toBe('“Does Sleep Help Memory?” example.org. Last modified April 30, 2025. https://www.example.org/sleep/memory-study.');
    expect(formatCitation('apa', { ...SRC, title: 'Sleep Now!' }, accessed)).toMatch(/^Sleep Now! \(2025/);
    expect(formatCitation('apa', { ...SRC, title: 'Sleep, Inc.' }, accessed)).toMatch(/^Sleep, Inc\. \(2025/);
  });

  it('treats a relative page age such as "3 days ago" as no date', () => {
    const rel = { ...SRC, pageAge: '3 days ago' };
    expect(formatCitation('apa', rel, accessed)).toContain('(n.d.)');
    expect(formatCitation('chicago', rel, accessed)).toContain('Accessed October 25, 2026.');
    expect(formatCitation('mla', rel, accessed)).toBe(formatCitation('mla', undated, accessed));
  });

  it('needs a four-digit year from 1990 on: "Mar 5" and a 1985 date are no date', () => {
    expect(formatCitation('apa', { ...SRC, pageAge: 'Mar 5' }, accessed)).toContain('(n.d.)');
    expect(formatCitation('apa', { ...SRC, pageAge: 'June 2, 1985' }, accessed)).toContain('(n.d.)');
    expect(formatCitation('apa', { ...SRC, pageAge: 'June 2, 1990' }, accessed)).toContain('(1990, June 2)');
  });

  it('reads an ISO date as the day it names, in any time zone', () => {
    expect(formatCitation('apa', { ...SRC, pageAge: '2025-04-30' }, accessed)).toContain('(2025, April 30)');
    expect(formatCitation('apa', { ...SRC, pageAge: '2025-04-30T23:30:00Z' }, accessed)).toContain('(2025, April 30)');
    // Read through Date.parse, this is 1 May in UTC and east of it.
    expect(formatCitation('apa', { ...SRC, pageAge: '2025-04-30T23:30:00-08:00' }, accessed)).toContain('(2025, April 30)');
  });

  it('keeps a date written with its day: Month D, YYYY; D Month YYYY; an optional weekday; abbreviated months', () => {
    for (const pageAge of ['April 30, 2025', 'Apr 30, 2025', 'Apr. 30, 2025', 'april 30th, 2025', '30 April 2025', '30 Apr. 2025', 'Wednesday, April 30, 2025', 'Wed 30 Apr 2025']) {
      expect(formatCitation('apa', { ...SRC, pageAge }, accessed), pageAge).toContain('(2025, April 30)');
    }
    expect(formatCitation('mla', { ...SRC, pageAge: 'Sept. 12, 2024' }, accessed)).toContain(', 12 Sept. 2024,');
  });

  it('reads an RFC-style date as the day it writes, whatever the hour and time zone', () => {
    // Through Date.parse these land on 29 April west of UTC and on 1 May east of it.
    expect(formatCitation('apa', { ...SRC, pageAge: 'Wed, 30 Apr 2025 03:00:00 GMT' }, accessed)).toContain('(2025, April 30)');
    expect(formatCitation('apa', { ...SRC, pageAge: 'Wed, 30 Apr 2025 23:00:00 GMT' }, accessed)).toContain('(2025, April 30)');
  });

  it('gives no date without an explicit day: month and year, year and month, a season, a bare year, or a day that does not exist', () => {
    for (const pageAge of ['May 2019', '2019-05', 'Spring 2020', '2019', 'February 30, 2024', '2024-02-30', '31 June 2024', 'Marchy 3, 2024']) {
      expect(formatCitation('apa', { ...SRC, pageAge }, accessed), pageAge).toContain('(n.d.)');
    }
  });

  it("uses MLA's month forms: May, June and July in full, Sept. for September", () => {
    expect(formatCitation('mla', { ...SRC, pageAge: '2025-05-04' }, accessed)).toContain(', 4 May 2025,');
    expect(formatCitation('mla', { ...SRC, pageAge: '2025-06-04' }, accessed)).toContain(', 4 June 2025,');
    expect(formatCitation('mla', { ...SRC, pageAge: '2024-09-12' }, accessed)).toContain(', 12 Sept. 2024,');
  });

  it('names the site by its host without www., and an http URL keeps no scheme in MLA', () => {
    const plain = { ...SRC, url: 'http://news.example.com/a', pageAge: null };
    expect(formatCitation('mla', plain, accessed)).toBe('“Sleep Strengthens Memory.” news.example.com, news.example.com/a. Accessed 25 Oct. 2026.');
  });

  it('uses the site as the title when the title is blank', () => {
    expect(formatCitation('apa', { ...SRC, title: '  ' }, accessed)).toMatch(/^example\.org\. \(2025, April 30\)\. example\.org\./);
  });
});

describe('claimAround', () => {
  it('is null with no selection, a caret or only spaces selected', () => {
    expect(claimAround('Some text here.', null)).toBeNull();
    expect(claimAround('Some text here.', { start: 4, end: 4 })).toBeNull();
    expect(claimAround('Some    text', { start: 5, end: 7 })).toBeNull();
  });

  it('trims the claim and takes the text on each side of it', () => {
    const t = 'Intro. The sky is blue on clear days. Outro.';
    const start = t.indexOf(' The sky');
    const end = t.indexOf(' Outro') + 1;
    expect(claimAround(t, { start, end })).toEqual({ claim: 'The sky is blue on clear days.', before: 'Intro. ', after: ' Outro.' });
  });

  it('keeps at most 300 characters on each side', () => {
    const t = `${'a'.repeat(400)}The claim itself.${'b'.repeat(400)}`;
    const r = claimAround(t, { start: 400, end: 417 })!;
    expect(r.claim).toBe('The claim itself.');
    expect(r.before).toBe('a'.repeat(300));
    expect(r.after).toBe('b'.repeat(300));
  });

  it('never starts or ends the context inside a surrogate pair', () => {
    const emoji = '😀';
    // The 300th character before the claim is the second half of the emoji: the context starts after it.
    const t = `${emoji}${'a'.repeat(299)}The claim itself.`;
    expect(claimAround(t, { start: 301, end: t.length })!.before).toBe('a'.repeat(299));
    // A whole emoji just inside the limit is kept.
    const whole = `${'a'.repeat(298)}${emoji}The claim itself.`;
    expect(claimAround(whole, { start: 300, end: whole.length })!.before).toBe(`${'a'.repeat(298)}${emoji}`);
    // The 300th character after the claim is the first half of an emoji: the context stops before it.
    const t3 = `The claim itself.${'b'.repeat(299)}${emoji}`;
    expect(claimAround(t3, { start: 0, end: 17 })!.after).toBe('b'.repeat(299));
  });
});
