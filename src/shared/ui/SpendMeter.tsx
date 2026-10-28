import { SPEND_NOT_TRACKED, spendText } from '../status-text';

/**
 * This month's spend: a thin bar filled to its share of the limit, over the words ("$0.14 of $25 this month"). With
 * an unpriced model the words say spending isn't tracked, and there is no bar.
 */
export function SpendMeter({ spend, tracked }: { spend: { spent: number; cap: number }; tracked: boolean }) {
  if (!tracked) return <p className="spend">{SPEND_NOT_TRACKED}</p>;
  const share = spend.cap > 0 ? Math.min(1, spend.spent / spend.cap) : 1;
  return (
    <div className="spend">
      <span className="spend-bar" aria-hidden="true" data-full={share >= 1 ? '' : undefined}>
        <span className="spend-fill" style={{ width: `${Math.round(share * 10000) / 100}%` }} />
      </span>
      <span>{spendText(spend.spent, spend.cap)}</span>
    </div>
  );
}
