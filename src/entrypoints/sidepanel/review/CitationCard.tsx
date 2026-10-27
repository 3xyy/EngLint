// The Citation finder: sources for a selected claim, from Sonnet with web search.
import { useMemo } from 'react';
import { CITATION_STYLES, claimAround, formatCitation, isWebUrl, siteOf, type CitationStyle, type Source } from '../../../core/citations';
import { MAX_CLAIM_CHARS, MIN_CLAIM_CHARS } from '../../../core/review';
import { CITATION_MAX_SEARCHES, CITATION_RESULTS_CHARS, costLabel, estimateCost, REVIEW_EXPECTED, type Pricing } from '../../../core/review-cost';
import { sendMessage } from '../../../shared/messages';
import { citationStyleItem } from '../../../shared/settings';
import { useSetting } from '../../../shared/use-setting';
import { CopyButton } from '../Tools';
import { REVIEW_COPY } from './copy';
import type { FieldText } from './field-text';
import type { Runs } from './runs';
import { Problem, type Spend } from './shared';

const C = REVIEW_COPY.citations;

/** A Citation finder answer: the claim searched for, when (the citations' access date) and the sources found. */
export interface CitationResult {
  claim: string;
  accessed: number;
  sources: Source[];
}

/**
 * Sources for the claim selected in the field: the selection as last read, trimmed, with up to 300 characters of
 * text on each side. Citations are formatted here, in the stored style, so a new style needs no new search.
 */
export function CitationCard({
  tabId, field, spend, pricing, runKey, runs: { current, start },
}: { tabId: number | null; field: FieldText; spend: Spend | null; pricing: Pricing; runKey: string; runs: Runs<CitationResult> }) {
  const style = useSetting(citationStyleItem) ?? 'mla';
  // Offsets index into the whole text: the claim may lie past the part a review reads.
  const around = useMemo(() => claimAround(field.text, field.focus), [field.text, field.focus]);
  const claim = around && around.claim.length >= MIN_CLAIM_CHARS ? around : null;
  const tooLong = claim !== null && claim.claim.length > MAX_CLAIM_CHARS;
  const hint = claim === null ? REVIEW_COPY.selectClaim : tooLong ? REVIEW_COPY.claimTooLong : null;
  const canRun = tabId !== null && !current?.busy && claim !== null && !tooLong;
  // No estimate without a claim to search for; null, said in words, for a model with no prices.
  const usd =
    claim && !tooLong
      ? estimateCost(pricing, claim.claim.length + claim.before.length + claim.after.length + CITATION_RESULTS_CHARS, REVIEW_EXPECTED.citations, CITATION_MAX_SEARCHES)
      : undefined;
  const cost = usd === undefined ? null : costLabel(usd);

  const run = () => {
    if (!claim) return;
    const asked = claim;
    return start(runKey, asked.claim, async () => {
      const r = await sendMessage('findCitations', { tabId: tabId!, claim: asked.claim, before: asked.before, after: asked.after });
      return {
        status: r?.status ?? 'bad_response',
        stop: r?.searchOff ? ('searchOff' as const) : r?.refused ? ('refused' as const) : undefined,
        data: r?.sources ? { claim: asked.claim, accessed: Date.now(), sources: r.sources } : undefined,
      };
    });
  };

  const result = current?.data;
  return (
    <section className="review-card" aria-label={C.heading}>
      <h2>{C.heading}</h2>
      <label className="review-field">
        <span>{C.style}</span>
        <select value={style} onChange={(e) => void citationStyleItem.setValue(e.target.value as CitationStyle)}>
          {CITATION_STYLES.map((s) => (
            <option key={s} value={s}>{C.styles[s]}</option>
          ))}
        </select>
      </label>
      {hint && <p className="muted">{hint}</p>}
      <button type="button" className="btn" disabled={!canRun} onClick={() => void run()}>
        {cost ? C.runWithCost(cost) : C.run}
      </button>
      {usd === null && <p className="muted">{REVIEW_COPY.costUnknown}</p>}
      {current?.busy && <p className="muted" role="status">{REVIEW_COPY.searching}</p>}
      {current?.stop ? <p className="notice" role="alert">{REVIEW_COPY[current.stop]}</p> : <Problem run={current} spend={spend} />}
      {result && (
        <div className="review-result">
          <p className="muted">
            {C.sourcesFor}<q>{result.claim}</q>
          </p>
          {result.sources.length === 0 ? (
            <p className="muted">{REVIEW_COPY.noSources}</p>
          ) : (
            <ul className="sources">
              {result.sources.map((s, i) => {
                const citation = formatCitation(style, s, new Date(result.accessed));
                return (
                  <li key={i} className="source">
                    {isWebUrl(s.url) ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title.trim() || siteOf(s.url)}
                      </a>
                    ) : (
                      <span className="source-title">{s.title.trim() || siteOf(s.url)}</span>
                    )}
                    <p className={s.snippet ? 'source-excerpt' : 'muted'}>{s.snippet ? <q>{s.snippet}</q> : REVIEW_COPY.noExcerpt}</p>
                    {s.note && <p>{s.note}</p>}
                    <p className="citation">{citation}</p>
                    <CopyButton text={citation} label={C.copyLabel(i + 1)} idle={C.copy} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
