import { type KeyboardEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { counterText, defaultTarget, limitChips, savedText, validTarget, wordsAfter, type WordLimitCut } from '../../core/word-limit';
import { Button, DiffPreview, Pill } from './controls';

// Fit a word limit's two views, shared by the tools popover (which applies) and the side panel (which copies):
// the target picker, and the cuts with their live counter. Styled by word-limit.css. Every count is the local one.

/** Runs a handler only for the events it lets through: the overlay passes byUser (the user's own clicks and keys). */
export type Guard = <E extends { isTrusted: boolean }>(fn: (e: E) => void) => (e: E) => void;
const everyEvent: Guard = (fn) => fn;

/** The words of context shown on each side of a cut. */
const CUT_CONTEXT_WORDS = 3;

export interface TargetPickerProps {
  /** The selection's words. */
  words: number;
  onFind(target: number): void;
  guard?: Guard;
}

/**
 * "N words selected", a Target box that starts at 85% of them rounded to 5, chips for the common limits below them (a
 * chip only sets the box), and Find cuts, off while the target isn't a whole number from 1 to one under the words.
 * Enter in the box finds cuts too.
 */
export function TargetPicker({ words, onFind, guard = everyEvent }: TargetPickerProps) {
  const id = useId();
  const [value, setValue] = useState(() => String(defaultTarget(words)));
  const target = value.trim() === '' ? Number.NaN : Number(value);
  const ok = validTarget(target, words);
  const find = () => {
    if (ok) onFind(target);
  };
  const chips = limitChips(words);
  return (
    <div className="el-wl-pick">
      <div className="el-wl-count">{words} words selected</div>
      <div className="el-wl-target">
        <label className="el-wl-label" htmlFor={id}>
          Target
        </label>
        <input
          id={id}
          type="number"
          className="el-wl-input"
          inputMode="numeric"
          min={1}
          max={words - 1}
          step={1}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={guard((e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            find();
          })}
        />
        <span className="el-wl-unit">words</span>
      </div>
      {chips.length > 0 && (
        <div className="el-wl-chips" role="group" aria-label="Common limits">
          {chips.map((c) => (
            <button key={c} type="button" className="el-wl-chip" aria-pressed={target === c} onClick={guard(() => setValue(String(c)))}>
              {c}
            </button>
          ))}
        </div>
      )}
      <Button variant="primary" size="sm" className="el-wl-find" disabled={!ok} onClick={guard(find)}>
        Find cuts
      </Button>
    </div>
  );
}

export interface CutListProps {
  /** The selection the cuts are in, and its words. */
  original: string;
  words: number;
  target: number;
  cuts: readonly WordLimitCut[];
  /** The cuts picked to start with; the list keeps the writer's picks from there (give it a new key for new cuts). */
  selected: readonly boolean[];
  /** A line under the list. */
  note?: string;
  /** A search for more failed: its status, under the list in place of the note (an alert). */
  error?: string;
  /** The buttons under the list, for the cuts picked now. */
  actions(picked: boolean[]): ReactNode;
  /** A line under the buttons (the full version's fact note). */
  foot?: ReactNode;
  guard?: Guard;
}

/** How a cut reads to a screen reader. */
const cutLabel = (c: WordLimitCut) => (c.replacement === '' ? `Delete “${c.original}”` : `Replace “${c.original}” with “${c.replacement}”`);

/**
 * The words and the target ("312 → 250 words"), the live counter (green at or under the target), each cut as a row:
 * a checkbox, the change in a few words of its context, a pill with the words it saves, "Changes a fact" when it
 * does, and its why; then the caller's actions, and its foot.
 */
export function CutList({ original, words, target, cuts, selected, note, error, actions, foot, guard = everyEvent }: CutListProps) {
  const id = useId();
  const [picked, setPicked] = useState(() => cuts.map((_, i) => !!selected[i]));
  const now = useMemo(() => wordsAfter(original, cuts, picked), [original, cuts, picked]);
  const toggle = (i: number) => setPicked((p) => p.map((on, j) => (j === i ? !on : on)));
  return (
    <div className="el-wl">
      <div className="el-wl-head">
        {words} → {target} words
      </div>
      <div className={now <= target ? 'el-wl-counter el-wl-ok' : 'el-wl-counter'} role="status">
        {counterText(now, target)}
      </div>
      <ul className="el-wl-cuts" aria-label="Cuts">
        {cuts.map((c, i) => (
          <li key={i} className="el-wl-cut">
            <label className="el-wl-cut-row">
              <input
                type="checkbox"
                className="el-wl-check"
                checked={picked[i]}
                aria-label={cutLabel(c)}
                aria-describedby={`${id}-${i}`}
                onChange={guard(() => toggle(i))}
              />
              <span className="el-wl-cut-body">
                <DiffPreview before={original.slice(0, c.start)} original={c.original} replacement={c.replacement} after={original.slice(c.end)} context={CUT_CONTEXT_WORDS} />
                <span className="el-wl-meta" id={`${id}-${i}`}>
                  <Pill className="el-wl-saves">{savedText(c.saves)}</Pill>
                  {c.changesFacts && (
                    <Pill tone="error" dot className="el-wl-fact">
                      Changes a fact
                    </Pill>
                  )}
                  <span className="el-wl-why">{c.why}</span>
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error ? (
        <div className="el-wl-note el-wl-error" role="alert">
          {error}
        </div>
      ) : (
        note && <div className="el-wl-note">{note}</div>
      )}
      <div className="el-wl-actions">{actions(picked)}</div>
      {foot}
    </div>
  );
}
