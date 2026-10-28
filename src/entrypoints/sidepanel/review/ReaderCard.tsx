// Reader reactions: Sonnet reads the text as the picked reader.
import { READER_CHOICES, MAX_READER_CHARS, type ReaderChoice } from '../../../core/review';
import { costLabel, estimateCost, REVIEW_EXPECTED } from '../../../core/review-cost';
import type { ReaderReaction } from '../../../core/review-schema';
import { sendMessage } from '../../../shared/messages';
import { Button } from '../../../shared/ui/controls';
import { Quote } from '../Quote';
import { REVIEW_COPY } from './copy';
import type { Runs } from './runs';
import { Problem, useReveal, type CardProps } from './shared';

const C = REVIEW_COPY.readers;

/** The reader picker's state, kept by Review so it outlives the card (the card goes while a field is being read). */
export interface ReaderForm {
  picked: ReaderChoice | null;
  custom: string;
}

export function ReaderCard({
  tabId, fieldId, frameId, text, mode, spend, pricing, runKey, runs: { current, start }, form: { picked, custom }, onForm,
}: CardProps & { runs: Runs<ReaderReaction>; form: ReaderForm; onForm: (f: ReaderForm) => void }) {
  const { notice, reveal } = useReveal(tabId, fieldId, frameId);
  const reader = picked ?? (mode === 'essay' ? 'admissions' : 'general');
  const description = custom.trim();
  const cost = costLabel(estimateCost(pricing, text.length + (reader === 'custom' ? description.length : 0), REVIEW_EXPECTED.readers));
  const canRun = tabId !== null && !current?.busy && (reader !== 'custom' || description !== '');

  const run = () =>
    start(runKey, text, async () => {
      const r = await sendMessage('reviewReaders', { tabId: tabId!, text, mode, reader, ...(reader === 'custom' ? { custom: description } : {}) });
      return { status: r?.status ?? 'bad_response', data: r?.reaction };
    });

  const reaction = current?.data;
  return (
    <section className="review-card" aria-label={C.heading}>
      <h2>{C.heading}</h2>
      <label className="review-field">
        <span>{C.reader}</span>
        <select value={reader} onChange={(e) => onForm({ picked: e.target.value as ReaderChoice, custom })}>
          {READER_CHOICES.map((r) => (
            <option key={r} value={r}>{C.labels[r]}</option>
          ))}
        </select>
      </label>
      {reader === 'custom' && (
        <input
          type="text"
          className="review-input"
          aria-label={C.describe}
          placeholder={C.describePlaceholder}
          maxLength={MAX_READER_CHARS}
          value={custom}
          onChange={(e) => onForm({ picked, custom: e.target.value })}
        />
      )}
      <Button size="sm" className="review-run" disabled={!canRun} onClick={() => void run()}>
        {cost ? C.runWithCost(cost) : C.run}
      </Button>
      {cost === null && <p className="muted">{REVIEW_COPY.costUnknown}</p>}
      {current?.busy && <p className="muted" role="status">{REVIEW_COPY.reading}</p>}
      <Problem run={current} spend={spend} />
      {notice && <p className="notice" role="status">{notice}</p>}
      {reaction && current && (
        <div className="review-result">
          <h3>{C.firstImpression}</h3>
          <p>{reaction.firstImpression}</p>
          <h3>{C.remember}</h3>
          <ul>{reaction.remember.map((x, i) => <li key={i}>{x}</li>)}</ul>
          <h3>{C.questions}</h3>
          <ul>{reaction.questions.map((x, i) => <li key={i}>{x}</li>)}</ul>
          <h3>{C.lost}</h3>
          {reaction.lost.length === 0 ? (
            <p className="muted">{REVIEW_COPY.nowhere}</p>
          ) : (
            <ul>
              {reaction.lost.map((l, i) => (
                <li key={i}>
                  <Quote quote={l.quote} text={current.sent} onReveal={reveal} /> <span>{l.why}</span>
                </li>
              ))}
            </ul>
          )}
          <h3>{C.strength}</h3>
          <p>
            {reaction.strength.quote && <Quote quote={reaction.strength.quote} text={current.sent} onReveal={reveal} />}{' '}
            <span>{reaction.strength.why}</span>
          </p>
        </div>
      )}
    </section>
  );
}
