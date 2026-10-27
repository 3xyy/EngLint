import { describe, expect, it } from 'vitest';
import { carryTypography, dictionaryForm, foldTypography } from '../../src/core/typography';

describe('foldTypography', () => {
  it('folds curly quotes, dashes and the ellipsis, keeping an index map', () => {
    const original = 'don’t “go” — now…';
    const { folded, toOriginal } = foldTypography(original);
    expect(folded).toBe(`don't "go" - now...`);
    expect(toOriginal[15]).toBe(15);
    // The ellipsis is original 16; its three folded dots all map back to it.
    expect([toOriginal[16], toOriginal[17], toOriginal[18]]).toEqual([16, 16, 16]);
    // One final entry for the end.
    expect(toOriginal).toHaveLength(folded.length + 1);
    expect(toOriginal[folded.length]).toBe(original.length);
  });

  it('folds every listed character', () => {
    expect(foldTypography('‘’‚‛′|“”„‟″|–—|\u00a0|…').folded).toBe(`'''''|"""""|--| |...`);
  });

  it('leaves plain text and its offsets alone', () => {
    expect(foldTypography('plain text')).toEqual({ folded: 'plain text', toOriginal: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  });
});

describe('dictionaryForm', () => {
  it('folds, trims spaces and edge punctuation, and lowercases', () => {
    expect(dictionaryForm('Kubernetes,')).toBe('kubernetes');
    expect(dictionaryForm(' “O’Brien,” ')).toBe("o'brien");
    expect(dictionaryForm("O'Brien")).toBe(dictionaryForm('O’Brien'));
  });
});

describe('carryTypography', () => {
  it('curls a straight apostrophe when the document has ’', () => {
    expect(carryTypography('don’t really', "don't")).toBe('don’t');
  });

  it('curls straight double-quote pairs when the document has “ or ”', () => {
    expect(carryTypography('“big” idea', 'a "big" and "small" idea')).toBe('a “big” and “small” idea');
    expect(carryTypography('end”', '"x"')).toBe('“x”');
  });

  it('leaves the replacement alone when the document has straight quotes', () => {
    expect(carryTypography("don't really", "don't")).toBe("don't");
    expect(carryTypography('"big" idea', '"big"')).toBe('"big"');
  });
});
