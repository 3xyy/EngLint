import { findQuote } from '../../core/quotes';

/**
 * A passage a review quoted. It is a button that jumps to the passage only when `text` (what the review read)
 * holds it; a quote the model changed or got wrong is plain text, never a dead button.
 */
export function Quote({ quote, text, onReveal }: { quote: string; text: string; onReveal: (quote: string) => void }) {
  if (!findQuote(text, quote)) return <q className="quote">{quote}</q>;
  return (
    <button type="button" className="quote quote-link" onClick={() => onReveal(quote)}>
      <q>{quote}</q>
    </button>
  );
}
