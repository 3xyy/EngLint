import { Fragment, type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { barActionsFor, type BarAction, type BarItem, type BarRun } from '../../core/presets';
import type { Mode } from '../../core/types';
import { Button } from '../../shared/ui/controls';
import { ChevronDownIcon, SparkleIcon } from '../../shared/ui/icons';
import { TOOLS_COPY } from '../tools/tools-controller';
import { byUser } from './by-user';

/** The bar's height, px (overlay.css .englint-bar). */
const BAR_HEIGHT = 36;
/** Between the selection and the bar, px. */
const GAP = 6;
/** From the viewport's edges, px. */
const MARGIN = 8;
const BAR_ITEMS = '[data-bar-item]:not(:disabled)';
const MENU_ITEMS = '[role="menuitem"]:not(:disabled)';

/**
 * Where the bar sits for a selection whose viewport box is `at`: just above it, from its left edge, kept inside the
 * viewport; below it when there is no room above.
 */
export function barPosition(
  at: DOMRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; side: 'above' | 'below' } {
  const left = Math.max(MARGIN, Math.min(at.left, viewport.width - size.width - MARGIN));
  const above = at.top - GAP - size.height;
  if (above >= MARGIN) return { left, top: above, side: 'above' };
  return { left, top: Math.max(MARGIN, Math.min(at.bottom + GAP, viewport.height - size.height - MARGIN)), side: 'below' };
}

export interface SelectionBarProps {
  /** The selection's box in the viewport. */
  at: DOMRect;
  mode: Mode;
  /** The selection is one word: Synonyms gets its own button. */
  singleWord?: boolean;
  /**
   * The selection is over the tools' limits (selection.ts overLimit): 'rewrites', only Fit a word limit is on;
   * 'all', nothing is. A line under the bar says why.
   */
  tooLong?: 'rewrites' | 'all';
  /** A button or menu item: a tool request, or 'custom-prompt' ("Ask anything…" on a bar that has no box). */
  onPick(run: BarRun): void;
  /**
   * The bar the popover shows (the shortcut, "Ask anything…" from the right-click menu): it takes focus when it opens,
   * on its first button that is on or, with 'custom', in its "Ask anything…" box. Absent: the bar beside a selection,
   * which never takes focus.
   */
  focus?: 'first' | 'custom';
  /** The "Ask anything…" box's instruction (Enter or its button). With it, "Ask anything…" opens the box in the bar. */
  onAsk?(instruction: string): void;
}

/**
 * The bar above a field's selection: Improve, Shorten ▾, Tone ▾, My voice, Synonyms (one word) and More ▾. It lives
 * in the fixed overlay. Pressing it never moves focus or the selection out of the field (its mousedown is
 * prevented, except in its box), and only the user's own click or key runs anything (byUser, I3). Left and right
 * arrows move along it; down (or Enter) opens a menu, whose arrows, Home and End move and wrap; Escape closes the
 * menu and Tab leaves it. The keys skip what is off. For a selection over the tools' limits (`tooLong`), what
 * can't take it is off, a menu with nothing on is off whole, and a line under the bar says why.
 */
export function SelectionBar({ at, mode, singleWord = false, tooLong, onPick, focus, onAsk }: SelectionBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; focusAt: number | null } | null>(null);
  const [asking, setAsking] = useState(focus === 'custom' && !tooLong);
  const [instruction, setInstruction] = useState('');
  const uid = useId();
  const actions = barActionsFor(mode, singleWord);
  /** Whether the selection's length lets `run` take it. */
  const takes = (run: BarRun) => !tooLong || (tooLong === 'rewrites' && run !== 'custom-prompt' && run.kind === 'wordLimit');
  const hint = tooLong === 'rewrites' ? TOOLS_COPY.onlyLimit : tooLong === 'all' ? TOOLS_COPY.tooLongForLimit : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = barPosition(at, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    el.style.left = `${place.left}px`;
    el.style.top = `${place.top}px`;
    el.dataset.side = place.side; // the enter animation grows from the side nearest the text
  });

  // The popover's bar takes focus when it opens, and the box when it appears.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || (!focus && !asking)) return;
    (el.querySelector<HTMLElement>(asking ? 'input' : BAR_ITEMS) ?? el).focus({ preventScroll: true });
  }, [asking]);

  // An open menu: focus on the item a key asked for; kept inside the viewport (up, or right-aligned, where it must).
  useLayoutEffect(() => {
    const list = menuRef.current;
    if (!menu || !list) return;
    delete list.dataset.up;
    delete list.dataset.end;
    const box = list.getBoundingClientRect();
    if (box.bottom > window.innerHeight - MARGIN) list.dataset.up = '';
    if (box.right > window.innerWidth - MARGIN) list.dataset.end = '';
    if (menu.focusAt !== null) focusIn(list, MENU_ITEMS, menu.focusAt);
  }, [menu]);

  const barItems = () => [...(ref.current?.querySelectorAll<HTMLElement>(BAR_ITEMS) ?? [])];
  const run = (r: BarRun) => {
    setMenu(null);
    if (r === 'custom-prompt' && onAsk) setAsking(true);
    else onPick(r);
  };
  const toggle = (id: string, focusAt: number | null) => setMenu((open) => (open?.id === id ? null : { id, focusAt }));
  const moveAlong = (from: HTMLElement, step: number) => {
    const items = barItems();
    const button = from.closest('.englint-bar-group')?.querySelector<HTMLElement>(BAR_ITEMS) ?? from;
    setMenu(null);
    focusIn(ref.current!, BAR_ITEMS, items.indexOf(button) + step);
  };

  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    const inMenu = !!target.closest('[role="menu"]');
    if (inMenu) return onMenuKey(e, target);
    const at = barItems().indexOf(target);
    if (at < 0) return;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in step) {
      e.preventDefault();
      moveAlong(target, step[e.key]!);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setMenu(null);
      focusIn(ref.current!, BAR_ITEMS, e.key === 'Home' ? 0 : -1);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && target.dataset.menu) {
      e.preventDefault();
      setMenu({ id: target.dataset.menu, focusAt: e.key === 'ArrowDown' ? 0 : -1 });
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>, target: HTMLElement) => {
    const list = menuRef.current;
    if (!list || !menu) return;
    const items = [...list.querySelectorAll<HTMLElement>(MENU_ITEMS)];
    const at = items.indexOf(target);
    const move: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: -1 };
    if (e.key in move) {
      e.preventDefault();
      focusIn(list, MENU_ITEMS, move[e.key]!);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveAlong(target, e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // the bar stays
      setMenu(null);
      ref.current?.querySelector<HTMLElement>(`[data-menu="${menu.id}"]`)?.focus();
    } else if (e.key === 'Tab') {
      setMenu(null);
    }
  };

  const button = (a: Extract<BarAction, { kind: 'button' }>) => (
    <button
      key={a.id}
      type="button"
      data-bar-item=""
      className={a.id === 'improve' ? 'englint-bar-btn englint-bar-primary' : 'englint-bar-btn'}
      disabled={!takes(a.run)}
      onClick={byUser(() => run(a.run))}
    >
      {a.id === 'improve' && <SparkleIcon size={15} />}
      {a.label}
    </button>
  );

  const group = (a: Extract<BarAction, { kind: 'menu' }>) => {
    const open = menu?.id === a.id;
    const id = `${uid}-${a.id}`;
    return (
      <div key={a.id} className="englint-bar-group">
        <button
          type="button"
          data-bar-item=""
          data-menu={a.id}
          className="englint-bar-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          disabled={!a.items.some((item) => takes(item.run))}
          onClick={byUser((e) => toggle(a.id, e.detail === 0 ? 0 : null))} // detail 0: Enter or Space
        >
          {a.label}
          <ChevronDownIcon size={14} className="englint-bar-chevron" />
        </button>
        {open && (
          <div ref={menuRef} id={id} role="menu" aria-label={a.label} className="englint-menu englint-bar-menu">
            {a.items.map((item: BarItem) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="englint-menu-item"
                disabled={!takes(item.run)}
                onClick={byUser(() => run(item.run))}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const items = actions.map((a) => (
    <Fragment key={a.id}>
      {a.id === 'more' && <span className="englint-bar-sep" aria-hidden="true" />}
      {a.kind === 'button' ? button(a) : group(a)}
    </Fragment>
  ));

  return (
    <div
      ref={ref}
      className={asking ? 'englint-bar englint-bar-asking' : hint ? 'englint-bar englint-bar-long' : 'englint-bar'}
      role="toolbar"
      aria-label="EngLint"
      aria-describedby={hint && !asking ? `${uid}-hint` : undefined}
      style={{ left: at.left, top: at.top - GAP - BAR_HEIGHT }}
      onMouseDown={(e) => {
        if (!(e.target as Element).closest('input')) e.preventDefault(); // the field keeps focus and its selection
      }}
      onKeyDown={onBarKey}
    >
      {asking ? (
        <>
          <SparkleIcon size={15} className="englint-bar-ask-icon" />
          <input
            type="text"
            className="englint-bar-input"
            placeholder="Tell EngLint what to do…"
            aria-label="Tell EngLint what to do"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={byUser((e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              onAsk?.(instruction);
            })}
          />
          <Button variant="primary" size="sm" disabled={instruction.trim() === ''} onClick={byUser(() => onAsk?.(instruction))}>
            Rewrite
          </Button>
        </>
      ) : hint ? (
        <>
          <div className="englint-bar-row">{items}</div>
          <p id={`${uid}-hint`} className="englint-bar-hint">
            {hint}
          </p>
        </>
      ) : (
        items
      )}
    </div>
  );
}

/** Focuses the `i`th of `root`'s `selector` matches, wrapping both ways (-1: the last). */
function focusIn(root: HTMLElement, selector: string, i: number) {
  const els = [...root.querySelectorAll<HTMLElement>(selector)];
  if (els.length) els[((i % els.length) + els.length) % els.length]!.focus({ preventScroll: true });
}
