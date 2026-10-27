import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { wordDiff } from '../../core/diff';
import { ALREADY_YOU, MAX_QUESTION_CHARS, tellsLine } from '../../core/follow-up';
import { presetsFor } from '../../core/presets';
import type { Mode } from '../../core/types';
import { TOOLS_COPY, type ToolsHandlers, type ToolsView } from '../tools/tools-controller';

const GAP = 6; // between the selection and the popover
const MARGIN = 8; // from the viewport edge
const ITEMS = 'button, input:not(:disabled)';
const COPIED_MS = 1500;

export interface ToolsPopoverProps {
  /** Viewport box of the selection the popover belongs to. */
  anchor: DOMRect;
  view: ToolsView;
  handlers: ToolsHandlers;
}

/**
 * Runs `fn` only for the user's own click or key. A page script's synthetic event (isTrusted false) does
 * nothing, so it can't drive the popover into spending the user's key (I3; the overlay's root is closed too,
 * except in the e2e build, whose Playwright input is trusted).
 */
export const byUser =
  <E extends { isTrusted: boolean }>(fn: (e: E) => void) =>
  (e: E) => {
    if (e.isTrusted) fn(e);
  };

/** `from` → `to`, word by word: removed words struck through, added ones marked (also the side panel's). */
export function Diff({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => wordDiff(from, to), [from, to]);
  return (
    <>
      {parts.map((p, i) => (p.op === 'same' ? <span key={i}>{p.text}</span> : p.op === 'del' ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>))}
    </>
  );
}

function Menu({ handlers, mode }: { handlers: ToolsHandlers; mode: Mode }) {
  const [instruction, setInstruction] = useState('');
  return (
    <div className="englint-tools-menu">
      {presetsFor(mode).map((p) => (
        <button key={p.id} type="button" className="englint-tools-item" onClick={byUser(() => handlers.pick({ kind: 'preset', presetId: p.id }))}>
          {p.title}
        </button>
      ))}
      <button type="button" className="englint-tools-item" onClick={byUser(() => handlers.pick({ kind: 'synonyms' }))}>
        Synonyms
      </button>
      <input
        type="text"
        className="englint-tools-input"
        placeholder="Or tell EngLint what to do…"
        aria-label="Or tell EngLint what to do"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={byUser((e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          handlers.pick({ kind: 'custom', instruction });
        })}
      />
    </div>
  );
}

/** After a result: a question about it continues the conversation (Enter sends). Used up, it says so instead. */
function FollowUpBox({ handlers, exhausted }: { handlers: ToolsHandlers; exhausted?: boolean }) {
  const [question, setQuestion] = useState('');
  if (exhausted) {
    return (
      <input type="text" className="englint-tools-input" disabled placeholder={TOOLS_COPY.noMoreFollowUps} aria-label={TOOLS_COPY.noMoreFollowUps} />
    );
  }
  return (
    <input
      type="text"
      className="englint-tools-input"
      placeholder="Ask a follow-up…"
      aria-label="Ask a follow-up"
      maxLength={MAX_QUESTION_CHARS}
      value={question}
      onChange={(e) => setQuestion(e.target.value)}
      onKeyDown={byUser((e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        handlers.ask(question);
      })}
    />
  );
}

/** Copies `text`; reads "Copy", then "Copied" or "Couldn't copy" for a moment (the side panel's words), and says so to a screen reader. */
function CopyVersion({ text, label, handlers }: { text: string; label: string; handlers: ToolsHandlers }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button type="button" className="englint-tools-more" aria-label={label} onClick={byUser(() => void handlers.copy(text).then(setCopied))}>
        {copied === null ? 'Copy' : copied ? 'Copied' : "Couldn't copy"}
      </button>
      <span className="englint-sr-only" role="status">
        {copied === null ? '' : copied ? 'Copied.' : "Couldn't copy."}
      </span>
    </>
  );
}

/**
 * One version as a diff: a row that applies it, or, when it changes a number, name or quote (`canApply` false,
 * after Sound like me), the diff alone with the fact note and Copy.
 */
function Choice(p: { text: string; original: string; canApply: boolean; applyLabel: string; copyLabel: string; handlers: ToolsHandlers }) {
  if (p.canApply) {
    return (
      <button type="button" className="englint-tools-row" aria-label={p.applyLabel} onClick={byUser(() => p.handlers.apply(p.text))}>
        <Diff from={p.original} to={p.text} />
      </button>
    );
  }
  return (
    <>
      <div className="englint-tools-version">
        <Diff from={p.original} to={p.text} />
      </div>
      <p className="englint-tools-note">{TOOLS_COPY.checkFacts}</p>
      <CopyVersion text={p.text} label={p.copyLabel} handlers={p.handlers} />
    </>
  );
}

/** Each version as a diff row that applies it (copy only where `canApply` says no). */
function Versions({ variants, original, canApply, handlers }: { variants: string[]; original: string; canApply?: boolean[]; handlers: ToolsHandlers }) {
  return (
    <>
      {variants.map((v, i) => (
        <Choice
          key={i}
          text={v}
          original={original}
          canApply={canApply?.[i] !== false}
          applyLabel={`Use version ${i + 1}`}
          copyLabel={`Copy version ${i + 1}`}
          handlers={handlers}
        />
      ))}
    </>
  );
}

