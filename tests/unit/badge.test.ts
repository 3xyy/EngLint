import { describe, expect, it } from 'vitest';
import { badgeFor, errorCount, tabBadge } from '../../src/background/badge';
import type { TabState } from '../../src/background/tab-state';
import type { CheckStatus, LocatedIssue } from '../../src/core/types';

describe('badge', () => {
  it('table matches spec', () => {
    expect(badgeFor('ok', 3)).toEqual({ text: '3', color: '#d93025' });
    expect(badgeFor('ok', 0)).toEqual({ text: '', color: '#d93025' });
    expect(badgeFor('off_site', 5)).toEqual({ text: 'off', color: '#80868b' });
    expect(badgeFor('paused_cap', 5)).toEqual({ text: '$', color: '#f29900' });
    expect(badgeFor('out_of_credit', 5)).toEqual({ text: '$', color: '#f29900' });
    for (const s of ['key_missing', 'key_invalid'] as CheckStatus[])
      expect(badgeFor(s, 5)).toEqual({ text: '!', color: '#d93025' });
    for (const s of ['rate_limited', 'overloaded', 'offline', 'bad_response'] as CheckStatus[])
      expect(badgeFor(s, 5)).toEqual({ text: '…', color: '#80868b' });
    expect(badgeFor('docs_fallback', 5)).toEqual({ text: 'D', color: '#f29900' });
  });
  it('errorCount counts only errors across fields', () => {
    const mk = (severity: 'error' | 'suggestion') => ({ severity }) as LocatedIssue;
    const s = { fields: { a: [mk('error'), mk('suggestion')], b: [mk('error')] } } as unknown as TabState;
    expect(errorCount(s)).toBe(2);
  });
});

describe('tabBadge', () => {
  const state = (status: CheckStatus, errors: number) =>
    ({ status, fields: { f: Array.from({ length: errors }, () => ({ severity: 'error' })) } }) as unknown as TabState;
  it('a switched-off site shows off, whatever its last status', () => {
    expect(tabBadge(null, true)).toEqual({ text: 'off', color: '#80868b' });
    expect(tabBadge(state('ok', 3), true)).toEqual({ text: 'off', color: '#80868b' });
    expect(tabBadge(state('key_invalid', 0), true)).toEqual({ text: 'off', color: '#80868b' });
  });
  it('otherwise the last status and error count, or nothing for a tab with no state', () => {
    expect(tabBadge(state('ok', 3), false)).toEqual({ text: '3', color: '#d93025' });
    expect(tabBadge(state('paused_cap', 3), false)).toEqual({ text: '$', color: '#f29900' });
    expect(tabBadge(null, false)).toEqual({ text: '', color: '#d93025' });
  });
});
