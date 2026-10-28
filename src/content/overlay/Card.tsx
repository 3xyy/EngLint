import { type KeyboardEvent, type MouseEvent, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react';
import { shownFamily } from '../../core/kinds';
import type { LocatedIssue } from '../../core/types';
import { Button, DiffPreview, IconButton, TypeLabel } from '../../shared/ui/controls';
import { DotsIcon } from '../../shared/ui/icons';
import { byUser } from './by-user';

const GAP = 6; // between the underlined text and the card
const MARGIN = 8; // from the viewport edge

export interface CardProps {
  issue: LocatedIssue;
  /** The field's text just before and after the issue: the preview shows up to 6 words of each. */
  context?: { before: string; after: string };
  /** Viewport rect of the underlined text the card belongs to. */
  anchor: DOMRect;
  onAccept(): void;
  /** Opens the tools popover on the issue's sentence: "Rewrite sentence", a comment-only note's primary or in the menu. */
  onRewrite(): void;
  /** `side`: which side of its text the card is on (a dismissal's offer takes the card's place). */
  onDismiss(side: CardSide): void;
  onClose(): void;
  /**
   * The setting action in the "⋯" menu ("Stop suggesting …", "Add “word” to dictionary"). It writes a setting:
   * only the user's own click runs it. `side`: which side of its text the card is on.
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

/** "replace 'has' with 'have'", "delete 'very '": what Accept does, for its accessible name. */
const change = (issue: LocatedIssue) =>
  issue.replacement ? `replace '${issue.original}' with '${issue.replacement}'` : `delete '${issue.original}'`;

/**
 * What type of change it is (and the "⋯" menu), the change in its context, the reason, then the primary (Accept,
 * or a comment-only note's "Rewrite sentence") and Dismiss. Enter, with focus in the card but not on another
 * button, does the primary; Escape closes it.
 */
export function Card({ issue, context, anchor, onAccept, onRewrite, onDismiss, onClose, secondary }: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const side = usePlacement(ref, anchor);
  const note = issue.replacement === null;
  const primary = note ? onRewrite : onAccept;
  const menu: MenuItem[] = [
    ...(secondary ? [{ label: secondary.label, onSelect: byUser(() => secondary.onClick(side.current ?? 'below')) }] : []),
    ...(note ? [] : [{ label: 'Rewrite sentence', onSelect: onRewrite }]),
  ];

  return (
    <div
      ref={ref}
      className={`englint-card el-fam-${shownFamily(issue)}`}
      role="dialog"
      aria-label="EngLint suggestion"
      tabIndex={-1}
      style={initialPlace(anchor)}
      onMouseDown={keepFocus} // nothing on it, button or text, takes focus (and the caret) from the field
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        // Another button's Enter is its own (Dismiss, "⋯", a menu item); Accept's is its click.
        else if (e.key === 'Enter' && !(e.target as Element).closest('button')) {
          e.preventDefault();
          primary();
        }
      }}
    >
      <div className="englint-card-head">
        <TypeLabel issue={issue} className="englint-card-type" />
        {menu.length > 0 && <CardMenu items={menu} />}
      </div>
      <DiffPreview
        className="englint-card-preview"
        before={context?.before ?? ''}
        after={context?.after ?? ''}
        original={issue.original}
        replacement={issue.replacement}
      />
      {issue.reason && <p className="englint-card-reason">{issue.reason}</p>}
      <div className="englint-card-actions">
        {note ? (
          <Button variant="primary" size="sm" className="englint-card-rewrite" onClick={onRewrite}>
            Rewrite sentence
          </Button>
        ) : (
          <Button variant="primary" size="sm" className="englint-card-accept" aria-label={`Accept: ${change(issue)}`} onClick={onAccept}>
            Accept
          </Button>
        )}
        <Button variant="ghost" size="sm" className="englint-card-dismiss" onClick={() => onDismiss(side.current ?? 'below')}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

interface MenuItem {
  label: string;
  onSelect(e: MouseEvent): void;
}

/**
 * The "⋯" button and its menu. A pointer opens it and leaves focus in the field; a key (Enter, Space, or an arrow)
 * opens it with focus on an item. In the menu the arrows, Home and End move and wrap; Escape closes it and focuses
 * "⋯" (the card stays); Tab closes it.
 */
function CardMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const focusOnOpen = useRef<number | null>(null); // the item a key's open focuses
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const all = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const focusItem = (i: number) => {
    const els = all();
    els[(i + els.length) % els.length]?.focus();
  };
  useLayoutEffect(() => {
    if (!open || focusOnOpen.current === null) return;
    focusItem(focusOnOpen.current);
    focusOnOpen.current = null;
  }, [open]);
  const openAt = (i: number | null) => {
    focusOnOpen.current = i;
    setOpen(true);
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = all().indexOf(e.target as HTMLElement);
    const move: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: -1 };
    if (e.key in move) {
      e.preventDefault();
      focusItem(move[e.key]!);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // the card stays open
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };
  return (
    <div className="englint-card-more">
      <IconButton
        ref={button}
        label="More actions"
        icon={<DotsIcon />}
        tipAlign="end"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => (open ? setOpen(false) : openAt(e.detail === 0 ? 0 : null))} // detail 0: Enter or Space
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          openAt(e.key === 'ArrowDown' ? 0 : -1);
        }}
      />
      {open && (
        <div ref={list} id={id} role="menu" aria-label="More actions" className="englint-menu" onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" tabIndex={-1} className="englint-menu-item" onClick={item.onSelect}>
              {item.label}
            </button>
          ))}
        </div>
      )}
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
      <Button variant="ghost" size="sm" className="englint-undo-button englint-undo-accent" onMouseDown={keepFocus} onClick={byUser(() => onUndo())}>
        Undo
      </Button>
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
      <Button variant="primary" size="sm" className="englint-undo-button" onMouseDown={keepFocus} onClick={byUser(() => onYes())}>
        {yes}
      </Button>
      <Button variant="ghost" size="sm" className="englint-undo-button" onMouseDown={keepFocus} onClick={byUser(() => onNo())}>
        Not now
      </Button>
    </div>
  );
}
