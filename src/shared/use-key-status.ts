import { useCallback, useEffect, useState } from 'react';
import type { KeySlot } from '../core/provider';
import { sendMessage } from './messages';
import { keyChangedItem } from './key-changed';

/**
 * Whether a key is saved in `slot` (default: the active provider's), and its hint, asked of the background: pages
 * never read the key itself.
 */
export function useKeyStatus(slot?: KeySlot): { status: { saved: boolean; last4: string | null } | null; failed: boolean; refresh(): void } {
  const [status, setStatus] = useState<{ saved: boolean; last4: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    void sendMessage('keyStatus', slot ? { slot } : undefined).then(
      (v) => {
        setFailed(false);
        setStatus(v);
      },
      () => setFailed(true),
    );
  }, [slot]);
  useEffect(() => {
    refresh();
    // The background stamps the time of each key change (the key itself is never in storage).
    return keyChangedItem.watch(() => refresh());
  }, [refresh]);
  return { status, failed, refresh };
}
