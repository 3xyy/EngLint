import { describe, expect, it } from 'vitest';
import { FOCUS_KEYWORDS } from '../../evals/focus-keywords';

const ON_TARGET: Record<string, string[]> = {
  long_sentence: ['This sentence is too long.', 'It runs through several ideas at once.', 'Split it into two sentences, one per clause.'],
  unclear_reference: ['It is unclear who "she" refers to.', 'The pronoun could mean either person.'],
  vague_word: ['"Thing" and "stuff" are vague.', 'Use something more specific.'],
  sentence_variety: ['Every sentence starts with I.', 'The openings repeat, so the rhythm is flat.'],
};
const OFF_TARGET = [
  'This sentence uses passive voice in the middle.',
  'The verb "met" is a bit flat here.',
  'Show the emotion instead of stating it, and edit the other half.',
  'Whether to keep the date depends on the visit.',
  'Her surprise reads flat, and it is a weak ending.',
  'The tone is too formal for the topic.',
];

describe('focus keywords for the tools eval', () => {
  for (const [kind, re] of Object.entries(FOCUS_KEYWORDS)) {
    it(`${kind} matches problem-naming critiques`, () => {
      for (const t of ON_TARGET[kind]!) expect(re.test(t)).toBe(true);
    });
    it(`${kind} does not match off-target critiques`, () => {
      for (const t of OFF_TARGET) expect(re.test(t), t).toBe(false);
    });
  }
});
