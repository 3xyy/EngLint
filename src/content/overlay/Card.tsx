import { type MouseEvent, type RefObject, useLayoutEffect, useRef } from 'react';
import type { LocatedIssue } from '../../core/types';
import { byUser } from './ToolsPopover';

const GAP = 6; // between the underlined text and the card
const MARGIN = 8; // from the viewport edge

export interface CardProps {
  issue: LocatedIssue;
  /** Viewport rect of the underlined text the card belongs to. */
  anchor: DOMRect;
  onAccept(): void;
  /** A comment-only note's one action: open the tools popover on its sentence. */
  onRewrite(): void;
  /** `side`: which side of its text the card is on (a dismissal's offer takes the card's place). */
  onDismiss(side: CardSide): void;
  onClose(): void;
  /**
   * An action beside Dismiss ("Stop suggesting …", "Add to dictionary"), only as wide as its label. It writes a
   * setting: only the user's own click runs it. `side`: which side of its text the card is on.
   */
  secondary?: { label: string; onClick(side: CardSide): void };
}

/** Keeps focus (and the caret) in the field: the click still fires, the button just doesn't take focus. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** Where a box against its text starts, before its own size is known (usePlacement then corrects it). */
const initialPlace = (anchor: DOMRect) => ({ left: anchor.left, top: anchor.bottom + GAP });

/** Which side of its text a card (or the undo chip in its place) sits on. */
export type CardSide = 'below' | 'above';

/**
 * Places a fixed box against its text: below when it fits, otherwise above; never past the viewport's sides.
 * The side is chosen on the first placement (or given: `fixedSide`) and kept for the box's life (one open), so
 * a later render never moves it out from under a pointer heading for it. Its top is kept inside the viewport. Sizes are the laid-out ones (offsetWidth/offsetHeight):
 * the client rect is scaled by the enter animation, smaller on its first frames.
 */
function usePlacement(ref: RefObject<HTMLElement | null>, anchor: DOMRect, fixedSide?: CardSide): RefObject<CardSide | null> {
  const side = useRef<CardSide | null>(fixedSide ?? null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN));
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - height;
    side.current ??= below + height <= window.innerHeight - MARGIN || above < MARGIN ? 'below' : 'above';
    el.style.left = `${left}px`;
    // The side stays, but the box never leaves the viewport when its text moves (another line, a scroll).
    const top = Math.max(MARGIN, Math.min(side.current === 'below' ? below : above, window.innerHeight - height - MARGIN));
    el.style.top = `${top}px`;
    el.dataset.side = side.current; // the enter animation grows from the side nearest the text
  });
  return side;
}

/** Just the fix (click to accept) and a bottom row: Dismiss, then the secondary action if any, each as wide as its words. */
export function Card({ issue, anchor, onAccept, onRewrite, onDismiss, onClose, secondary }: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const side = usePlacement(ref, anchor);

  return (
    <div
      ref={ref}
      className="englint-card"
      role="dialog"
      aria-label="EngLint suggestion"
      style={initialPlace(anchor)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {issue.replacement === null ? (
        <button type="button" className="englint-card-rewrite" onMouseDown={keepFocus} onClick={onRewrite}>
          Rewrite this sentence
        </button>
      ) : issue.replacement === '' ? (
        <button
          type="button"
          className="englint-card-fix delete"
          aria-label={`Delete '${issue.original}'`}
          onMouseDown={keepFocus}
          onClick={onAccept}
        >
          <s>{issue.original}</s>
        </button>
      ) : (
        <button
          type="button"
          className="englint-card-fix"
          aria-label={`Replace '${issue.original}' with '${issue.replacement}'`}
          onMouseDown={keepFocus}
          onClick={onAccept}
        >
          {issue.replacement}
        </button>
      )}
      <div className="englint-card-bar">
        <button type="button" className="englint-card-dismiss" onMouseDown={keepFocus} onClick={() => onDismiss(side.current ?? 'below')}>
          Dismiss
        </button>
        {secondary && (
          <button type="button" className="englint-card-secondary" onMouseDown={keepFocus} onClick={byUser(() => secondary.onClick(side.current ?? 'below'))}>
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}

export interface UndoChipProps {
  /** Viewport rect of the text the card was against: the chip takes the card's place. */
  anchor: DOMRect;
  /** The side of that text the card was on (the chip's own size decides when absent). */
  side?: CardSide;
  text: string;
  onUndo(): void;
}

/**
 * After "Stop suggesting" or "Add to dictionary": what changed, and Undo (only the user's own click: it writes a
 * setting). The overlay closes it (5 s, Esc, a click elsewhere).
 */
export function UndoChip({ anchor, side, text, onUndo }: UndoChipProps) {
  const ref = useRef<HTMLDivElement>(null);
  usePlacement(ref, anchor, side);
  return (
    <div ref={ref} className="englint-undo" role="status" style={initialPlace(anchor)}>
      <span className="englint-undo-text">{text}</span>
      <button type="button" className="englint-undo-button" onMouseDown={keepFocus} onClick={byUser(() => onUndo())}>
        Undo
      </button>
    </div>
  );
}

export interface OfferChipProps {
  anchor: DOMRect;
  side?: CardSide;
  question: string;
  /** The yes button's words. */
  yes: string;
  onYes(): void;
  onNo(): void;
}

/**
 * After a dismissal: a question with a yes button and "Not now" (only the user's own click answers: yes writes a
 * setting). Placed and closed as the undo chip is.
 */
export function OfferChip({ anchor, side, question, yes, onYes, onNo }: OfferChipProps) {
  const ref = useRef<HTMLDivElement>(null);
  usePlacement(ref, anchor, side);
  return (
    <div ref={ref} className="englint-undo englint-offer" role="status" style={initialPlace(anchor)}>
      <span className="englint-undo-text">{question}</span>
      <button type="button" className="englint-undo-button" onMouseDown={keepFocus} onClick={byUser(() => onYes())}>
        {yes}
      </button>
      <button type="button" className="englint-undo-button" onMouseDown={keepFocus} onClick={byUser(() => onNo())}>
        Not now
      </button>
    </div>
  );
}
