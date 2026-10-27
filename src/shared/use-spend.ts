import { getMonthSpend } from '../background/usage';
import { capUsdItem, spendItem } from './settings';
import { useEffect, useState } from 'react';
import { useSetting } from './use-setting';

/** This month's spend and the cap, refreshed whenever the ledger or the cap changes. */
export function useSpend(): { spent: number; cap: number } | null {
  const ledger = useSetting(spendItem);
  const cap = useSetting(capUsdItem);
  const [spent, setSpent] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void getMonthSpend().then((v) => live && setSpent(v));
    return () => {
      live = false;
    };
  }, [ledger]);
  return spent === null || cap === null ? null : { spent, cap };
}
