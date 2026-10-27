import { describe, expect, it } from 'vitest';
import { changesClaims } from '../../src/core/claims';

describe('changesClaims', () => {
  it('a changed number is a changed claim', () => {
    expect(changesClaims('by 2025', 'by next year')).toBe(true);
  });

  it('a plain rewording is not', () => {
    expect(changesClaims('very big', 'huge')).toBe(false);
  });

  it('a dropped capitalised name is a changed claim', () => {
    expect(changesClaims('met Alice there', 'met her there')).toBe(true);
  });

  it('dropped quoted text is a changed claim', () => {
    expect(changesClaims('He said "no" twice', 'He said no twice')).toBe(true);
  });

  it("each side's first word is exempt from the capitalised-word rule", () => {
    expect(changesClaims('Very big', 'Huge')).toBe(false);
  });

  it('the pronoun I is not a name', () => {
    expect(changesClaims('so I think', 'I think')).toBe(false);
    expect(changesClaims('it works, I think', 'it works')).toBe(false);
  });

  it('punctuation after a number does not change it', () => {
    expect(changesClaims('in 2025, we left', 'in 2025 we left')).toBe(false);
  });

  it('curly and straight quotes around the same words are the same quote', () => {
    expect(changesClaims('He said “no” twice', 'He said "no" twice')).toBe(false);
  });

  it('a month or weekday name counts even as the first word', () => {
    expect(changesClaims('Monday we met', 'We met')).toBe(true);
    expect(changesClaims('we met in june', 'we met then')).toBe(true);
  });

  it('the verb "may" is not the month', () => {
    expect(changesClaims('you may go', 'you can go')).toBe(false);
  });

  it('a name or month inside single quotes still counts', () => {
    expect(changesClaims('met ‘Alice’ there', 'met her there')).toBe(true);
    expect(changesClaims('we met ‘Monday’', 'we met then')).toBe(true);
  });

  it('a name that only moves to or from the start is not a change', () => {
    expect(changesClaims('The ball was thrown by John', 'John threw the ball')).toBe(false);
    expect(changesClaims('Kim was praised by Lee', 'Lee praised Kim')).toBe(false);
    expect(changesClaims('In order to win', 'To win')).toBe(false);
  });

  it('a first-word name the other side lacks stays exempt (accepted gap)', () => {
    expect(changesClaims('Alice went home', 'She went home')).toBe(false);
  });
});

describe('changesClaims with lenient sentence starts', () => {
  const lenient = (a: string, b: string) => changesClaims(a, b, { sentenceStarts: 'lenient' });

  it('an opener dropped or swapped at a later sentence start is not a changed claim', () => {
    expect(lenient('The club grew. Moreover, we won.', 'The club grew, and we won.')).toBe(false);
    expect(lenient('We tried. Every week we met.', 'We tried. Each week we met.')).toBe(false);
    expect(lenient('The trip was long. The bus broke.', 'The trip was long, and the bus broke.')).toBe(false);
    expect(lenient('It rained! Sadly, we stayed in.', 'It rained, so we stayed in.')).toBe(false);
    expect(lenient('Why? Because we cared.', 'Why? We cared.')).toBe(false);
  });

  it('a sentence can start after closing quotes or brackets, after opening ones, or on a new line', () => {
    expect(lenient('He left." Then we ate.', 'He left." After that we ate.')).toBe(false);
    expect(lenient('We waited (all day.) Finally it came.', 'We waited (all day.) At last it came.')).toBe(false);
    expect(lenient('We stopped. ‘Honestly, it was fine.’', 'We stopped. ‘It was fine.’')).toBe(false);
    expect(lenient('We stopped. (Honestly, it was fine.)', 'We stopped. (It was fine.)')).toBe(false);
    expect(lenient('Dear team,\nThanks for the help.', 'Dear team,\nI appreciate the help.')).toBe(false);
  });

  it('a period after a title or a single capital ends no sentence, so the name after it counts', () => {
    expect(lenient('I asked Dr. Okafor for help.', 'I asked Dr. Adeyemi for help.')).toBe(true);
    expect(lenient('My teacher, Mrs. Chen, stayed late.', 'My teacher, Mrs. Park, stayed late.')).toBe(true);
    for (const title of ['Mr', 'Ms', 'Mx', 'Prof', 'St', 'Mt', 'Jr', 'Sr', 'Rev']) {
      expect(lenient(`We saw ${title}. Okafor there.`, `We saw ${title}. Adeyemi there.`), title).toBe(true);
    }
    expect(lenient('We read J. Okafor first.', 'We read J. Adeyemi first.')).toBe(true);
    expect(lenient('She joined the U.S. Army in May.', 'She joined the U.S. Navy in May.')).toBe(true);
  });

  it('a capitalised word used mid-sentence on either side still counts where it starts a sentence', () => {
    expect(lenient('Ngozi was late. I waited for Ngozi.', 'She was late. I waited for her.')).toBe(true);
    expect(lenient('I met Ngozi. Ngozi was late.', 'I met Ngozi. She was late.')).toBe(true);
    expect(lenient('The ball was thrown by John', 'John threw the ball')).toBe(false);
    expect(lenient('It was late. The ball was thrown by John.', 'It was late. John threw the ball.')).toBe(false);
  });

  it('a name changed mid-sentence, a number, a date or a quote is still a changed claim', () => {
    expect(lenient('Then I met Alice at the station.', 'Then I met Maria at the station.')).toBe(true);
    expect(lenient('We met. It took 3 days.', 'We met. It took days.')).toBe(true);
    expect(lenient('It rained. Monday we left.', 'It rained. We left.')).toBe(true);
    expect(lenient('He said "no" twice.', 'He said no twice.')).toBe(true);
  });

  it('a name that only ever starts sentences can be swapped or dropped unseen (accepted gap)', () => {
    expect(lenient('We met. Alice was late.', 'We met. Maria was late.')).toBe(false);
    expect(lenient('We met at noon. Ngozi was late, as always.', 'We met at noon. She was late, as always.')).toBe(false);
    expect(lenient('Alice went home', 'She went home')).toBe(false);
  });

  it('the default, and strict, count a capitalised word after the first wherever it stands', () => {
    for (const strict of [(a: string, b: string) => changesClaims(a, b), (a: string, b: string) => changesClaims(a, b, { sentenceStarts: 'strict' })]) {
      expect(strict('The club grew. Moreover, we won.', 'The club grew, and we won.')).toBe(true);
      expect(strict('We tried. Every week we met.', 'We tried. Each week we met.')).toBe(true);
      expect(strict('We met. Alice was late.', 'We met. Maria was late.')).toBe(true);
      expect(strict('Very big', 'Huge')).toBe(false);
    }
  });
});
