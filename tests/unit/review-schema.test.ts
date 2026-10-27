import { describe, expect, it } from 'vitest';
import { cleanGrading, cleanReaders, cleanTone, READERS_JSON_SCHEMA, rubricDefinesGrades, stripMissingPassages, TONE_JSON_SCHEMA } from '../../src/core/review-schema';

describe('cleanTone', () => {
  it('lowercases and keeps the tone words', () => {
    expect(cleanTone({ tones: ['Confident', 'warm'] })).toEqual(['confident', 'warm']);
  });
  it('keeps the first 3 of more', () => {
    expect(cleanTone({ tones: ['a', 'b', 'c', 'd'] })).toEqual(['a', 'b', 'c']);
  });
  it('drops an item over 3 words or over 24 characters', () => {
    expect(cleanTone({ tones: ['one two three four', 'calm', 'extraordinarily-unreasonable'] })).toEqual(['calm']);
    expect(cleanTone({ tones: ['one two three'] })).toEqual(['one two three']);
    expect(cleanTone({ tones: ['a'.repeat(24)] })).toEqual(['a'.repeat(24)]);
    expect(cleanTone({ tones: ['a'.repeat(25)] })).toBeNull();
  });
  it('trims items and drops blanks', () => {
    expect(cleanTone({ tones: ['  warm  ', '   ', ''] })).toEqual(['warm']);
  });
  it('is null when nothing is left, or the shape is wrong', () => {
    expect(cleanTone({ tones: [] })).toBeNull();
    expect(cleanTone({ tones: 'warm' })).toBeNull();
    expect(cleanTone({ tones: [1, 2] })).toBeNull();
    expect(cleanTone(null)).toBeNull();
    expect(cleanTone('warm')).toBeNull();
  });
});

describe('TONE_JSON_SCHEMA', () => {
  it('asks for an array of strings named tones', () => {
    expect(TONE_JSON_SCHEMA).toMatchObject({ type: 'object', properties: { tones: { type: 'array', items: { type: 'string' } } }, required: ['tones'] });
    expect(TONE_JSON_SCHEMA).not.toHaveProperty('$schema');
  });
});

const REACTION = {
  first_impression: 'A warm, direct opening.',
  remember: ['the market'],
  questions: ['Why this town?'],
  lost: [{ quote: 'and then', why: 'It drifts.' }],
  strength: { quote: 'warm honey', why: 'Concrete detail.' },
};

