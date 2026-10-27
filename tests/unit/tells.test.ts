import { describe, expect, it } from 'vitest';
import { detectTells } from '../../src/core/tells/detect';
import type { Mode } from '../../src/core/types';

const fire = (text: string, mode: Mode = 'standard') => detectTells(text, mode);
const rules = (text: string, mode: Mode = 'standard') => fire(text, mode).map((i) => i.ruleId);
const only = (text: string, rule: string, mode: Mode = 'standard') => {
  const hits = fire(text, mode).filter((i) => i.ruleId === `tell:${rule}`);
  expect(hits).toHaveLength(1);
  return hits[0]!;
};
const silent = (text: string, rule: string, mode: Mode = 'standard') =>
  expect(rules(text, mode)).not.toContain(`tell:${rule}`);

describe('every issue', () => {
  it('has the generic-phrasing shape and `at` at the match', () => {
    const text = 'We toured the campus. The library serves as a meeting place.';
    const [i] = fire(text);
    expect(i).toMatchObject({
      kind: 'generic_phrasing',
      category: 'delivery',
      severity: 'suggestion',
      source: 'tells',
      ruleId: 'tell:serves_as',
      original: 'serves as',
    });
    expect(i!.at).toBe(text.indexOf('serves as'));
    expect(text.slice(i!.at, i!.at! + i!.original.length)).toBe(i!.original);
    expect(i!.before).toBe('toured the campus. The library');
  });

  it('is empty for plain prose and for an empty paragraph', () => {
    expect(fire('')).toEqual([]);
    expect(fire('I walked to school and ate lunch with my friends.')).toEqual([]);
  });
});

describe('not_x_but_y', () => {
  it.each([
    "It's not just a club, but a family.",
    'Debate is not just a hobby, but a way of seeing the world.',
    "It's not a bug, it's a feature.",
    "That doesn't mean she gave up. It means she changed her plan.",
  ])('fires on %s, comment-only', (text) => {
    expect(only(text, 'not_x_but_y').replacement).toBeNull();
  });

  it.each([
    'Not all students agree, but most do.',
    "It's not mine, it's hers.",
    'I did not go, but my sister did.',
    'He is not tall. It was raining.',
  ])('does not fire on %s', (text) => silent(text, 'not_x_but_y'));
});

describe('runup', () => {
  it('removes the run-up and capitalizes the next word', () => {
    const i = only('It is important to note that the bus was late.', 'runup');
    expect(i.original).toBe('It is important to note that the bus was late.');
    expect(i.replacement).toBe('The bus was late.');
  });

  it('keeps a next word that already has an internal capital', () => {
    expect(only('It is important to note that iPhone sales rose.', 'runup').replacement).toBe('iPhone sales rose.');
    expect(only("It's worth noting that eBay changed its rules.", 'runup').replacement).toBe('eBay changed its rules.');
    expect(only("It's worth noting that Maya won.", 'runup').replacement).toBe('Maya won.');
  });

  it.each([
    ["It's worth noting that our team won twice.", 'Our team won twice.'],
    ["In today's world, technology matters to every student.", 'Technology matters to every student.'],
    ['We left early. It should be noted that the road was closed.', 'The road was closed.'],
  ])('fixes %s', (text, fixed) => {
    expect(only(text, 'runup').replacement).toBe(fixed);
  });

  it.each([
    'It is important to note the deadline for applications.',
    'It is important to note the difference between weather and climate.',
    "It's important to note how much she gave up.",
  ])('is comment-only on a lead without "that", whose rest is not a sentence: %s', (text) => {
    const i = only(text, 'runup');
    expect(i.original).toBe(text.startsWith("It's") ? "It's important to note" : 'It is important to note');
    expect(i.replacement).toBeNull();
  });

  it('is comment-only when no full sentence follows', () => {
    expect(only('It is important to note', 'runup').replacement).toBeNull();
    expect(only('In this essay, I will explore my town.', 'runup').replacement).toBeNull();
    expect(only("Let's dive in.", 'runup').replacement).toBeNull();
    expect(only("In today's world, hello.", 'runup').replacement).toBeNull();
  });

  it.each([
    'The coach said it is important to note the score.',
    'It is important to practice every day.',
    'In the world today, people travel more.',
    'We read an essay in class.',
  ])('does not fire on %s', (text) => silent(text, 'runup'));
});

describe('objections', () => {
  it.each([
    'Some may argue that homework is useful, and I agree.',
    'You might think the test was easy. It was not.',
    'One might argue the plan was weak.',
  ])('fires nothing on %s', (text) => expect(fire(text)).toEqual([]));
});

describe('inflated', () => {
  it.each([
    'The bridge stands as a testament to their skill.',
    'Music plays a vital role in my life.',
    'Teachers play a crucial role in a town.',
    'It was a pivotal moment for the club.',
    'The statue stands as a symbol of the town.',
  ])('fires on %s, comment-only', (text) => {
    expect(only(text, 'inflated').replacement).toBeNull();
  });

  it.each([
    'Show me the role she plays in the film.',
    'The nurse noted a vital sign on the chart.',
    'The pivot was quick and she scored.',
    'He stands at the door.',
  ])('does not fire on %s', (text) => silent(text, 'inflated'));
});

