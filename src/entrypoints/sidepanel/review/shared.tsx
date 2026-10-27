// Pieces every Review card uses: its props, the problem line, Go to for quotes, and the clipboard.
import { useCallback, useEffect, useState } from 'react';
import type { Pricing } from '../../../core/review-cost';
import type { Mode } from '../../../core/types';
import { sendMessage } from '../../../shared/messages';
import { toolStatusText } from '../../../shared/status-text';
import { useProviderInfo } from '../../../shared/use-provider-info';
import type { useSpend } from '../../../shared/use-spend';
import { REVIEW_COPY } from './copy';
import type { Run } from './runs';

export type Spend = NonNullable<ReturnType<typeof useSpend>>;

export interface CardProps {
  tabId: number | null;
  fieldId: string;
  frameId: number;
  /** The text as cut for review: what an agent reads. */
  text: string;
  mode: Mode;
  spend: Spend | null;
  /** What the run's estimate is priced on: the provider's smart model and the writer's prices (smartPricing). */
  pricing: Pricing;
  /** Where this card's results are kept: tab, page, frame and field. */
  runKey: string;
}

/** Why the last run stopped, when it did not answer. */
export function Problem({ run, spend }: { run: Run<unknown> | undefined; spend: Spend | null }) {
  const who = useProviderInfo();
  const text = run && !run.busy && run.status !== 'ok' && run.status ? toolStatusText(run.status, spend ?? undefined, who) : null;
  return text ? <p className="notice" role="alert">{text}</p> : null;
}

/** Jumps to a quote in the followed field; `notice` says when the passage is gone. */
export function useReveal(tabId: number | null, fieldId: string | null, frameId: number) {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setNotice(null), [tabId, fieldId, frameId]);
  const reveal = useCallback(
    async (quote: string) => {
      if (tabId === null || fieldId === null) return;
      try {
        const r = await sendMessage('revealText', { fieldId, quote }, { tabId, frameId });
        setNotice(r?.found ? null : REVIEW_COPY.passageChanged);
      } catch {
        setNotice(REVIEW_COPY.unreachable);
      }
    },
    [tabId, fieldId, frameId],
  );
  return { notice, reveal };
}

/** Puts `text` on the clipboard; false when the browser refuses (no focus or permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