/**
 * Sound like me: the generic patterns found, then its one version as a diff. It applies only when it keeps every
 * number, name and quote (`canApply`, from the controller); otherwise the fact note and Copy. A passage that came
 * back as it was has nothing to show but that.
 */
function Voice({ view, handlers }: { view: Extract<ToolsView, { phase: 'voice' }>; handlers: ToolsHandlers }) {
  return (
    <>
      <p className="englint-tools-tells">{view.unchanged ? ALREADY_YOU : tellsLine(view.tells)}</p>
      {!view.unchanged && (
        <Choice text={view.final} original={view.original} canApply={view.canApply} applyLabel="Use this version" copyLabel="Copy this version" handlers={handlers} />
      )}
      <FollowUpBox handlers={handlers} />
    </>
  );
}

function Body({ view, handlers }: Omit<ToolsPopoverProps, 'anchor'>) {
  switch (view.phase) {
    case 'menu':
      return <Menu handlers={handlers} mode={view.mode} />;
    case 'loading':
      return (
        <div className="englint-tools-loading" role="status">
          <span className="englint-tools-spinner" aria-hidden="true" />
          {view.label}
        </div>
      );
    case 'critique':
      return (
        <>
          <p className="englint-tools-weakness">{view.weakness}</p>
          <Choice
            text={view.lightFix}
            original={view.original}
            canApply={view.canApply !== false}
            applyLabel="Use this version"
            copyLabel="Copy this version"
            handlers={handlers}
          />
          <button type="button" className="englint-tools-more" onClick={byUser(() => handlers.showVariants())}>
            {view.voice ? TOOLS_COPY.showVersion : 'Show 3 rewrites'}
          </button>
          <FollowUpBox handlers={handlers} />
        </>
      );
    case 'variants':
      return (
        <>
          <Versions variants={view.variants} original={view.original} handlers={handlers} />
          <FollowUpBox handlers={handlers} />
        </>
      );
    case 'voice':
      return <Voice view={view} handlers={handlers} />;
    case 'answer':
      return (
        <>
          <p className="englint-tools-message">{view.message}</p>
          <Versions variants={view.variants} original={view.original} canApply={view.canApply} handlers={handlers} />
          <FollowUpBox handlers={handlers} exhausted={view.exhausted} />
        </>
      );
    case 'synonyms':
      return (
        <>
          {view.options.map((o, i) => (
            <button key={i} type="button" className="englint-tools-option" onClick={byUser(() => handlers.apply(o.text))}>
              <span className="englint-tools-word">{o.text}</span>
              <span className="englint-tools-nuance">{o.nuance}</span>
            </button>
          ))}
          <FollowUpBox handlers={handlers} />
        </>
      );
    case 'error':
      return (
        <>
          <p className="englint-tools-error" role="alert">
            {view.text}
          </p>
          {view.retry && (
            <button type="button" className="englint-tools-more" onClick={byUser(() => handlers.retry())}>
              Retry
            </button>
          )}
        </>
      );
  }
}

/**
 * The tools popover (tools-controller.ts runs it): the menu, then each answer. It sits in the fixed overlay
 * like the card and looks like it. It takes focus when it opens; on later views it moves focus to the new
 * first item only while focus is in it (or fell to the page when the pressed item went away), never away
 * from the field the user went back to. Arrows move through the items. Esc and outside clicks are the
 * overlay's (mount.tsx): they also reach it while focus is in the field.
 */
export function ToolsPopover({ anchor, view, handlers }: ToolsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  // Below the selection when it fits, otherwise above; the side is chosen by fit on every render (it grows as results arrive), and the top stays inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN));
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - height;
    const side = below + height <= window.innerHeight - MARGIN || above < MARGIN ? 'below' : 'above';
    const top = Math.max(MARGIN, Math.min(side === 'below' ? below : above, window.innerHeight - height - MARGIN));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.dataset.side = side; // the enter animation grows from the side nearest the text
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inside = el.contains((el.getRootNode() as ShadowRoot | Document).activeElement);
    const nowhere = document.activeElement === null || document.activeElement === document.body;
    if (opened.current && !inside && !nowhere) return;
    opened.current = true;
    const first = view.phase === 'menu' && view.focus === 'custom' ? el.querySelector<HTMLElement>('input') : el.querySelector<HTMLElement>(ITEMS);
    (first ?? el).focus({ preventScroll: true });
  }, [view]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const el = ref.current;
    const items = el ? Array.from(el.querySelectorAll<HTMLElement>(ITEMS)) : [];
    if (!el || items.length === 0) return;
    e.preventDefault(); // no page scroll, no caret move in the custom box
    const at = items.indexOf((el.getRootNode() as ShadowRoot | Document).activeElement as HTMLElement);
    const down = e.key === 'ArrowDown';
    const next = at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : items.length - 1)) % items.length;
    items[next]!.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      className="englint-tools"
      role="dialog"
      aria-label="EngLint"
      tabIndex={-1}
      style={{ left: anchor.left, top: anchor.bottom + GAP }}
      onKeyDown={onKeyDown}
    >
      <Body view={view} handlers={handlers} />
    </div>
  );
}