describe('sales', () => {
  it.each([
    ['Our game-changing app is out.', 'standard'],
    ['The team offers world-class tutoring.', 'essay'],
    ['The handoff was seamless.', 'standard'],
    ['A cutting-edge lab opened.', 'essay'],
    ['The result was unparalleled.', 'standard'],
  ] as const)('fires on %s in %s, comment-only', (text, mode) => {
    expect(only(text, 'sales', mode).replacement).toBeNull();
  });

  it.each(['Our game-changing app is out.', 'The handoff was seamless.', 'A cutting-edge lab.'])(
    'never fires in Casual: %s',
    (text) => silent(text, 'sales', 'casual'),
  );

  it.each([
    'We studied the American Revolutionary War in class.',
    'The revolutionary war ended in 1783.',
    'Revolutionary movements spread across Europe.',
    'She joined revolutionary movements as a teenager.',
    'The seam was loose.',
    'Her game was changing quickly.',
  ])('does not fire on %s', (text) => silent(text, 'sales'));
});

describe('serves_as', () => {
  it('replaces serves as with is', () => {
    const i = only('The library serves as a meeting place.', 'serves_as');
    expect(i.original).toBe('serves as');
    expect(i.replacement).toBe('is');
  });

  it('replaces stands as with is and boasts with has', () => {
    expect(only('The hall stands as the oldest building.', 'serves_as').replacement).toBe('is');
    const b = only('The campus boasts over forty clubs.', 'serves_as');
    expect(b.original).toBe('boasts');
    expect(b.replacement).toBe('has');
    expect(only('The school boasts a pool.', 'serves_as').replacement).toBe('has');
  });

  it('uses are after a plural subject it can see, and is comment-only otherwise', () => {
    expect(only('The libraries serve as meeting places.', 'serves_as').replacement).toBe('are');
    expect(only('They serve as guides.', 'serves_as').replacement).toBe('are');
    expect(only('Clubs will serve as a bridge.', 'serves_as').replacement).toBeNull();
    expect(only('The staff serve as a guide.', 'serves_as').replacement).toBeNull();
  });

  it('is comment-only when an adverb sits between the subject and the verb', () => {
    for (const text of [
      'Teachers always serve as mentors.',
      'Clubs often serve as a bridge.',
      'Libraries also serve as meeting places.',
      'Clubs quietly serve as a bridge.',
      'Tutors usually serve as guides.',
    ]) {
      expect(only(text, 'serves_as').replacement).toBeNull();
    }
    expect(only('The libraries serve as meeting places.', 'serves_as').replacement).toBe('are');
  });

  it('is comment-only when an adverb sits before a singular serves or stands', () => {
    expect(only('The library quietly stands as a landmark.', 'serves_as').replacement).toBeNull();
    expect(only('The porch always serves as a meeting place.', 'serves_as').replacement).toBeNull();
    expect(only('The hall stands as the oldest building.', 'serves_as').replacement).toBe('is');
  });

  it.each([
    'He stands as tall as his brother.',
    'He boasts about his grades.',
    'She will serve the soup.',
    'The server stands at the door.',
    'I will serve as the treasurer if nobody else wants the job.',
    'I serve as the treasurer.',
    'She serves as the team captain.',
    'We always serve as the backup crew.',
  ])('does not fire on %s', (text) => silent(text, 'serves_as'));
});

describe('chatbot', () => {
  it.each([
    'Certainly! Here is the summary.',
    "Certainly! Here's a draft of the essay.",
    'As an AI language model, I cannot say.',
    'Great question. The answer is yes.',
    'I hope this helps.',
    'As of my last update, the club had ten members.',
  ])('fires on %s, comment-only', (text) => {
    expect(only(text, 'chatbot').replacement).toBeNull();
  });

  it.each([
    "Thanks, I hope you're well.",
    'I hope this year goes well.',
    'She certainly is here.',
    'It was a question of time.',
    'I asked a great question in class, and the room went quiet.',
    'I hope this helps with the grant application, and feel free to reach out.',
    'I hope this helps! The recording is also in the shared folder.',
    'We left early, great question, I thought.',
    'Great question marks stood over every answer.',
    'We met. Great question! Next up.',
    'I raised my hand. Great question, said my teacher, and I froze.',
  ])('does not fire on %s', (text) => silent(text, 'chatbot'));

  it.each([
    ['Here is the draft. I hope this helps!', 'I hope this helps'],
    ['Here is the draft. I hope this helps.', 'I hope this helps'],
    ['Great question, the answer is yes.', 'Great question'],
    ['Great question! Next up.', 'Great question'],
  ])('fires where it ends or opens the paragraph: %s', (text, original) => {
    expect(only(text, 'chatbot').original).toBe(original);
  });
});

describe('quotation marks and repeated terms', () => {
  it.each([
    'He said "the library serves as a meeting place" and left.',
    'He said “the library serves as a meeting place” and left.',
    'He said ‘the library serves as a meeting place’ and left.',
    'She wrote "It is important to note that the bus was late." in her log.',
  ])('fires nothing inside quotation marks: %s', (text) => {
    expect(fire(text)).toEqual([]);
  });

  it('still fires outside the quotation', () => {
    expect(rules('"Hello," he said. The library serves as a meeting place.')).toEqual(['tell:serves_as']);
  });

  it('treats a straight apostrophe as an apostrophe, not a quote', () => {
    expect(rules("It's the kids' library and it serves as a meeting place.")).toEqual(['tell:serves_as']);
  });

  it('does not fire on a term the writer repeats three times', () => {
    expect(fire('Seamless design matters. We value seamless work. Seamless is our word.')).toEqual([]);
    expect(rules('Seamless design matters. We value seamless work.')).toEqual(['tell:sales', 'tell:sales']);
  });
});

describe('overlaps', () => {
  it('reports one issue where two patterns match the same words', () => {
    expect(rules('The bridge stands as a testament to their skill.')).toEqual(['tell:inflated']);
  });
});