describe('cleanReaders', () => {
  it('maps a good answer to the reaction shape', () => {
    expect(cleanReaders(REACTION)).toEqual({
      firstImpression: 'A warm, direct opening.',
      remember: ['the market'],
      questions: ['Why this town?'],
      lost: [{ quote: 'and then', why: 'It drifts.' }],
      strength: { quote: 'warm honey', why: 'Concrete detail.' },
    });
  });
  it('cuts over-limit strings with an ellipsis, to the limit', () => {
    const r = cleanReaders({
      ...REACTION,
      first_impression: 'a'.repeat(401),
      remember: ['b'.repeat(201)],
      lost: [{ quote: 'q'.repeat(201), why: 'w'.repeat(201) }],
      strength: { quote: 'q'.repeat(201), why: 'w'.repeat(201) },
    })!;
    expect(r.firstImpression).toBe(`${'a'.repeat(399)}…`);
    expect(r.remember[0]).toBe(`${'b'.repeat(199)}…`);
    expect(r.lost[0]!.quote).toBe(`${'q'.repeat(199)}…`);
    expect(r.lost[0]!.why).toBe(`${'w'.repeat(199)}…`);
    expect(r.strength.why).toBe(`${'w'.repeat(199)}…`);
    expect(cleanReaders({ ...REACTION, first_impression: 'a'.repeat(400) })!.firstImpression).toHaveLength(400);
  });
  it('keeps at most 3 remembered, 4 questions and 4 lost', () => {
    const r = cleanReaders({
      ...REACTION,
      remember: ['a', 'b', 'c', 'd'],
      questions: ['1', '2', '3', '4', '5'],
      lost: Array.from({ length: 5 }, (_, i) => ({ quote: `q${i}`, why: 'w' })),
    })!;
    expect(r.remember).toEqual(['a', 'b', 'c']);
    expect(r.questions).toEqual(['1', '2', '3', '4']);
    expect(r.lost).toHaveLength(4);
  });
  it('is null for an empty first impression or strength reason, or a wrong shape', () => {
    expect(cleanReaders({ ...REACTION, first_impression: '   ' })).toBeNull();
    expect(cleanReaders({ ...REACTION, strength: { quote: 'x', why: '' } })).toBeNull();
    expect(cleanReaders({ nope: 1 })).toBeNull();
    expect(cleanReaders(null)).toBeNull();
  });
  describe('in Essay, a reason drops only the long quoted passage that is missing from the text', () => {
    const passage = Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ');
    const DOC = 'The baker makes a loaf that smells like warm honey, and then the town wakes up.';
    const essay = { text: DOC, mode: 'essay' } as const;
    const smuggled = {
      ...REACTION,
      lost: [{ quote: 'and then', why: `The turn is abrupt. Say "${passage}" instead.` }],
      strength: { quote: 'warm honey', why: `Keep it, as in \u201c${passage}\u201d, because it lands.` },
    };

    it('keeps the rest of a lost or strength reason with an ellipsis in place of the passage, and its quote', () => {
      const r = cleanReaders(smuggled, essay)!;
      expect(r.lost).toEqual([{ quote: 'and then', why: 'The turn is abrupt. Say … instead.' }]);
      expect(r.strength).toEqual({ quote: 'warm honey', why: 'Keep it, as in …, because it lands.' });
      expect(r.firstImpression).toBe(REACTION.first_impression);
    });

    it('empties a reason with fewer than 3 words left', () => {
      const r = cleanReaders({ ...smuggled, lost: [{ quote: 'and then', why: `Say "${passage}".` }] }, essay)!;
      expect(r.lost).toEqual([{ quote: 'and then', why: '' }]);
    });

    it('keeps them outside Essay, and in Essay when the passage is in the text', () => {
      expect(cleanReaders(smuggled, { text: DOC, mode: 'standard' })!.lost[0]!.why).toContain(passage);
      expect(cleanReaders(smuggled)!.strength.why).toContain(passage);
      const inText = cleanReaders(smuggled, { text: `${DOC} ${passage}.`, mode: 'essay' })!;
      expect(inText.lost[0]!.why).toContain(passage);
      expect(inText.strength.why).toContain(passage);
    });

    it('strips the passage from the whole reason before cutting it', () => {
      const quote = Array.from({ length: 20 }, (_, i) => `rewrite${i}`).join(' ');
      const why = `${'a'.repeat(150)} "${quote}" and more.`;
      expect(why.length).toBeGreaterThan(200);
      expect(cleanReaders({ ...REACTION, lost: [{ quote: 'and then', why }] }, essay)!.lost[0]!.why).toBe(`${'a'.repeat(150)} … and more.`);
    });

    it('a strength reason the model left blank still voids the reaction', () => {
      expect(cleanReaders({ ...REACTION, strength: { quote: 'x', why: ' ' } }, { text: DOC, mode: 'essay' })).toBeNull();
    });
  });

  it('declares the reaction in its JSON schema', () => {
    expect(READERS_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(Object.keys((READERS_JSON_SCHEMA as any).properties).sort()).toEqual(['first_impression', 'lost', 'questions', 'remember', 'strength']);
  });
});

describe('rubricDefinesGrades', () => {
  it.each([
    'A: exceptional work. B: solid work. C: adequate.',
    'A: exceptional\u2026 B: solid\u2026',
    'A - exceptional.\nB - solid.',
    'A: exceptional\nB: solid',
    'Score out of 10',
    'Band 4: Insightful and well organized',
    'Level 3 \u2013 clear. Level 2 \u2013 uneven.',
    'Level 4 is insightful. Level 3 is clear.',
    '30 points in all',
    'Worth 100 marks',
    'Scored out of 100',
    'Graded /100',
    'Grade: B+ means strong',
    'A grade of A- needs a clear voice',
    'A (90-100): exceptional work. B (80-89): solid work. C (70-79): adequate.',
    'A (90\u2013100) \u2013 exceptional\nB (80\u201389) \u2013 solid',
    'A (90%-100%): exceptional.\nB (80%-89%): solid.',
    'A (90 to 100): exceptional. B (80 to 89): solid.',
    'A = excellent, B = good',
    'A = excellent; B = good; C = fair',
    'A = excellent\nB = good',
  ])('is true for %s', (r) => expect(rubricDefinesGrades(r)).toBe(true));
  it.each([
    'Answer the prompt clearly and show growth',
    'A good essay has a clear voice.',
    'Plan B: stay home',
    'Show who you are in the first line',
    'Part A: Describe a challenge. Part B: Reflect on what you learned.',
    'Option A: a person. Option B: a place.',
    'Choose one: A) a challenge you faced B) a person who influenced you',
    'Consider (A) your family or (B) your school.',
    'Describe a turning point in your life.',
    'Write from a first-person point of view.',
    'Grade 11 English: personal essay assignment.',
    'Due 3/10. Write 650 words about your community.',
    'Tell us about a time you stepped out of your comfort zone.',
    'Support your points with specific evidence.',
    'Level 3 vocabulary expected.',
    'Level of detail matters',
    'Band 4 is the top band',
    'Class of 2027 supplemental essay: why us?',
    'In 250 words, describe an extracurricular activity.',
    'Rate it on a scale of 1/10',
    'A-level results matter. B-roll is welcome.',
    'A: the first idea. A: the same idea again.',
    'A (the intro): set the scene. B (the body): tell the story.',
    'Plan A = stay home, Plan B = go out.',
    'A = the intro.',
    'Score it x = A, y = B.',
    'Choose (A) = a person or (B) = a place.',
    'A (90-100): only one band is described here.',
    'Answer A = yes, A = also yes.',
  ])('is false for %s', (r) => expect(rubricDefinesGrades(r)).toBe(false));
});

const GRADING = {
  criteria: [{ name: 'Voice', rating: 'strong', evidence: [{ quote: 'warm honey', note: 'Vivid.' }], raise: 'Say what it meant to you.' }],
  grade: 'B+',
};
const TEXT = 'The baker makes a loaf that smells like warm honey.';
const LETTER_RUBRIC = 'A: exceptional. B: solid. C: weak.';

describe('cleanGrading', () => {
  it('keeps the grade when the rubric defines grades, and drops it when not', () => {
    expect(cleanGrading(GRADING, LETTER_RUBRIC, TEXT, 'standard')!.grade).toBe('B+');
    expect(cleanGrading(GRADING, 'Answer the prompt clearly', TEXT, 'standard')!.grade).toBeNull();
    expect(cleanGrading({ ...GRADING, grade: null }, LETTER_RUBRIC, TEXT, 'standard')!.grade).toBeNull();
    expect(cleanGrading({ ...GRADING, grade: '  ' }, LETTER_RUBRIC, TEXT, 'standard')!.grade).toBeNull();
  });
  it('maps criteria to their shape', () => {
    expect(cleanGrading(GRADING, LETTER_RUBRIC, TEXT, 'standard')!.criteria).toEqual([
      { name: 'Voice', rating: 'strong', evidence: [{ quote: 'warm honey', note: 'Vivid.' }], raise: 'Say what it meant to you.' },
    ]);
  });
  it('drops a criterion with an invalid rating, and is null when none is left', () => {
    const bad = { name: 'X', rating: 'excellent', evidence: [], raise: '' };
    expect(cleanGrading({ ...GRADING, criteria: [bad, GRADING.criteria[0]] }, '', TEXT, 'standard')!.criteria.map((c) => c.name)).toEqual(['Voice']);
    expect(cleanGrading({ ...GRADING, criteria: [bad] }, '', TEXT, 'standard')).toBeNull();
    expect(cleanGrading({ ...GRADING, criteria: [] }, '', TEXT, 'standard')).toBeNull();
    expect(cleanGrading('nope', '', TEXT, 'standard')).toBeNull();
  });
  it('keeps at most 8 criteria and 3 evidence items, and cuts raise to 300', () => {
    const c = { name: 'N', rating: 'solid', evidence: ['a', 'b', 'c', 'd'].map((q) => ({ quote: q, note: 'n' })), raise: 'r'.repeat(301) };
    const g = cleanGrading({ criteria: Array.from({ length: 9 }, () => c), grade: null }, '', TEXT, 'standard')!;
    expect(g.criteria).toHaveLength(8);
    expect(g.criteria[0]!.evidence).toHaveLength(3);
    expect(g.criteria[0]!.raise).toBe(`${'r'.repeat(299)}…`);
  });
  const long = Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ');
  it('in Essay, drops a raise that quotes a long passage missing from the text, and keeps it otherwise', () => {
    const withQuote = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: `Try "${long}" instead.` }] };
    expect(cleanGrading(withQuote, '', TEXT, 'essay')!.criteria[0]!.raise).toBe('');
    expect(cleanGrading(withQuote, '', TEXT, 'standard')!.criteria[0]!.raise).toContain(long);
    expect(cleanGrading(withQuote, '', `Intro. ${long} outro.`, 'essay')!.criteria[0]!.raise).toContain(long);
    const short = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: 'Try "one two three" instead.' }] };
    expect(cleanGrading(short, '', TEXT, 'essay')!.criteria[0]!.raise).toContain('one two three');
  });
  it('in Essay, checks the whole string before cutting it: a long quote closing past the cut is still caught', () => {
    const quote = Array.from({ length: 20 }, (_, i) => `rewrite${i}`).join(' ');
    const raise = `${'a'.repeat(250 - 1)} "${quote}" and more.`;
    expect(raise.length).toBeGreaterThan(300);
    const g = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise }] };
    expect(cleanGrading(g, '', TEXT, 'essay')!.criteria[0]!.raise).toBe('');
    expect(cleanGrading(g, '', TEXT, 'standard')!.criteria[0]!.raise.length).toBe(300);
    const note = { ...GRADING, criteria: [{ ...GRADING.criteria[0], evidence: [{ quote: 'warm honey', note: `${'n'.repeat(150)} "${quote}" ok` }] }] };
    expect(cleanGrading(note, '', TEXT, 'essay')!.criteria[0]!.evidence[0]!.note).toBe('');
  });
  it('in Essay, an opening quote with no closing quote runs to the end of the string', () => {
    const quote = Array.from({ length: 20 }, (_, i) => `rewrite${i}`).join(' ');
    const g = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: `Try "${quote}` }] };
    expect(cleanGrading(g, '', TEXT, 'essay')!.criteria[0]!.raise).toBe('');
    const curled = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: `Try \u201c${quote}` }] };
    expect(cleanGrading(curled, '', TEXT, 'essay')!.criteria[0]!.raise).toBe('');
  });
  it('in Essay, curled single quotes count as quote marks, and straight apostrophes do not', () => {
    const quote = Array.from({ length: 20 }, (_, i) => `rewrite${i}`).join(' ');
    const single = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: `Try \u2018${quote}\u2019 instead.` }] };
    expect(cleanGrading(single, '', TEXT, 'essay')!.criteria[0]!.raise).toBe('');
    const apostrophes = "Don't hedge; it's what you've done that counts, and I'm sure they'd like to hear what you learned from the whole experience, not only what happened.";
    const plain = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: apostrophes }] };
    expect(cleanGrading(plain, '', TEXT, 'essay')!.criteria[0]!.raise).toBe(apostrophes);
    const curledApostrophes = "It\u2019s what you\u2019ve done, and they\u2019d want to hear more about what you learned from it, not only what happened to you along the way there.";
    const c = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: curledApostrophes }] };
    expect(cleanGrading(c, '', TEXT, 'essay')!.criteria[0]!.raise).toBe(curledApostrophes);
  });
  it('in Essay, a curled apostrophe inside a single-quoted passage does not end it', () => {
    const raise = 'Try \u2018one two three four five six seven it\u2019s eight nine ten eleven twelve thirteen fourteen\u2019 now.';
    const g = { ...GRADING, criteria: [{ ...GRADING.criteria[0], raise }] };
    expect(cleanGrading(g, '', TEXT, 'essay')!.criteria[0]!.raise).toBe('');
  });
  it('in Essay, a 12-word quoted passage missing from the text is kept and a 13-word one is dropped', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const raise = (n: number) => ({ ...GRADING, criteria: [{ ...GRADING.criteria[0], raise: `Try "${words(n)}" here.` }] });
    expect(cleanGrading(raise(12), '', TEXT, 'essay')!.criteria[0]!.raise).toContain(words(12));
    expect(cleanGrading(raise(13), '', TEXT, 'essay')!.criteria[0]!.raise).toBe('');
  });
  it('never cuts a surrogate pair in half', () => {
    const emoji = '\u{1F600}';
    const r = cleanReaders({ ...REACTION, first_impression: `${'a'.repeat(398)}${emoji}${emoji}` })!.firstImpression;
    expect(r).toBe(`${'a'.repeat(398)}\u2026`);
    expect(r.charCodeAt(r.length - 2)).toBeLessThan(0xd800);
  });
  it('in Essay, empties an evidence note that quotes a long passage missing from the text', () => {
    const g = { ...GRADING, criteria: [{ ...GRADING.criteria[0], evidence: [{ quote: 'warm honey', note: `Like “${long}”.` }] }] };
    expect(cleanGrading(g, '', TEXT, 'essay')!.criteria[0]!.evidence[0]!.note).toBe('');
  });
});

describe('stripMissingPassages', () => {
  const long = Array.from({ length: 14 }, (_, i) => `w${i}`).join(' ');
  const TEXT = 'A short document about bread.';
  it('replaces each long passage not in the text, quote marks included, in every quote style', () => {
    expect(stripMissingPassages(`A "${long}" B \u201c${long}\u201d C \u2018${long}\u2019 D`, TEXT)).toBe('A \u2026 B \u2026 C \u2026 D');
  });
  it('runs an unclosed quote to the end', () => {
    expect(stripMissingPassages(`Try "${long} and more`, TEXT)).toBe('Try \u2026');
  });
  it('leaves short quotes and passages found in the text alone', () => {
    const found = `${TEXT} ${long}`;
    expect(stripMissingPassages(`Use "bread" or "${long}".`, found)).toBe(`Use "bread" or "${long}".`);
    expect(stripMissingPassages('Use "one two three".', TEXT)).toBe('Use "one two three".');
  });
});
