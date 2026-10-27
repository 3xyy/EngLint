// The side panel's Tools: rewrite or find synonyms for text no field holds (page text, a canvas app, Docs in
// fallback mode). The right-click menu and the shortcut put the selection here (the stash, background/
// menus.ts); the user can also paste. Same rewrite and synonyms messages as the popover, Copy only (there is
// no field to apply to). Nothing here logs the text or the answers.
import { useEffect, useRef, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { type ToolsStash, toolsStashKey } from '../../background/menus';
import { Diff } from '../../content/overlay/ToolsPopover';
import { MAX_SELECTION_CHARS } from '../../content/tools/selection';
import { TOOLS_COPY } from '../../content/tools/tools-controller';
import { changesClaims } from '../../core/claims';
import { ALREADY_YOU, tellsLine } from '../../core/follow-up';
import { effectiveMode } from '../../core/modes';
import { isVoice, presetsFor, type RewriteToolRequest, type ToolRequest } from '../../core/presets';
import { webHost } from '../../core/sites';
import type { CheckStatus, Mode } from '../../core/types';
import { sendMessage } from '../../shared/messages';
import { essaySitesItem, siteModesItem } from '../../shared/settings';
import { toolStatusText } from '../../shared/status-text';
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
  | { phase: 'error'; text: string };

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Copies `text`; reads `idle` ("Copy" unless given), then "Copied" or "Couldn't copy" for a moment. */
export function CopyButton({ text, label, idle = 'Copy', onCopied }: { text: string; label: string; idle?: string; onCopied?(ok: boolean): void }) {
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
    <button type="button" className="btn tools-copy" aria-label={label} onClick={() => void copy()}>
      {copied === null ? idle : copied ? 'Copied' : "Couldn't copy"}
    </button>
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
  const seq = useRef(0); // a newer run makes an older answer stop
  const taken = useRef(new Set<number>()); // stashes already used (by `at`): each fills the text once
  const who = useProviderInfo();
  const latest = useRef({ tabId, fallbackHost, spend, onStash, who });
  latest.current = { tabId, fallbackHost, spend, onStash, who };

  const target = text.trim();
  const tooLong = target.length > MAX_SELECTION_CHARS;
  const canRun = target !== '' && !tooLong && view.phase !== 'loading';
  const canSynonyms = canRun && wordCount(target) <= MAX_SYNONYM_WORDS;

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

  /** Runs `r` on `raw` (trimmed): in Essay mode a rewrite starts with the critique, unless `stage` says. */
  async function run(r: ToolRequest, raw: string, stage?: 'critique' | 'variants') {
    const selection = raw.trim();
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
            <button type="button" className="btn" onClick={() => void run(view.request, view.original, 'variants')}>
              {isVoice(view.request) ? TOOLS_COPY.showVersion : 'Show 3 rewrites'}
            </button>
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
      {tooLong && <p className="muted tools-note">{TOOLS_COPY.tooLong}</p>}
      <div className="tools-actions">
        {presetsFor(mode).map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn"
            disabled={!canRun}
            onClick={() => void run({ kind: 'preset', presetId: p.id }, text)}
          >
            {p.title}
          </button>
        ))}
        <button type="button" className="btn" disabled={!canSynonyms} onClick={() => void run({ kind: 'synonyms' }, text)}>
          Synonyms
        </button>
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
