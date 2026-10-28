// The side panel's Tools: rewrite, find synonyms or fit a word limit for text no field holds (page text, a canvas
// app, Docs in fallback mode). The right-click menu and the shortcut put the selection here (the stash, background/
// menus.ts); the user can also paste. Same messages as the popover, Copy only (there is no field to apply to).
// Nothing here logs the text or the answers.
import { useEffect, useId, useRef, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { type ToolsStash, toolsStashKey } from '../../background/menus';
import { Diff } from '../../content/overlay/ToolsPopover';
import { MAX_SELECTION_CHARS } from '../../content/tools/selection';
import { TOOLS_COPY, retryable } from '../../content/tools/tools-controller';
import { changesClaims } from '../../core/claims';
import { countWords } from '../../core/doc-stats';
import { ALREADY_YOU, tellsLine } from '../../core/follow-up';
import { effectiveMode } from '../../core/modes';
import { BAR_ACTIONS, isVoice, presetsFor, type BarAction, type BarItem, type RewriteToolRequest, type ToolRequest } from '../../core/presets';
import { webHost } from '../../core/sites';
import type { CheckStatus, Mode } from '../../core/types';
import { MAX_SHOWN_CUTS, MAX_WORD_LIMIT_CHARS, applyCuts, withFound, type CutsShown } from '../../core/word-limit';
import { sendMessage } from '../../shared/messages';
import { essaySitesItem, siteModesItem } from '../../shared/settings';
import { toolStatusText } from '../../shared/status-text';
import { Button } from '../../shared/ui/controls';
import { SparkleIcon } from '../../shared/ui/icons';
import { CutList, TargetPicker } from '../../shared/ui/WordLimit';
import { useProviderInfo } from '../../shared/use-provider-info';

/** A stashed request older than this only fills the text: the panel didn't open with it, so it isn't run. */
export const STASH_FRESH_MS = 30_000;
const COPIED_MS = 1500;
const MAX_SYNONYM_WORDS = 4;
/** Sound like me's fact note: sentence openers may go or change at any sentence start. */
const LENIENT = { sentenceStarts: 'lenient' } as const;

type View =
  | { phase: 'idle' }
  | { phase: 'loading'; label: string }
  | { phase: 'critique'; weakness: string; lightFix: string; original: string; request: RewriteToolRequest }
  | { phase: 'variants'; variants: string[]; original: string }
  /** Sound like me: the generic patterns found and its one version (Copy only here, like every result). */
  | { phase: 'voice'; tells: string[]; final: string; original: string }
  | { phase: 'synonyms'; options: { text: string; nuance: string }[] }
  /** Fit a word limit's target picker for `text` (trimmed), `words` long. */
  | { phase: 'wordLimitPick'; text: string; words: number }
  /**
   * Fit a word limit's cuts for `text`: `more`, Find more cuts is offered; `noneNew`, the last search for more found
   * none; `error`, it failed, and this is its status (the cuts and the picks stay).
   */
  | { phase: 'wordLimit'; text: string; words: number; shown: CutsShown; more: boolean; noneNew?: true; error?: string }
  | { phase: 'error'; text: string };

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

type ToolButton = Extract<BarAction, { kind: 'button' }>;
type ToolItem = BarItem & { run: ToolRequest };

/**
 * The selection bar's actions (BAR_ACTIONS) as the Tools lay them out: its buttons first (Improve, My voice,
 * Synonyms), then each of its menus as a labelled group of buttons, so every action is one click. Items follow
 * the mode; Synonyms stays a button (for up to 4 words), and "Ask anything…" is the box below the actions.
 */
function toolsActions(mode: Mode): { lead: ToolButton[]; groups: { id: string; label: string; items: ToolItem[] }[] } {
  const offered = (i: BarItem): i is ToolItem => i.run !== 'custom-prompt' && i.run.kind !== 'synonyms' && (!i.modes || i.modes.includes(mode));
  return {
    lead: BAR_ACTIONS.filter((a): a is ToolButton => a.kind === 'button'),
    groups: BAR_ACTIONS.flatMap((a) => (a.kind === 'menu' ? [{ id: a.id, label: a.label, items: a.items.filter(offered) }] : [])).filter(
      (g) => g.items.length > 0,
    ),
  };
}

/** Copies `text`; reads `idle` ("Copy" unless given), then "Copied" or "Couldn't copy" for a moment. */
export function CopyButton({
  text,
  label,
  idle = 'Copy',
  disabled,
  describedBy,
  onCopied,
}: {
  text: string;
  label: string;
  idle?: string;
  disabled?: boolean;
  /** The id of a note about what it copies. */
  describedBy?: string;
  onCopied?(ok: boolean): void;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false; // no focus or permission
    }
    setCopied(ok);
    onCopied?.(ok);
  }
  return (
    <Button size="sm" className="tools-copy" aria-label={label} aria-describedby={describedBy} disabled={disabled} onClick={() => void copy()}>
      {copied === null ? idle : copied ? 'Copied' : "Couldn't copy"}
    </Button>
  );
}

