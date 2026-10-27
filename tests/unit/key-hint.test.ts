import { describe, expect, it } from 'vitest';
import { keyHint } from '../../src/background/key-hint';

describe('keyHint', () => {
  it('reports no key', () => {
    expect(keyHint(null)).toEqual({ saved: false, last4: null });
    expect(keyHint('')).toEqual({ saved: false, last4: null });
  });
  it('gives the last 4 characters only for keys of 12 or more characters', () => {
    expect(keyHint('sk-ant-' + 'api03-abcdWXYZ')).toEqual({ saved: true, last4: 'WXYZ' });
    expect(keyHint('123456789012')).toEqual({ saved: true, last4: '9012' });
  });
  it('short key never shows a suffix', () => {
    expect(keyHint('12345678901')).toEqual({ saved: true, last4: null });
    expect(keyHint('abc')).toEqual({ saved: true, last4: null });
  });
});
