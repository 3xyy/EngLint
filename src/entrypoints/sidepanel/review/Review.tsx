// The side panel's Review tab: an Overview of the followed field (local statistics, refreshed while the tab is
// shown) and, below it, one card per review. The field's text is read from its frame (fieldText) by
// useFieldText; nothing here sends it anywhere or logs it.
import { useMemo, useState } from 'react';
import { supportsWebSearch } from '../../../core/provider';
import { providerItem } from '../../../shared/settings';
import { useSetting } from '../../../shared/use-setting';
import { cutForReview } from '../../../core/review';
import { smartPricing } from '../../../core/review-cost';
import type { Grading, ReaderReaction } from '../../../core/review-schema';
import { CitationCard, type CitationResult } from './CitationCard';
import { REVIEW_COPY } from './copy';
import { DeepCard, type DeepResult, type FixMarks } from './DeepCard';
import { useFieldText } from './field-text';
import { GraderCard } from './GraderCard';
import { Overview, type OpenCounts } from './Overview';
import { ReaderCard, type ReaderForm } from './ReaderCard';
import { runKey as keyFor, useRuns } from './runs';
import type { Spend } from './shared';

export function Review({
  tabId,
  pageId = null,
  fieldId,
  frameId,
  shown,
  counts,
  spend,
}: {
  tabId: number | null;
  /** The tab's page id (TabState.pageId): a new page in the same tab starts with no results. */
  pageId?: string | null;
  /** The field the panel follows (TabState's active field), or null when there is none. */
  fieldId: string | null;
  /** The frame that field lives in. */
  frameId: number;
  /** Whether the Review tab is showing: hidden, it reads nothing. */
  shown: boolean;
  counts: OpenCounts;
  spend: Spend | null;
}) {
  const [reachable, setReachable] = useState(true);
  // Nothing about the field shows until the provider settings are read: the Citation finder is Claude's alone, and
  // every estimate is priced on the provider's smart model, so neither may show Claude's by default.
  const provider = useSetting(providerItem);
  const webSearch = provider !== null && supportsWebSearch(provider);
  const pricing = useMemo(() => (provider ? smartPricing(provider) : null), [provider]);
  const field = useFieldText({ tabId, fieldId, frameId, shown, onReach: setReachable });
  // The agents' state lives here, not in their cards: a card is gone while the field is being read.
  const runKey = keyFor(tabId, pageId, frameId, fieldId);
  const readerRuns = useRuns<ReaderReaction>(runKey);
  const graderRuns = useRuns<Grading>(runKey);
  const deepRuns = useRuns<DeepResult>(runKey);
  const citationRuns = useRuns<CitationResult>(runKey);
  const [fixMarks, setFixMarks] = useState<FixMarks>({});
  const [readerForm, setReaderForm] = useState<ReaderForm>({ picked: null, custom: '' });
  const [rubric, setRubric] = useState('');
  const cut = useMemo(() => (field ? cutForReview(field.text) : null), [field]);

  return (
    <section aria-label={REVIEW_COPY.region} className="review">
      {fieldId === null ? (
        <p className="muted">{REVIEW_COPY.noField}</p>
      ) : !reachable ? (
        <p className="notice" role="alert">{REVIEW_COPY.unreachable}</p>
      ) : (
        field && pricing && (
          <>
            {cut?.cut && <p className="muted review-cut">{REVIEW_COPY.cut}</p>}
            <Overview tabId={tabId} text={field.text} mode={field.mode} shown={shown} counts={counts} />
            <ReaderCard runKey={runKey!} tabId={tabId} fieldId={fieldId} frameId={frameId} text={cut!.text} mode={field.mode} spend={spend} pricing={pricing} runs={readerRuns} form={readerForm} onForm={setReaderForm} />
            <GraderCard runKey={runKey!} tabId={tabId} fieldId={fieldId} frameId={frameId} text={cut!.text} mode={field.mode} spend={spend} pricing={pricing} runs={graderRuns} rubric={rubric} onRubric={setRubric} />
            <DeepCard runKey={runKey!} tabId={tabId} fieldId={fieldId} frameId={frameId} text={cut!.text} mode={field.mode} spend={spend} pricing={pricing} runs={deepRuns} marks={fixMarks} onMarks={setFixMarks} />
            {webSearch && <CitationCard runKey={runKey!} tabId={tabId} field={field} spend={spend} pricing={pricing} runs={citationRuns} />}
          </>
        )
      )}
    </section>
  );
}
