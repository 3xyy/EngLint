import { describe, expect, it } from 'vitest';
import { docStats, formatDuration } from '../../src/core/doc-stats';

// Five sentences of 12 words, all in plain words whose syllables are easy to count by hand:
//   S1  We1 go1 to1 the1 old1 market2 and1 buy1 some1 fresh1 bread1 there1            = 13
//   S2  The1 baker2 makes1 a1 loaf1 that1 smells1 like1 warm1 honey2 all1 day1         = 14
//   S3  I1 think1 this1 town1 is1 a1 good1 place1 to1 live1 and1 work1                 = 12
//   S4  My1 mother2 says1 that1 the1 river2 runs1 very2 cold1 in1 the1 winter2         = 16
//   S5  Would1 you1 like1 to1 see1 it1 before2 the1 rain1 comes1 down1 hard1           = 13
// (a final silent e is dropped, so some, there, like, live, place and the give one each; so do makes and comes, whose final es is silent.)
const SIXTY = [
  'We go to the old market and buy some fresh bread there.',
  'The baker makes a loaf that smells like warm honey all day.',
  'I think this town is a good place to live and work.',
  'My mother says that the river runs very cold in the winter.',
  'Would you like to see it before the rain comes down hard?',
].join(' ');
const SYLLABLES = 13 + 14 + 12 + 16 + 13;

