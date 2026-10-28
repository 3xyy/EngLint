import type { ComponentPropsWithRef, KeyboardEvent, ReactNode } from 'react';
import { shownFamily, typeLabel } from '../../core/kinds';
import type { RawIssue } from '../../core/types';

// The shared controls, styled by controls.css (loaded into the overlay's shadow roots and every extension page).
// Every class starts with `el-`, clear of the pages' own `.btn`, `.tab` and the overlay's `englint-` classes.

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: 'primary' | 'secondary' | 'ghost';
  /** sm: 28px tall, for cards and toolbars; md (default): 32px. */
  size?: 'sm' | 'md';
}

/** A text button; other props (onMouseDown to keep the field's focus, disabled, a ref) reach the <button>. */
export function Button({ variant = 'secondary', size = 'md', type = 'button', className, ...rest }: ButtonProps) {
  return <button type={type} className={cx('el-btn', `el-btn-${variant}`, size === 'sm' && 'el-btn-sm', className)} {...rest} />;
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> {
  /** The accessible name, which the tooltip also shows (on hover and keyboard focus). */
  label: string;
  icon: ReactNode;
  /** The tooltip's side. */
  tip?: 'top' | 'bottom';
  /** end: the tooltip's right edge lines up with the button's, for a button near the right edge. */
  tipAlign?: 'center' | 'end';
}

export function IconButton({ label, icon, tip = 'top', tipAlign = 'center', type = 'button', className, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      data-tip={tip}
      data-tip-align={tipAlign === 'end' ? 'end' : undefined}
      className={cx('el-icon-btn', className)}
      {...rest}
    >
      {icon}
    </button>
  );
}

export interface SwitchProps extends Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'role' | 'children'> {
  checked: boolean;
  /**
   * Half on (a setting on in some places only): the thumb sits mid-track. A switch has no mixed state for assistive
   * technology, so it reads as off; say where it is on in a description (aria-describedby).
   */
  mixed?: boolean;
  onChange(checked: boolean): void;
}

/** An on/off button (role="switch"): a click, Space or Enter flips it. Name it with aria-label or a wrapping <label>. */
export function Switch({ checked, mixed = false, onChange, disabled, type = 'button', className, onClick, onKeyDown, ...rest }: SwitchProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      data-mixed={mixed && !checked ? '' : undefined}
      disabled={disabled}
      className={cx('el-switch', className)}
      onClick={(e) => {
        onClick?.(e);
        if (!disabled && !e.defaultPrevented) onChange(!checked);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || (e.key !== ' ' && e.key !== 'Enter')) return;
        e.preventDefault(); // the button's own key activation would flip it a second time
        if (!disabled && !e.repeat) onChange(!checked);
      }}
      {...rest}
    >
      <span className="el-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** As tabs: the tab's id, and the id of the panel it shows. */
  id?: string;
  controls?: string;
}

export interface SegmentedProps<T extends string> {
  /** The group's accessible name. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: NoInfer<T>;
  onChange(value: NoInfer<T>): void;
  /** radio (default): a choice of one (radiogroup); tab: a tab bar (tablist) whose options show panels. */
  as?: 'radio' | 'tab';
  className?: string;
}

const NEXT: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i) => i + 1,
  ArrowLeft: (i) => i - 1,
  ArrowDown: (i) => i + 1,
  ArrowUp: (i) => i - 1,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

/**
 * A row of options, one selected. Only the selected one is in the tab order; the arrow keys move the selection
 * and the focus together, wrapping at the ends (Up and Down too, for radios), and Home and End jump to the ends.
 */
export function Segmented<T extends string>({ label, options, value, onChange, as = 'radio', className }: SegmentedProps<T>) {
  const tabs = as === 'tab';
  const selected = Math.max(0, options.findIndex((o) => o.value === value)); // something stays reachable by Tab
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = NEXT[e.key];
    if (!next || (tabs && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) return;
    e.preventDefault();
    const at = (next(i, options.length) + options.length) % options.length;
    onChange(options[at]!.value);
    (e.currentTarget.parentElement?.children[at] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role={tabs ? 'tablist' : 'radiogroup'} aria-label={label} className={cx('el-seg', className)}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role={as}
          id={o.id}
          aria-controls={o.controls}
          {...(tabs ? { 'aria-selected': o.value === value } : { 'aria-checked': o.value === value })}
          tabIndex={i === selected ? 0 : -1}
          className="el-seg-item"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface PillProps {
  tone?: 'neutral' | 'accent' | 'ok' | 'error';
  /** A leading dot in the tone's colour. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

/** A small rounded status label ("Up to date", "Paused at your limit"). */
export function Pill({ tone = 'neutral', dot = false, className, children }: PillProps) {
  return <span className={cx('el-pill', `el-pill-${tone}`, dot && 'el-pill-dot', className)}>{children}</span>;
}

/** What type of change an issue is ("Clarity · Cut wordiness"), after a dot in its family's colour. */
export function TypeLabel({ issue, className }: { issue: Pick<RawIssue, 'severity' | 'category' | 'kind'>; className?: string }) {
  return (
    <span className={cx('el-type', className)}>
      <span className={`el-dot el-fam-${shownFamily(issue)}`} aria-hidden="true" />
      <span className="el-type-text">{typeLabel(issue)}</span>
    </span>
  );
}

/** How many words of context a DiffPreview shows on each side of the change. */
const CONTEXT_WORDS = 6;

/** The last `n` words of the text before a change, with "…" where it was cut. */
function lead(text: string, n: number): string {
  const words = text.match(/\S+\s*/g) ?? [];
  return words.length > n ? `…${words.slice(-n).join('')}` : text;
}

/** The first `n` words of the text after a change, with "…" where it was cut. */
function trail(text: string, n: number): string {
  const words = text.match(/\s*\S+/g) ?? [];
  return words.length > n ? `${words.slice(0, n).join('')}…` : text;
}

export interface DiffPreviewProps {
  /** The text before and after the change, any length: up to CONTEXT_WORDS words of each show. */
  before: string;
  after: string;
  original: string;
  /** '' deletes the original; null is a comment-only note, which marks the original instead of striking it. */
  replacement: string | null;
  /** The words of context shown on each side (CONTEXT_WORDS when absent). */
  context?: number;
  className?: string;
}

/** A change in its context: the original struck, then the replacement inserted. */
export function DiffPreview({ before, original, replacement, after, context = CONTEXT_WORDS, className }: DiffPreviewProps) {
  const head = lead(before, context);
  const tail = trail(after, context);
  return (
    <span className={cx('el-diff', className)}>
      {head && <span className="el-diff-context">{head}</span>}
      {replacement === null ? <mark>{original}</mark> : <del>{original}</del>}
      {replacement ? <ins>{replacement}</ins> : null}
      {tail && <span className="el-diff-context">{tail}</span>}
    </span>
  );
}
