// The followed field's text, read from its frame (fieldText). Nothing here sends it anywhere or logs it.
import { useEffect, useRef, useState } from 'react';
import type { ChatFocus } from '../../../core/chat-format';
import { OVERVIEW_POLL_MS } from '../../../core/review';
import type { Mode } from '../../../core/types';
import { sendMessage } from '../../../shared/messages';

/** The field's text as last read, with its selection (or caret) and the page's mode. */
export interface FieldText {
  text: string;
  focus: ChatFocus;
  mode: Mode;
}

/**
 * The field's text, read once when `shown` turns on or the field changes, then every OVERVIEW_POLL_MS while
 * `shown` and the document is visible. null until the first read, after the field changes, and while it can't
 * be reached (`onReach` says which). Hidden, it reads nothing.
 */
export function useFieldText({
  tabId,
  fieldId,
  frameId,
  shown,
  onReach,
}: {
  tabId: number | null;
  fieldId: string | null;
  frameId: number;
  shown: boolean;
  onReach?: (reachable: boolean) => void;
}): FieldText | null {
  const [value, setValue] = useState<FieldText | null>(null);
  const reach = useRef(onReach);
  reach.current = onReach;

  // A different field or frame starts from nothing; showing and hiding the tab keeps the last read.
  useEffect(() => {
    setValue(null);
    reach.current?.(true);
  }, [tabId, fieldId, frameId]);

  useEffect(() => {
    if (!shown || tabId === null || fieldId === null) return;
    let live = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const r = await sendMessage('fieldText', { fieldId }, { tabId, frameId });
        if (!live) return;
        if (!r?.ok || typeof r.text !== 'string') throw new Error('unreadable');
        const next: FieldText = { text: r.text, focus: r.focus ?? null, mode: r.mode ?? 'standard' };
        setValue((prev) =>
          prev && prev.text === next.text && prev.mode === next.mode && prev.focus?.start === next.focus?.start && prev.focus?.end === next.focus?.end
            ? prev
            : next,
        );
        reach.current?.(true);
      } catch {
        if (!live) return;
        setValue(null);
        reach.current?.(false);
      } finally {
        reading = false;
      }
    };
    const visible = () => document.visibilityState === 'visible';
    void read();
    const timer = setInterval(() => visible() && void read(), OVERVIEW_POLL_MS);
    const onVisible = () => visible() && void read();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [shown, tabId, fieldId, frameId]);

  return value;
}
