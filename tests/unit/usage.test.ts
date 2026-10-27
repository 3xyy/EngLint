import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getMonthSpend, isOverCap, monthKey, recordSpend } from '../../src/background/usage';
import { capUsdItem } from '../../src/shared/settings';

beforeEach(() => fakeBrowser.reset());

describe('spend ledger', () => {
  it('monthKey is YYYY-MM in local time', () => {
    expect(monthKey(new Date(2026, 9, 31, 12))).toBe('2026-10');
  });
  it('spend accumulates within a month', async () => {
    const now = new Date(2026, 9, 5, 12);
    await recordSpend(0.25, now);
    expect(await recordSpend(0.5, now)).toBeCloseTo(0.75);
    expect(await getMonthSpend(now)).toBeCloseTo(0.75);
  });
  it('concurrent recordSpend calls do not lose updates', async () => {
    const now = new Date(2026, 9, 5, 12);
    await Promise.all([recordSpend(1, now), recordSpend(2, now)]);
    expect(await getMonthSpend(now)).toBeCloseTo(3);
  });
  it('ignores NaN, infinite and negative amounts', async () => {
    const now = new Date(2026, 9, 5, 12);
    await recordSpend(0.5, now);
    expect(await recordSpend(Number.NaN, now)).toBeCloseTo(0.5);
    expect(await recordSpend(-1, now)).toBeCloseTo(0.5);
    expect(await recordSpend(Number.POSITIVE_INFINITY, now)).toBeCloseTo(0.5);
    expect(await getMonthSpend(now)).toBeCloseTo(0.5);
  });
  it('Nov 1 starts at 0 after Oct 31 spend', async () => {
    await recordSpend(3, new Date(2026, 9, 31, 12));
    expect(await getMonthSpend(new Date(2026, 10, 1, 12))).toBe(0);
  });
  it('isOverCap true at cap', async () => {
    const now = new Date(2026, 9, 5, 12);
    await capUsdItem.setValue(1);
    expect(await isOverCap(now)).toBe(false);
    await recordSpend(1.0, now);
    expect(await isOverCap(now)).toBe(true);
  });
});
