// The Grader: Sonnet rates the text against a pasted prompt or rubric.
import { MAX_RUBRIC_CHARS } from '../../../core/review';
import { costLabel, estimateCost, REVIEW_EXPECTED } from '../../../core/review-cost';
import type { Grading } from '../../../core/review-schema';
import { sendMessage } from '../../../shared/messages';
import { Quote } from '../Quote';
import { REVIEW_COPY } from './copy';
import type { Runs } from './runs';
import { Problem, useReveal, type CardProps } from './shared';

const C = REVIEW_COPY.grader;

export function GraderCard({
  tabId, fieldId, frameId, text, mode, spend, pricing, runKey, runs: { current, start }, rubric, onRubric,
}: CardProps & { runs: Runs<Grading>; rubric: string; onRubric: (r: string) => void }) {
  const { notice, reveal } = useReveal(tabId, fieldId, frameId);
  const asked = rubric.trim();
  const cost = costLabel(estimateCost(pricing, text.length + asked.length, REVIEW_EXPECTED.grader));
  const canRun = tabId !== null && !current?.busy && asked !== '';

  const run = () =>
    start(runKey, text, async () => {
      const r = await sendMessage('reviewGrade', { tabId: tabId!, text, mode, rubric: asked });
      return { status: r?.status ?? 'bad_response', data: r?.grading };
    });

  const grading = current?.data;
  return (
    <section className="review-card" aria-label={C.heading}>
      <h2>{C.heading}</h2>
      <textarea
        className="review-rubric"
        aria-label={C.rubric}
        placeholder={C.rubricPlaceholder}
        rows={4}
        maxLength={MAX_RUBRIC_CHARS}
        value={rubric}
        onChange={(e) => onRubric(e.target.value)}
      />
      {rubric.length >= MAX_RUBRIC_CHARS && <p className="muted">{REVIEW_COPY.rubricCut}</p>}
      <button type="button" className="btn" disabled={!canRun} onClick={() => void run()}>
        {cost ? C.runWithCost(cost) : C.run}
      </button>
      {cost === null && <p className="muted">{REVIEW_COPY.costUnknown}</p>}
      {current?.busy && <p className="muted" role="status">{REVIEW_COPY.grading}</p>}
      <Problem run={current} spend={spend} />
      {notice && <p className="notice" role="status">{notice}</p>}
      {grading && current && (
        <div className="review-result">
          {grading.criteria.map((c, i) => (
            <div key={i} className="criterion">
              <h3>
                {c.name} <span className={`rating rating-${c.rating}`}>{C.ratings[c.rating]}</span>
              </h3>
              <ul>
                {c.evidence.map((e, j) => (
                  <li key={j}>
                    <Quote quote={e.quote} text={current.sent} onReveal={reveal} /> {e.note && <span>{e.note}</span>}
                  </li>
                ))}
              </ul>
              {c.raise && (
                <p>
                  <strong>{C.raise}</strong> <span>{c.raise}</span>
                </p>
              )}
            </div>
          ))}
          {grading.grade && <p className="grade">{C.grade(grading.grade)}</p>}
        </div>
      )}
    </section>
  );
}
