import { describe, expect, it } from 'vitest';
import { DEEP_CHECK_JSON_SCHEMA, IssueSchema, LIVE_CHECK_JSON_SCHEMA, parseDeepCheckOutput } from '../../src/core/schema';

const issue = (category: string) => ({ original: 'a', replacement: null, before: '', category, severity: 'suggestion', kind: 'hedging', reason: 'r' });

describe('IssueSchema categories', () => {
  it('accepts engagement and delivery', () => {
    expect(IssueSchema.safeParse(issue('engagement')).success).toBe(true);
    expect(IssueSchema.safeParse(issue('delivery')).success).toBe(true);
  });
  it('still rejects tone', () => {
    expect(IssueSchema.safeParse(issue('tone')).success).toBe(false);
  });
  it('sends the new categories in the JSON schema', () => {
    expect(JSON.stringify(LIVE_CHECK_JSON_SCHEMA)).toContain('"delivery"');
  });
  it('lists kind before category, so the model names the kind before it picks a family', () => {
    type Obj = { properties: Record<string, Obj>; items: Obj };
    const issue = (LIVE_CHECK_JSON_SCHEMA as unknown as Obj).properties.results!.items.properties.issues!.items;
    const keys = Object.keys(issue.properties);
    expect(keys).toContain('kind');
    expect(keys.indexOf('kind')).toBeLessThan(keys.indexOf('category'));
  });
});

describe('parseDeepCheckOutput', () => {
  const good = { original: 'teh', replacement: 'the', before: '', category: 'spelling', severity: 'error', kind: 'spelling', reason: 'r' };
  const note = (over: Record<string, unknown> = {}) => ({ type: 'overused_word', text: 'You lean on "very".', quotes: ['very good'], count: 6, ...over });
  const parse = (over: Record<string, unknown> = {}) =>
    parseDeepCheckOutput({ results: [{ paragraph_id: 'p0', issues: [good] }], notes: [note()], ...over });

  it('accepts results plus notes', () => {
    const { output, droppedInvalid } = parse();
    expect(output.results[0]!.issues).toEqual([good]);
    expect(output.notes).toEqual([note()]);
    expect(droppedInvalid).toBe(0);
  });
  it('drops an invalid issue and counts it', () => {
    const { output, droppedInvalid } = parse({ results: [{ paragraph_id: 'p0', issues: [good, { ...good, category: 'tone' }] }] });
    expect(output.results[0]!.issues).toEqual([good]);
    expect(droppedInvalid).toBe(1);
  });
  it('drops a note with an invalid type and keeps the rest', () => {
    const { output } = parse({ notes: [note({ type: 'vibes' }), note({ type: 'tense_shift' })] });
    expect(output.notes.map((n) => n.type)).toEqual(['tense_shift']);
  });
  it('cuts note text at 300 characters', () => {
    const { output } = parse({ notes: [note({ text: 'x'.repeat(400) })] });
    expect(output.notes[0]!.text).toHaveLength(300);
  });
  it('keeps at most 8 notes and 3 quotes each', () => {
    const { output } = parse({ notes: Array.from({ length: 10 }, () => note({ quotes: ['a b', 'c d', 'e f', 'g h'] })) });
    expect(output.notes).toHaveLength(8);
    expect(output.notes[0]!.quotes).toEqual(['a b', 'c d', 'e f']);
  });
  it('cuts a quote at 200 characters', () => {
    const { output } = parse({ notes: [note({ quotes: ['q'.repeat(300)] })] });
    expect(output.notes[0]!.quotes[0]).toHaveLength(200);
  });
  it('drops a note with no text', () => {
    expect(parse({ notes: [note({ text: '   ' }), note()] }).output.notes).toHaveLength(1);
  });
  it('keeps a count only for an overused word, and only when it is at least 1', () => {
    const counts = parse({
      notes: [note({ count: 0 }), note({ count: -2 }), note({ type: 'tense_shift', count: 4 }), note({ count: 3 })],
    }).output.notes.map((n) => n.count);
    expect(counts).toEqual([null, null, null, 3]);
  });
  it('gives count null when it is missing', () => {
    const { count: _, ...noCount } = note();
    expect(parse({ notes: [noCount] }).output.notes[0]!.count).toBeNull();
  });
  describe('in Essay, a note drops only the long quoted passage that is missing from the text', () => {
    const passage = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const DOC = 'I went to the market. It was very good and very loud.';
    const essay = { text: DOC, mode: 'essay' } as const;
    const smuggled = note({ type: 'ambiguous', text: `The opening drifts. Rewrite it as "${passage}" to land harder.`, count: null });

    it('keeps the text around the passage and puts an ellipsis where it was', () => {
      const { output } = parseDeepCheckOutput({ results: [], notes: [smuggled, note()] }, essay);
      expect(output.notes[0]!.text).toBe('The opening drifts. Rewrite it as … to land harder.');
      expect(output.notes[1]).toEqual(note());
    });

    it('drops a note that is only the passage, or has fewer than 3 words left', () => {
      const only = note({ text: `\u201c${passage}\u201d` });
      const short = note({ text: `Try "${passage}".` });
      expect(parseDeepCheckOutput({ results: [], notes: [only, short, note()] }, essay).output.notes).toEqual([note()]);
    });

    it('keeps it outside Essay, with no guard given, and when the passage is in the text', () => {
      expect(parseDeepCheckOutput({ results: [], notes: [smuggled] }, { text: DOC, mode: 'standard' }).output.notes[0]!.text).toContain(passage);
      expect(parseDeepCheckOutput({ results: [], notes: [smuggled] }).output.notes[0]!.text).toContain(passage);
      expect(parseDeepCheckOutput({ results: [], notes: [smuggled] }, { text: `${DOC} ${passage}`, mode: 'essay' }).output.notes[0]!.text).toContain(passage);
    });

    it('strips the passage from the whole note before cutting it at 300 characters', () => {
      const quote = Array.from({ length: 20 }, (_, i) => `rewrite${i}`).join(' ');
      const text = `${'a'.repeat(280)} "${quote}" and more.`;
      const kept = parseDeepCheckOutput({ results: [], notes: [note({ text })] }, essay).output.notes[0]!.text;
      expect(kept).toBe(`${'a'.repeat(280)} … and more.`);
      expect(parseDeepCheckOutput({ results: [], notes: [note({ text })] }, { text: DOC, mode: 'standard' }).output.notes[0]!.text).toHaveLength(300);
    });
  });

  it('treats a missing notes list as none, and rejects a wrong top-level shape', () => {
    expect(parseDeepCheckOutput({ results: [] }).output.notes).toEqual([]);
    expect(() => parseDeepCheckOutput({ nope: 1 })).toThrow();
  });
});

describe('DEEP_CHECK_JSON_SCHEMA', () => {
  it('has no $schema and keeps the enums', () => {
    expect(DEEP_CHECK_JSON_SCHEMA).not.toHaveProperty('$schema');
    const text = JSON.stringify(DEEP_CHECK_JSON_SCHEMA);
    for (const t of ['tense_shift', 'overused_word', 'ambiguous', 'inconsistency']) expect(text).toContain(`"${t}"`);
    expect(text).toContain('"delivery"');
  });
});
