// Deep check: a whole-text Sonnet pass, with issues to apply or go to, and notes about the whole text.
import { useMemo, useState } from 'react';
import { kindInfo } from '../../../core/kinds';
import { findQuote } from '../../../core/quotes';
import { costLabel, estimateCost, REVIEW_EXPECTED } from '../../../core/review-cost';
import { uniqueEdit } from '../../../core/review-edit';
import type { DocNote } from '../../../core/schema';
import type { LocatedIssue } from '../../../core/types';
import { Diff } from '../../../content/overlay/ToolsPopover';
import { sendMessage, type ApplyEditResult } from '../../../shared/messages';
import { Quote } from '../Quote';
import { REVIEW_COPY } from './copy';
import type { Runs } from './runs';
import { copyText, Problem, useReveal, type CardProps } from './shared';

const C = REVIEW_COPY.deep;

/** What happened to one Deep check fix here: on its way, applied, or too big for an essay. */
type FixMark = 'applying' | 'applied' | 'too_big';
/** Marks per run key, then per issue index; a new run clears its key. */
export type FixMarks = Record<string, Record<number, FixMark>>;

export interface DeepResult {
  issues: LocatedIssue[];
  notes: DocNote[];
}

/**
 * What Go to selects for an issue: its own text, unless an earlier identical passage would be found first; then
 * the smallest window around it that occurs once. Null when the passage is too short to search for.
 */
function goToQuote(sent: string, issue: LocatedIssue): string | null {
  const own = findQuote(sent, issue.original);
  if (own && own.start === issue.start) return issue.original;
  const window = uniqueEdit(sent, issue.start, issue.end, issue.original);
  if (window && findQuote(sent, window.original)) return window.original;
  return own ? issue.original : null;
}

export function DeepCard({
  tabId, fieldId, frameId, text, mode, spend, pricing, runKey, runs: { current, start }, marks, onMarks,
}: CardProps & { runs: Runs<DeepResult>; marks: FixMarks; onMarks: (update: (prev: FixMarks) => FixMarks) => void }) {
  const { notice, reveal } = useReveal(tabId, fieldId, frameId);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const cost = costLabel(estimateCost(pricing, text.length, REVIEW_EXPECTED.deepCheck));
  const mine = marks[runKey] ?? {};
  // A fix still being applied belongs to the run on screen: running again waits for it.
  const canRun = tabId !== null && !current?.busy && !Object.values(mine).includes('applying');
  // Go to windows search the whole text: worked out once per result, not on every render.
  const gotos = useMemo(() => (current?.data ? current.data.issues.map((issue) => goToQuote(current.sent, issue)) : []), [current?.sent, current?.data]);
  const mark = (key: string, i: number, m: FixMark | null) =>
    onMarks((prev) => {
      const { [i]: _, ...rest } = prev[key] ?? {};
      return { ...prev, [key]: m ? { ...rest, [i]: m } : rest };
    });

  const run = () => {
    setApplyNote(null);
    onMarks((prev) => ({ ...prev, [runKey]: {} }));
    return start(runKey, text, async () => {
      const r = await sendMessage('deepCheck', { tabId: tabId!, text, mode });
      return { status: r?.status ?? 'bad_response', data: r?.issues && r.notes ? { issues: r.issues, notes: r.notes } : undefined };
    });
  };

  async function copyFix(fix: string) {
    setApplyNote((await copyText(fix)) ? REVIEW_COPY.applyFailedCopied : REVIEW_COPY.applyFailed);
  }

  async function apply(i: number, issue: LocatedIssue, sent: string) {
    if (tabId === null || issue.replacement === null) return;
    setApplyNote(null);
    const edit = uniqueEdit(sent, issue.start, issue.end, issue.replacement);
    if (!edit) return copyFix(issue.replacement);
    const key = runKey;
    mark(key, i, 'applying');
    let result: ApplyEditResult | null = null;
    try {
      result = (await sendMessage('applyEdit', { fieldId, original: edit.original, replacement: edit.replacement }, { tabId, frameId }))?.result ?? null;
    } catch {
      // the frame is gone
    }
    if (result === 'applied' || result === 'too_big') mark(key, i, result);
    else mark(key, i, null);
    if (result === null) setApplyNote(REVIEW_COPY.unreachable);
    else if (result === 'changed') setApplyNote(REVIEW_COPY.deepChanged);
    else if (result === 'too_big') setApplyNote(REVIEW_COPY.tooBig);
    else if (result !== 'applied') await copyFix(issue.replacement);
  }

  const result = current?.data;
  return (
    <section className="review-card" aria-label={C.heading}>
      <h2>{C.heading}</h2>
      <button type="button" className="btn" disabled={!canRun} onClick={() => void run()}>
        {cost ? C.runWithCost(cost) : C.run}
      </button>
      {cost === null && <p className="muted">{REVIEW_COPY.costUnknown}</p>}
      {current?.busy && <p className="muted" role="status">{REVIEW_COPY.checking}</p>}
      <Problem run={current} spend={spend} />
      {notice && <p className="notice" role="status">{notice}</p>}
      {applyNote && <p className="notice" role="status">{applyNote}</p>}
      {result && current && (
        <div className="review-result">
          {result.issues.length === 0 && result.notes.length === 0 && <p className="muted">{REVIEW_COPY.nothingToFlag}</p>}
          {result.issues.length > 0 && (
            <>
              <h3>{C.issues(result.issues.length)}</h3>
              <ul className="deep-issues">
                {result.issues.map((issue, i) => {
                  const quote = gotos[i] ?? null;
                  const state = mine[i];
                  return (
                    <li key={i} className="deep-issue">
                      <p className="deep-kind">{kindInfo(issue.kind)?.label ?? issue.kind.replace(/_/g, ' ')}</p>
                      <p>
                        {issue.replacement === null ? <q className="quote">{issue.original}</q> : <Diff from={issue.original} to={issue.replacement} />}
                      </p>
                      <div className="deep-actions">
                        {issue.replacement !== null && state !== 'too_big' && (
                          <button
                            type="button"
                            className="btn"
                            aria-label={state === 'applied' ? C.appliedLabel(i + 1) : C.applyLabel(i + 1)}
                            disabled={state !== undefined}
                            onClick={() => void apply(i, issue, current.sent)}
                          >
                            {state === 'applied' ? C.applied : C.apply}
                          </button>
                        )}
                        <button type="button" className="btn" aria-label={C.goToLabel(i + 1)} disabled={quote === null} onClick={() => quote !== null && void reveal(quote)}>
                          {C.goTo}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {result.notes.length > 0 && (
            <>
              <h3>{C.notesHeading}</h3>
              <ul className="deep-notes">
                {result.notes.map((n, i) => (
                  <li key={i}>
                    <p>
                      <strong>{C.notes[n.type]}</strong> <span>{n.text}</span>
                      {n.count !== null && <span className="muted">{C.used(n.count)}</span>}
                    </p>
                    {n.quotes.length > 0 && (
                      <p>
                        {n.quotes.map((q, j) => (
                          <span key={j}>
                            {j > 0 && ' '}
                            <Quote quote={q} text={current.sent} onReveal={reveal} />
                          </span>
                        ))}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
