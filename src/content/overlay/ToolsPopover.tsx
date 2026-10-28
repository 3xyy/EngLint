import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { wordDiff } from '../../core/diff';
import { countWords } from '../../core/doc-stats';
import { ALREADY_YOU, MAX_QUESTION_CHARS, tellsLine } from '../../core/follow-up';
import { Button, IconButton } from '../../shared/ui/controls';
import { CheckIcon, CopyIcon, SparkleIcon, XIcon } from '../../shared/ui/icons';
import { CutList, TargetPicker } from '../../shared/ui/WordLimit';
import { TOOLS_COPY, type ToolsHandlers, type ToolsView } from '../tools/tools-controller';
import { byUser } from './by-user';
import { SelectionBar } from './SelectionBar';

const GAP = 6; // between the selection and the popover
const MARGIN = 8; // from the viewport edge
/** What the arrows move through: not the header's Close, nor a version's Copy icon (Tab reaches both). */
const ITEMS = 'button:not([data-skip-arrows]):not(:disabled), input:not(:disabled)';
const COPIED_MS = 1500;

export interface ToolsPopoverProps {
  /** Viewport box of the selection the popover belongs to. */
  anchor: DOMRect;
  view: ToolsView;
  handlers: ToolsHandlers;
  /** The results header: the action shown ("Improve", "Tone · Formal"). */
  title?: string;
}

/** `from` → `to`, word by word: removed words struck through, added ones marked (also the side panel's). */
export function Diff({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => wordDiff(from, to), [from, to]);
  return (
    <>
      {parts.map((p, i) => (p.op === 'same' ? <span key={i}>{p.text}</span> : p.op === 'del' ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>))}
    </>
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

/** Copy's state for a moment after a click: null (idle), true (copied) or false (couldn't), and the copy itself. */
function useCopied(text: string, handlers: ToolsHandlers): [boolean | null, () => void] {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return [copied, () => void handlers.copy(text).then(setCopied)];
}

/** Copy's confirmation, for a screen reader. */
const CopyStatus = ({ copied }: { copied: boolean | null }) => (
  <span className="englint-sr-only" role="status">
    {copied === null ? '' : copied ? 'Copied.' : "Couldn't copy."}
  </span>
);

/** Copies `text`; reads "Copy", then "Copied" or "Couldn't copy" for a moment (the side panel's words), and says so to a screen reader. */
function CopyVersion({ text, label, handlers }: { text: string; label: string; handlers: ToolsHandlers }) {
  const [copied, copy] = useCopied(text, handlers);
  return (
    <>
      <Button size="sm" className="englint-tools-copy-text" aria-label={label} onClick={byUser(copy)}>
        {copied === null ? 'Copy' : copied ? 'Copied' : "Couldn't copy"}
      </Button>
      <CopyStatus copied={copied} />
    </>
  );
}

/** A version's small Copy icon: a check for a moment once copied. Tab reaches it; the arrows skip it. */
function CopyIconButton({ text, label, handlers }: { text: string; label: string; handlers: ToolsHandlers }) {
  const [copied, copy] = useCopied(text, handlers);
  return (
    <>
      <IconButton
        label={label}
        icon={copied ? <CheckIcon /> : <CopyIcon />}
        tipAlign="end"
        className="englint-tools-copy"
        data-skip-arrows=""
        onClick={byUser(copy)}
      />
      <CopyStatus copied={copied} />
    </>
  );
}

/**
 * One version as a card: its diff is a button that applies it, with a small Copy icon; or, when it changes a number,
 * name or quote (`canApply` false, after My voice), the diff alone with the fact note and Copy.
 */
function Choice(p: { text: string; original: string; canApply: boolean; applyLabel: string; copyLabel: string; handlers: ToolsHandlers }) {
  if (p.canApply) {
    return (
      <div className="englint-tools-card">
        <button type="button" className="englint-tools-row" aria-label={p.applyLabel} onClick={byUser(() => p.handlers.apply(p.text))}>
          <Diff from={p.original} to={p.text} />
        </button>
        <CopyIconButton text={p.text} label={p.copyLabel} handlers={p.handlers} />
      </div>
    );
  }
  return (
    <div className="englint-tools-card englint-tools-card-static">
      <div className="englint-tools-version">
        <Diff from={p.original} to={p.text} />
      </div>
      <p className="englint-tools-note">{TOOLS_COPY.checkFacts}</p>
      <CopyVersion text={p.text} label={p.copyLabel} handlers={p.handlers} />
    </div>
  );
}

/** Each version as a card that applies it (copy only where `canApply` says no). */
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
 * My voice: the generic patterns found, then its one version as a diff. It applies only when it keeps every
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

/**
 * Fit a word limit's cuts: Apply selected (the picked cuts, applied once), Use full version (its words counted here),
 * and Find more cuts while the controller offers it. A full version that changes a number, name or quote has the fact
 * note under the buttons, describing Use full version, which still applies (the writer chose it). A search for more
 * gives the list a new key: the picks start from the view's, which keep the writer's.
 */
function LimitCuts({ view, handlers }: { view: Extract<ToolsView, { phase: 'wordLimit' }>; handlers: ToolsHandlers }) {
  const { version } = view;
  const factsId = useId();
  const facts = version !== null && view.versionChangesFacts;
  return (
    <div className="englint-tools-limit">
      <CutList
        key={view.cuts.length}
        original={view.original}
        words={view.words}
        target={view.target}
        cuts={view.cuts}
        selected={view.selected}
        note={view.noneNew ? TOOLS_COPY.noMoreCuts : undefined}
        error={view.error}
        guard={byUser}
        actions={(picked) => (
          <>
            <Button variant="primary" size="sm" disabled={!picked.some(Boolean)} onClick={byUser(() => handlers.applySelected(picked))}>
              Apply selected
            </Button>
            {version !== null && (
              <Button size="sm" aria-describedby={facts ? factsId : undefined} onClick={byUser(() => handlers.apply(version))}>
                Use full version ({countWords(version)} words)
              </Button>
            )}
            {view.more && (
              <Button variant="ghost" size="sm" onClick={byUser(() => handlers.moreCuts(picked))}>
                Find more cuts
              </Button>
            )}
          </>
        )}
        foot={
          facts && (
            <p id={factsId} className="el-wl-facts">
              {TOOLS_COPY.checkFacts}
            </p>
          )
        }
      />
    </div>
  );
}

function Body({ view, handlers }: { view: Exclude<ToolsView, { phase: 'menu' }>; handlers: ToolsHandlers }) {
  switch (view.phase) {
    case 'wordLimitPick':
      return (
        <div className="englint-tools-limit">
          <TargetPicker words={view.words} onFind={(target) => handlers.findCuts(target)} guard={byUser} />
        </div>
      );
    case 'wordLimit':
      return <LimitCuts view={view} handlers={handlers} />;
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
          <Button variant="ghost" size="sm" className="englint-tools-more" onClick={byUser(() => handlers.showVariants())}>
            {view.voice ? TOOLS_COPY.showVersion : 'Show 3 rewrites'}
          </Button>
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
            <Button variant="ghost" size="sm" className="englint-tools-more" onClick={byUser(() => handlers.retry())}>
              Retry
            </Button>
          )}
        </>
      );
  }
}