export function Tools({
  tabId,
  fallbackHost,
  spend,
  onStash,
}: {
  tabId: number | null;
  /** The host the tab's fields reported (TabState), used when the tab's own URL can't be read. */
  fallbackHost: string | null;
  spend: { spent: number; cap: number } | null;
  /** A fresh stash arrived (the menu or the shortcut sent text here just now): the panel shows the Tools. */
  onStash?(): void;
}) {
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [view, setView] = useState<View>({ phase: 'idle' });
  const [copyNote, setCopyNote] = useState('');
  const [mode, setMode] = useState<Mode>('standard'); // the page's mode: it picks the presets offered
  const factsId = useId();
  const seq = useRef(0); // a newer run makes an older answer stop
  const taken = useRef(new Set<number>()); // stashes already used (by `at`): each fills the text once
  const who = useProviderInfo();
  const latest = useRef({ tabId, fallbackHost, spend, onStash, who });
  latest.current = { tabId, fallbackHost, spend, onStash, who };

  const target = text.trim();
  const tooLong = target.length > MAX_SELECTION_CHARS;
  const canRun = target !== '' && !tooLong && view.phase !== 'loading';
  const canSynonyms = canRun && wordCount(target) <= MAX_SYNONYM_WORDS;
  const limitTooLong = target.length > MAX_WORD_LIMIT_CHARS;
  const canLimit = !limitTooLong && countWords(target) >= 2 && view.phase !== 'loading';
  const canDo = (r: ToolRequest) => (r.kind === 'synonyms' ? canSynonyms : r.kind === 'wordLimit' ? canLimit : canRun);
  const actions = toolsActions(mode);

  /** The tab's host (its URL; else what its fields reported) and that site's mode, for the Essay gate. */
  async function site(): Promise<{ host: string; mode: Mode }> {
    const { tabId: id, fallbackHost: reported } = latest.current;
    const tab = id === null ? null : await browser.tabs.get(id).catch(() => null);
    const host = webHost(tab?.url) ?? reported ?? '';
    const [siteModes, essaySites] = await Promise.all([siteModesItem.getValue(), essaySitesItem.getValue()]);
    return { host, mode: effectiveMode(host, siteModes, essaySites) };
  }

  // The mode of the page this panel serves, kept current as the tab, its sites or their modes change.
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void site().then(
        (s) => live && setMode(s.mode),
        () => {},
      );
    refresh();
    const unwatch = [siteModesItem.watch(refresh), essaySitesItem.watch(refresh)];
    return () => {
      live = false;
      for (const stop of unwatch) stop();
    };
  }, [tabId, fallbackHost]); // site() reads the latest props through `latest`

  const failed = (status: CheckStatus): View => ({
    phase: 'error',
    // ok without its payload: an unusable answer
    text: toolStatusText(status === 'ok' ? 'bad_response' : status, latest.current.spend ?? undefined, latest.current.who) ?? '',
  });

  /**
   * Runs `r` on `raw` (trimmed): in Essay mode a rewrite starts with the critique, unless `stage` says. Fit a word limit
   * shows its target picker first (up to MAX_WORD_LIMIT_CHARS, and more than one word).
   */
  async function run(r: ToolRequest, raw: string, stage?: 'critique' | 'variants') {
    const selection = raw.trim();
    if (r.kind === 'wordLimit') {
      const words = countWords(selection);
      if (selection.length > MAX_WORD_LIMIT_CHARS || words < 2) return; // as its button: nothing shown
      seq.current++; // an answer still on its way stops
      return setView({ phase: 'wordLimitPick', text: selection, words });
    }
    if (selection === '' || selection.length > MAX_SELECTION_CHARS) return; // as the buttons: nothing sent
    if (r.kind === 'synonyms' && wordCount(selection) > MAX_SYNONYM_WORDS) return;
    if (r.kind === 'custom' && r.instruction.trim() === '') return;
    const t = ++seq.current;
    let next: View;
    try {
      const { host, mode } = await site();
      if (t !== seq.current) return;
      if (r.kind === 'preset' && !presetsFor(mode).some((p) => p.id === r.presetId)) return setView({ phase: 'error', text: TOOLS_COPY.essayOnlyNot });
      if (r.kind === 'synonyms') {
        setView({ phase: 'loading', label: TOOLS_COPY.synonyms });
        const res = await sendMessage('synonyms', { host, mode, target: selection, sentence: selection, targetStart: 0 });
        next = res.status === 'ok' && res.options?.length ? { phase: 'synonyms', options: res.options } : failed(res.status);
      } else {
        const at = stage ?? (mode === 'essay' ? 'critique' : 'variants');
        setView({ phase: 'loading', label: at === 'critique' ? TOOLS_COPY.critiquing : TOOLS_COPY.rewriting });
        // No field: nothing around the text to send as context.
        const res = await sendMessage('rewrite', { host, mode, request: r, text: selection, before: '', after: '', stage: at });
        if (at === 'critique') {
          next = res.status === 'ok' && res.critique ? { phase: 'critique', ...res.critique, original: selection, request: r } : failed(res.status);
        } else if (isVoice(r)) {
          const final = res.variants?.[0];
          next = res.status === 'ok' && final ? { phase: 'voice', tells: res.tells ?? [], final, original: selection } : failed(res.status);
        } else {
          next = res.status === 'ok' && res.variants?.length ? { phase: 'variants', variants: res.variants, original: selection } : failed(res.status);
        }
      }
    } catch {
      next = failed('offline'); // the message never reached the background
    }
    if (t === seq.current) setView(next);
  }

  /**
   * Fit a word limit's search for `target` words in `text` (no field: no context); with `prior`, a search for more,
   * which keeps `prior` (the cuts and the picks) when it fails, with its status under them.
   */
  async function findCuts(text: string, target: number, prior: CutsShown | null = null) {
    const t = ++seq.current;
    const failedSearch = (status: CheckStatus): View => {
      const view = failed(status);
      if (!prior || view.phase !== 'error') return view;
      return { phase: 'wordLimit', text, words: countWords(text), shown: prior, more: retryable(status) && prior.cuts.length < MAX_SHOWN_CUTS, error: view.text };
    };
    let next: View;
    try {
      const { host, mode } = await site();
      if (t !== seq.current) return;
      setView({ phase: 'loading', label: prior ? TOOLS_COPY.findingMore : TOOLS_COPY.findingCuts });
      const shown = prior?.cuts.map(({ start, end, original, replacement }) => ({ start, end, original, replacement })) ?? [];
      const res = await sendMessage('wordLimit', { host, mode, text, before: '', after: '', target, ...(shown.length ? { shown } : {}) });
      if (res.status === 'ok' && res.cuts) {
        const now = withFound(text, target, { cuts: res.cuts, version: res.version, versionChangesFacts: res.versionChangesFacts }, prior);
        const noneNew = !!prior && res.cuts.length === 0;
        next = { phase: 'wordLimit', text, words: countWords(text), shown: now, more: !noneNew && now.cuts.length < MAX_SHOWN_CUTS, ...(noneNew ? { noneNew } : {}) };
      } else next = failedSearch(res.status);
    } catch {
      next = failedSearch('offline'); // the message never reached the background
    }
    if (t === seq.current) setView(next);
  }

  // The stash: the menu or the shortcut sent a selection here. It fills the text once; its request runs only
  // while fresh, and is dropped from the stash so a reopened panel doesn't send it again.
  useEffect(() => {
    if (tabId === null) return;
    const key = toolsStashKey(tabId);
    let live = true;
    const take = (stash: ToolsStash | null) => {
      if (!live || !stash || taken.current.has(stash.at)) return;
      taken.current.add(stash.at);
      setText(stash.text);
      const fresh = Date.now() - stash.at < STASH_FRESH_MS;
      if (fresh) latest.current.onStash?.();
      if (!stash.request) return;
      void storage.setItem<ToolsStash>(key, { text: stash.text, at: stash.at }).catch(() => {});
      if (fresh) void run(stash.request, stash.text);
    };
    void storage.getItem<ToolsStash>(key).then(take, () => {});
    const unwatch = storage.watch<ToolsStash>(key, take);
    return () => {
      live = false;
      unwatch();
    };
  }, [tabId]); // run() reads the latest props through `latest`

  const onCopied = (ok: boolean) => setCopyNote(ok ? 'Copied.' : "Couldn't copy.");
  const results = (() => {
    switch (view.phase) {
      case 'idle':
        return null;
      case 'loading':
        return (
          <p className="tools-loading" role="status">
            {view.label}
          </p>
        );
      case 'critique':
        return (
          <>
            <p className="tools-weakness">{view.weakness}</p>
            <ul className="tools-results">
              <li className="tools-result">
                <p className="tools-text">
                  <Diff from={view.original} to={view.lightFix} />
                </p>
                <CopyButton text={view.lightFix} label="Copy this version" onCopied={onCopied} />
              </li>
            </ul>
            {isVoice(view.request) && changesClaims(view.original, view.lightFix, LENIENT) && <p className="tools-facts">{TOOLS_COPY.checkFacts}</p>}
            <Button size="sm" onClick={() => void run(view.request, view.original, 'variants')}>
              {isVoice(view.request) ? TOOLS_COPY.showVersion : 'Show 3 rewrites'}
            </Button>
          </>
        );
      case 'variants':
        return (
          <ul className="tools-results">
            {view.variants.map((v, i) => (
              <li key={i} className="tools-result">
                <p className="tools-text">
                  <Diff from={view.original} to={v} />
                </p>
                <CopyButton text={v} label={`Copy version ${i + 1}`} onCopied={onCopied} />
              </li>
            ))}
          </ul>
        );
      case 'voice':
        // Nothing generic found, and the passage came back as it was: nothing to copy.
        if (view.tells.length === 0 && view.final === view.original) return <p className="tools-tells">{ALREADY_YOU}</p>;
        return (
          <>
            <p className="tools-tells">{tellsLine(view.tells)}</p>
            <ul className="tools-results">
              <li className="tools-result">
                <p className="tools-text">
                  <Diff from={view.original} to={view.final} />
                </p>
                <CopyButton text={view.final} label="Copy this version" onCopied={onCopied} />
              </li>
            </ul>
            {changesClaims(view.original, view.final, LENIENT) && <p className="tools-facts">{TOOLS_COPY.checkFacts}</p>}
          </>
        );
      case 'synonyms':
        return (
          <ul className="tools-results">
            {view.options.map((o, i) => (
              <li key={i} className="tools-result">
                <p className="tools-text">
                  <span className="tools-word">{o.text}</span> <span className="tools-nuance">{o.nuance}</span>
                </p>
                <CopyButton text={o.text} label={`Copy "${o.text}"`} onCopied={onCopied} />
              </li>
            ))}
          </ul>
        );
      case 'wordLimitPick':
        return <TargetPicker key={view.text} words={view.words} onFind={(target) => void findCuts(view.text, target)} />;
      case 'wordLimit': {
        const { text, shown } = view;
        const facts = shown.version !== null && shown.versionChangesFacts;
        return (
          <CutList
            key={shown.cuts.length}
            original={text}
            words={view.words}
            target={shown.target}
            cuts={shown.cuts}
            selected={shown.selected}
            note={view.noneNew ? TOOLS_COPY.noMoreCuts : undefined}
            error={view.error}
            actions={(picked) => (
              <>
                <CopyButton
                  text={applyCuts(text, shown.cuts.filter((_, i) => picked[i]))}
                  label="Copy selected"
                  idle="Copy selected"
                  disabled={!picked.some(Boolean)}
                  onCopied={onCopied}
                />
                {shown.version !== null && (
                  <CopyButton
                    text={shown.version}
                    label={`Copy full version (${countWords(shown.version)} words)`}
                    idle={`Copy full version (${countWords(shown.version)} words)`}
                    describedBy={facts ? factsId : undefined}
                    onCopied={onCopied}
                  />
                )}
                {view.more && (
                  <Button size="sm" onClick={() => void findCuts(text, shown.target, { ...shown, selected: picked })}>
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
        );
      }
      case 'error':
        return (
          <p className="tools-error" role="alert">
            {view.text}
          </p>
        );
    }
  })();

  return (
    <section aria-label="Tools" className="tools">
      <textarea
        className="tools-input"
        aria-label="Paste or select text"
        placeholder="Paste or select text"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {tooLong && <p className="muted tools-note">{limitTooLong ? TOOLS_COPY.tooLongForLimit : TOOLS_COPY.onlyLimit}</p>}
      <div className="tools-actions">
        <div className="tools-lead">
          {actions.lead.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={a.id === 'improve' ? 'primary' : 'secondary'}
              disabled={!canDo(a.run)}
              onClick={() => void run(a.run, text)}
            >
              {a.id === 'improve' && <SparkleIcon size={14} />}
              {a.label}
            </Button>
          ))}
        </div>
        {actions.groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label} className="tools-group">
            <span className="tools-group-label" aria-hidden="true">
              {g.label}
            </span>
            <div className="tools-group-items">
              {g.items.map((item) => (
                <Button key={item.id} size="sm" disabled={!canDo(item.run)} onClick={() => void run(item.run, text)}>
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <input
        type="text"
        className="tools-custom"
        placeholder="Or tell EngLint what to do…"
        aria-label="Or tell EngLint what to do"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !canRun) return;
          e.preventDefault();
          void run({ kind: 'custom', instruction }, text);
        }}
      />
      {results}
      <p className="sr-only" role="status">
        {copyNote}
      </p>
    </section>
  );
}
