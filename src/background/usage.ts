import { capUsdItem, spendItem } from '../shared/settings';

/** 'YYYY-MM' in local time. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function getMonthSpend(now: Date = new Date()): Promise<number> {
  const spend = await spendItem.getValue();
  return spend[monthKey(now)] ?? 0;
}

// Serializes read-modify-write so concurrent checks cannot lose updates.
let writeChain: Promise<unknown> = Promise.resolve();

/** Adds usd to the current month and returns the new month total. NaN, infinite or negative amounts add nothing. */
export function recordSpend(usd: number, now: Date = new Date()): Promise<number> {
  const run = writeChain.then(async () => {
    const spend = await spendItem.getValue();
    const key = monthKey(now);
    // A NaN would be stored as null and reset the month's total.
    if (!Number.isFinite(usd) || usd < 0) return spend[key] ?? 0;
    const total = (spend[key] ?? 0) + usd;
    await spendItem.setValue({ ...spend, [key]: total });
    return total;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

export async function isOverCap(now: Date = new Date()): Promise<boolean> {
  const [spent, cap] = await Promise.all([getMonthSpend(now), capUsdItem.getValue()]);
  return spent >= cap;
}
