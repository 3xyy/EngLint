// The Review agents' runs, kept per field in panel memory.
import { useCallback, useState } from 'react';
import type { CheckStatus } from '../../../core/types';

/** One agent's run for a field: running, or its answer (`data`) or the status that stopped it, with the text it read. */
export interface Run<T> {
  busy: boolean;
  /** The text the agent read: its quotes are matched against this. */
  sent: string;
  status?: CheckStatus;
  data?: T;
  /**
   * The Citation finder only, why it stopped when that has its own line: web search is off for this key's
   * organization, or Claude declined to search for the claim.
   */
  stop?: 'searchOff' | 'refused';
}

/**
 * Where a field's results are kept: tab, page, frame and field (Docs uses one field id in every tab). Null with no
 * tab or no field.
 */
export function runKey(tabId: number | null, pageId: string | null, frameId: number, fieldId: string | null): string | null {
  return tabId !== null && fieldId !== null ? `${tabId}:${pageId ?? ''}:${frameId}:${fieldId}` : null;
}

/**
 * An agent's runs, kept per field in panel memory. A run writes under the field it started for, so an answer
 * that arrives after the panel moved to another field is kept for that field and never shown under this one.
 */
export function useRuns<T>(key: string | null) {
  const [runs, setRuns] = useState<Record<string, Run<T>>>({});
  const start = useCallback(async (id: string, sent: string, ask: () => Promise<{ status: CheckStatus; data?: T; stop?: Run<T>['stop'] }>) => {
    setRuns((prev) => ({ ...prev, [id]: { busy: true, sent } }));
    let out: { status: CheckStatus; data?: T; stop?: Run<T>['stop'] };
    try {
      out = await ask();
    } catch {
      out = { status: 'bad_response' };
    }
    const done: Run<T> =
      out.status === 'ok' && out.data !== undefined
        ? { busy: false, sent, status: 'ok', data: out.data }
        : { busy: false, sent, status: out.status === 'ok' ? 'bad_response' : out.status, ...(out.stop ? { stop: out.stop } : {}) };
    setRuns((prev) => ({ ...prev, [id]: done }));
  }, []);
  return { current: key === null ? undefined : runs[key], start };
}

export type Runs<T> = ReturnType<typeof useRuns<T>>;
