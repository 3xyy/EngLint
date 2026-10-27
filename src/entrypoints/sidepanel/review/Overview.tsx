// The Overview card: local statistics of the followed field, its open counts, and the tone line.
import { useEffect, useMemo, useRef, useState } from 'react';
import { docStats, formatDuration } from '../../../core/doc-stats';
import { cutForReview, TONE_IDLE_MS, TONE_MIN_WORDS } from '../../../core/review';
import type { Mode } from '../../../core/types';
import { sendMessage } from '../../../shared/messages';
import { REVIEW_COPY } from './copy';

export interface OpenCounts {
  errors: number;
  clarity: number;
  engagement: number;
  delivery: number;
}

const C = REVIEW_COPY.overview;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The tone line: once the text has stayed the same for TONE_IDLE_MS while the tab is shown, and has enough
 * words, the background reads its tone. Each text and mode is asked about once; the line shows an answer only for
 * the text on screen, and a failure reads "unavailable" until the text changes.
 */
function ToneLine({ tabId, text, mode, words, shown }: { tabId: number | null; text: string; mode: Mode; words: number; shown: boolean }) {
  const [result, setResult] = useState<{ key: string; tones: string[] | null } | null>(null);
  const asked = useRef<string | null>(null);
  const ready = shown && tabId !== null && words >= TONE_MIN_WORDS;
  const key = `${mode}\n${text}`;

  useEffect(() => {
    if (!ready || asked.current === key) return;
    const timer = setTimeout(() => {
      asked.current = key;
      // An answer counts only while it is for the newest question; the line shows it only for the text on screen.
      const answer = (tones: string[] | null) => asked.current === key && setResult({ key, tones });
      sendMessage('reviewTone', { tabId: tabId!, text, mode })
        .then((r) => answer(r?.status === 'ok' && r.tones?.length ? r.tones : null))
        .catch(() => answer(null));
    }, TONE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [ready, tabId, key]);

  let line: string = REVIEW_COPY.toneWaiting;
  if (words < TONE_MIN_WORDS) line = REVIEW_COPY.toneShort;
  else if (result?.key === key) line = result.tones ? C.tone(result.tones) : REVIEW_COPY.toneFailed;
  return <p className="tone-line">{line}</p>;
}

export function Overview({ tabId, text, mode, shown, counts }: { tabId: number | null; text: string; mode: Mode; shown: boolean; counts: OpenCounts }) {
  const s = useMemo(() => docStats(text), [text]);
  const sent = useMemo(() => cutForReview(text).text, [text]);
  return (
    <section className="review-card" aria-label={C.heading}>
      <h2>{C.heading}</h2>
      <dl className="stats">
        <Stat label={C.words} value={String(s.words)} />
        <Stat label={C.characters} value={String(s.characters)} />
        <Stat label={C.sentences} value={String(s.sentences)} />
        <Stat label={C.readingTime} value={formatDuration(s.readingSeconds)} />
        <Stat label={C.speakingTime} value={formatDuration(s.speakingSeconds)} />
        <Stat label={C.avgSentence} value={C.avgSentenceValue(s.avgSentenceWords)} />
        <Stat label={C.readability} value={s.flesch ? C.readabilityValue(s.flesch.score, s.flesch.label) : REVIEW_COPY.shortText} />
        <Stat label={C.uniqueWords} value={C.percent(s.uniquePct)} />
        <Stat label={C.longWords} value={C.percent(s.longPct)} />
      </dl>
      <ToneLine tabId={tabId} text={sent} mode={mode} words={s.words} shown={shown} />
      <h3>{C.openHeading}</h3>
      <dl className="stats">
        <Stat label={C.errors} value={String(counts.errors)} />
        <Stat label={C.clarity} value={String(counts.clarity)} />
        <Stat label={C.engagement} value={String(counts.engagement)} />
        <Stat label={C.delivery} value={String(counts.delivery)} />
      </dl>
    </section>
  );
}