describe('docStats', () => {
  it('is all zeros for an empty text, with no Flesch score', () => {
    expect(docStats('')).toEqual({
      words: 0,
      characters: 0,
      sentences: 0,
      readingSeconds: 0,
      speakingSeconds: 0,
      avgSentenceWords: 0,
      flesch: null,
      uniquePct: 0,
      longPct: 0,
    });
  });

  it('counts a fixed 60-word text: words, sentences, characters, average sentence length, Flesch and its label', () => {
    const s = docStats(SIXTY);
    expect(s.words).toBe(60);
    expect(s.sentences).toBe(5);
    expect(s.characters).toBe(SIXTY.length);
    expect(s.characters).toBe(285);
    expect(s.avgSentenceWords).toBe(12);
    const score = Math.round(206.835 - 1.015 * (60 / 5) - 84.6 * (SYLLABLES / 60));
    expect(score).toBe(99);
    expect(s.flesch).toEqual({ score, label: 'Very easy' });
  });

  it('reads at 238 words a minute and speaks at 183', () => {
    const s = docStats(SIXTY);
    expect(s.readingSeconds).toBe(Math.round((60 / 238) * 60));
    expect(s.speakingSeconds).toBe(Math.round((60 / 183) * 60));
    expect(s.readingSeconds).toBe(15);
    expect(s.speakingSeconds).toBe(20);
  });

  it('keeps the rates exact at larger sizes', () => {
    expect(docStats('a '.repeat(476)).readingSeconds).toBe(120);
    expect(docStats('a '.repeat(183)).speakingSeconds).toBe(60);
    expect(docStats('a '.repeat(366)).speakingSeconds).toBe(120);
  });

  it('gives whole percents of unique words and of long words (7 or more letters)', () => {
    expect(docStats('the cat and the dog').uniquePct).toBe(80);
    expect(docStats('The cat and THE dog').uniquePct).toBe(80);
    expect(docStats('remarkable words everywhere').longPct).toBe(67);
    expect(docStats('cabinet cat').longPct).toBe(50); // 7 letters is long
    expect(docStats('cabine cat').longPct).toBe(0);
  });

  it('gives no Flesch score under 30 words, and one at 30', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'cat').join(' ') + '.';
    expect(docStats(words(29)).flesch).toBeNull();
    expect(docStats(words(30)).flesch).not.toBeNull();
  });

  it('clamps Flesch to 0 to 100', () => {
    const hard = Array.from({ length: 30 }, () => 'incomprehensibilities').join(' ') + '.';
    expect(docStats(hard).flesch).toEqual({ score: 0, label: 'Very difficult' });
    const easy = Array.from({ length: 30 }, () => 'a.').join(' ');
    expect(docStats(easy).flesch!.score).toBe(100);
  });

  it('labels each Flesch band', () => {
    // 30 one-syllable words in sentences of n words: score = 206.835 - 1.015 n - 84.6
    const at = (n: number) => {
      const sentence = Array.from({ length: n }, () => 'cat').join(' ') + '.';
      return docStats(Array.from({ length: 30 / n }, () => sentence).join(' ')).flesch!;
    };
    expect(at(30)).toEqual({ score: 92, label: 'Very easy' });
    const twoSyl = (n: number) => {
      const sentence = Array.from({ length: n }, () => 'market').join(' ') + '.';
      return docStats(Array.from({ length: 30 / n }, () => sentence).join(' ')).flesch!;
    };
    expect(twoSyl(30)).toEqual({ score: 7, label: 'Very difficult' });
    const mixed = (twos: number) => {
      const w = [...Array.from({ length: twos }, () => 'market'), ...Array.from({ length: 30 - twos }, () => 'cat')];
      return docStats(w.join(' ') + '.').flesch!;
    };
    expect(mixed(0).label).toBe('Very easy'); // 206.835 - 30.45 - 84.6 = 91.8 -> 92
    expect(mixed(3)).toEqual({ score: 83, label: 'Easy' });
    expect(mixed(6)).toEqual({ score: 75, label: 'Fairly easy' });
    expect(mixed(10)).toEqual({ score: 64, label: 'Plain English' });
    expect(mixed(14)).toEqual({ score: 52, label: 'Fairly difficult' });
    expect(mixed(20)).toEqual({ score: 35, label: 'Difficult' });
    expect(mixed(30).label).toBe('Very difficult');
  });

  it('puts the edge of each Flesch band in its own label', () => {
    // 30 words, k of them two-syllable ("market"), in `sentences` equal sentences.
    const text = (sentences: number, k: number) => {
      const words = [...Array.from({ length: k }, () => 'market'), ...Array.from({ length: 30 - k }, () => 'cat')];
      const size = 30 / sentences;
      return Array.from({ length: sentences }, (_, i) => words.slice(i * size, (i + 1) * size).join(' ') + '.').join(' ');
    };
    const at = (sentences: number, k: number) => docStats(text(sentences, k)).flesch;
    expect(at(2, 6)).toEqual({ score: 90, label: 'Very easy' });
    expect(at(10, 14)).toEqual({ score: 80, label: 'Easy' });
    expect(at(2, 13)).toEqual({ score: 70, label: 'Fairly easy' });
    expect(at(5, 20)).toEqual({ score: 60, label: 'Plain English' });
    expect(at(3, 22)).toEqual({ score: 50, label: 'Fairly difficult' });
    expect(at(1, 22)).toEqual({ score: 30, label: 'Difficult' });
  });

  it('keeps a curled apostrophe inside a word', () => {
    expect(docStats('don’t stop').words).toBe(2);
    expect(docStats("don't stop").words).toBe(2);
    expect(docStats("'tis").words).toBe(1);
  });

  it('counts one sentence for a text with no terminal punctuation, and splits at . ! ? and at line breaks', () => {
    expect(docStats('no punctuation here').sentences).toBe(1);
    expect(docStats('One. Two! Three? Four').sentences).toBe(4);
    expect(docStats('A heading\nSome words here').sentences).toBe(2);
    expect(docStats('Pi is 3.14 exactly.').sentences).toBe(1);
    expect(docStats('Wait... what?').sentences).toBe(2);
    expect(docStats('One.\n\n\nTwo.').sentences).toBe(2);
  });
});

describe('formatDuration', () => {
  it('reads seconds under a minute, else rounded minutes', () => {
    expect(formatDuration(45)).toBe('45 sec');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(150)).toBe('3 min');
  });
});

describe('syllable counting through the Flesch score', () => {
  // 30 copies of one word in a single sentence: one syllable a word scores 92, two score 7.
  const score = (word: string) => docStats(`${Array(30).fill(word).join(' ')}.`).flesch!.score;
  it.each([
    ['makes', 1],
    ['boxes', 2],
    ['pages', 2],
    ['walked', 1],
    ['wanted', 2],
    ['needed', 2],
    ['voices', 2],
    ['sizes', 2],
    ['buses', 2],
    ['wishes', 2],
    ['churches', 2],
    ['like', 1],
    ['table', 2],
    ['tables', 2],
    ['handled', 2],
    ['called', 1],
    ['curled', 1],
    ['bowled', 1],
    ['hassled', 2],
    ['cat', 1],
  ])('counts %s as %i', (word, n) => {
    expect(score(word)).toBe(n === 1 ? 92 : 7);
  });
});