/**
 * The tools popover (tools-controller.ts runs it). Its first view, when the shortcut or "Ask anything…" opened
 * it, is the selection bar itself, focused. Every later view is the results card: a header naming the action, with
 * Close, then the answer (each version a card that applies it, with Copy), then "Ask a follow-up…".
 */
export function ToolsPopover({ anchor, view, handlers, title }: ToolsPopoverProps) {
  if (view.phase === 'menu') {
    return (
      <SelectionBar
        at={anchor}
        mode={view.mode}
        singleWord={view.singleWord}
        tooLong={view.tooLong}
        focus={view.focus ?? 'first'}
        onPick={(run) => run !== 'custom-prompt' && handlers.pick(run)}
        onAsk={(instruction) => handlers.pick({ kind: 'custom', instruction })}
      />
    );
  }
  return <Results anchor={anchor} view={view} handlers={handlers} title={title} />;
}

/**
 * The results card, 380px wide, below the selection when it fits, otherwise above; it looks like the suggestion card.
 * It takes focus when it opens; on later views it moves focus to the new first item only while focus is in it (or
 * fell to the page when the pressed item went away), never away from the field the user went back to. Arrows move
 * through the items. Esc and outside clicks are the overlay's (mount.tsx): they also reach it while focus is in the
 * field.
 */
function Results({ anchor, view, handlers, title }: ToolsPopoverProps & { view: Exclude<ToolsView, { phase: 'menu' }> }) {
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
    (el.querySelector<HTMLElement>(ITEMS) ?? el).focus({ preventScroll: true });
  }, [view]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if ((e.target as HTMLElement).matches('input[type="number"]')) return; // its own arrows step the number
    const el = ref.current;
    const items = el ? Array.from(el.querySelectorAll<HTMLElement>(ITEMS)) : [];
    if (!el || items.length === 0) return;
    e.preventDefault(); // no page scroll, no caret move in the follow-up box
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
      aria-label={title ? `EngLint: ${title}` : 'EngLint'}
      tabIndex={-1}
      style={{ left: anchor.left, top: anchor.bottom + GAP }}
      onKeyDown={onKeyDown}
    >
      <div className="englint-tools-head">
        <SparkleIcon size={15} className="englint-tools-head-icon" />
        <span className="englint-tools-title">{title ?? 'EngLint'}</span>
        <IconButton label="Close" icon={<XIcon />} tipAlign="end" className="englint-tools-close" data-skip-arrows="" onClick={byUser(() => handlers.close())} />
      </div>
      <div className="englint-tools-body">
        <Body view={view} handlers={handlers} />
      </div>
    </div>
  );
}
