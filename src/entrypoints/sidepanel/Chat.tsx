// The side panel's Chat: questions about the focused field's whole text. Each message first reads the text
// from the field's frame (fieldText), then goes over the englint-chat port; the background (chat-service.ts)
// builds the context, keeps the conversation in storage.session and streams the answer back. An answer's
// edits get Apply when canApply allows it on the field's text (the content script checks again before it
// writes: applyEdit); one too big for an essay shows only its original; any other gets Copy. Nothing here
// logs the text, the messages or the answers.
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadChat } from '../../background/chat-store';
import { Diff } from '../../content/overlay/ToolsPopover';
import {
  canApplyAll,
  CHAT_PORT,
  MAX_CHAT_MESSAGE,
  visibleSoFar,
  type ChatClientMessage,
  type ChatFocus,
  type ChatServerMessage,
  type ApplyCheck,
  type ChatTurn,
  type Edit,
} from '../../core/chat-format';
import type { CheckStatus, Mode } from '../../core/types';
import { sendMessage, type ApplyEditResult } from '../../shared/messages';
import { APPLY_FAILED, APPLY_FAILED_COPIED, toolStatusText, UNREACHABLE_FIELD } from '../../shared/status-text';
import { useProviderInfo } from '../../shared/use-provider-info';
import { CopyButton } from './Tools';

export const CHAT_COPY = {
  placeholder: 'Ask about your writing…',
  newChat: 'New chat',
  empty: 'Ask anything about this text. In essays, EngLint coaches rather than writes.',
  noField: 'Click into a text box or document, then ask.',
  changed: 'The text changed. Ask again.',
  blocked: "This edit can't be applied automatically. Copy it instead.",
  failedCopied: APPLY_FAILED_COPIED,
  failed: APPLY_FAILED,
  /** In place of an essay edit's replacement and its Copy button: more than 3 new words. */
  tooBig: 'Too big a change to suggest for an essay — try revising it yourself.',
  elsewhere: 'Answering about another text box…',
} as const;

/** The parts of a `runtime.Port` the Chat uses. */
export interface ChatPortLike {
  postMessage(message: ChatClientMessage): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

const connectToBackground = (): ChatPortLike => browser.runtime.connect({ name: CHAT_PORT });

type Entry = { role: 'user'; text: string } | { role: 'assistant'; text: string; edits: Edit[]; status?: string };
/** The answer streaming now: which field's chat it belongs to, the question, and the raw text so far. */
interface Live {
  id: number;
  key: string;
  tabId: number;
  fieldId: string;
  message: string;
  raw: string;
}
/** What happened to an edit here: Apply on its way, applied, Copy only from now on, or too big for an essay. */
type EditState = 'applying' | 'applied' | 'copy' | 'too_big';

/** Puts `text` on the clipboard; false when the browser refuses (no focus or permission). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const toEntry = (t: ChatTurn): Entry => (t.role === 'user' ? { role: 'user', text: t.text } : { role: 'assistant', text: t.text, edits: t.edits ?? [] });

function EditRow({
  n,
  edit,
  check,
  state,
  onApply,
  onCopied,
}: {
  n: number;
  edit: Edit;
  check: ApplyCheck;
  state: EditState | undefined;
  onApply(): void;
  onCopied(ok: boolean): void;
}) {
  // In Essay, a change too big to suggest shows where it was meant to go, never the model's words.
  if (state === 'too_big' || (check === 'too_big' && (state === undefined || state === 'copy'))) {
    return (
      <li className="chat-edit chat-edit-too-big">
        <p className="chat-edit-text">“{edit.original}”</p>
        <p className="muted chat-edit-note">{CHAT_COPY.tooBig}</p>
      </li>
    );
  }
  const apply = state === 'applying' || state === 'applied' || (state === undefined && check === 'ok');
  return (
    <li className="chat-edit">
      <p className="chat-edit-text">
        <Diff from={edit.original} to={edit.replacement} />
      </p>
      {apply ? (
        <button type="button" className="btn chat-apply" aria-label={`Apply edit ${n}`} disabled={state !== undefined} onClick={onApply}>
          {state === 'applied' ? 'Applied' : 'Apply'}
        </button>
      ) : (
        <CopyButton text={edit.replacement} label={`Copy edit ${n}`} onCopied={onCopied} />
      )}
    </li>
  );
}

export function Chat({
  tabId,
  fieldId,
  frameId,
  spend,
  shown = true,
  connect = connectToBackground,
}: {
  tabId: number | null;
  /** The field the panel follows (TabState's active field), or null when there is none. */
  fieldId: string | null;
  /** The frame that field lives in. */
  frameId: number;
  spend: { spent: number; cap: number } | null;
  /** Whether the Chat tab is showing: hidden, it reads neither the field's text nor its conversation. */
  shown?: boolean;
  connect?: () => ChatPortLike;
}) {
  const key = tabId !== null && fieldId !== null ? `${tabId}:${fieldId}` : null;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  /** The field's text as last read, for choosing Apply or Copy. */
  const [doc, setDoc] = useState<{ key: string; text: string; mode: Mode } | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState('');
  const [edits, setEdits] = useState<Record<number, EditState>>({});
  const [loading, setLoading] = useState(false); // the field's stored conversation is on its way
  const [reading, setReading] = useState(false); // the field's text is on its way, before a send

  // The port's listeners outlive renders: they read everything through refs.
  const who = useProviderInfo();
  const current = useRef({ tabId, fieldId, frameId, key, spend, who });
  current.current = { tabId, fieldId, frameId, key, spend, who };
  const liveRef = useRef<Live | null>(null); // the source of truth: deltas can arrive faster than renders
  const portRef = useRef<ChatPortLike | null>(null);
  const loadSeq = useRef(0); // a newer load (or New chat) makes an older one stop
  const loadingRef = useRef(false);
  /** The field (tab:field) whose conversation the view holds; it follows `key` only while the Chat is shown. */
  const viewKey = useRef<string | null>(null);
  const turnIds = useRef(0);
  /** The live turn a load began during (that field's): its done reloads, as the load may already hold it. */
  const loadDuring = useRef<number | null>(null);
  /** A turn that ended in a status while the conversation loaded: shown once the load settles. */
  const held = useRef<Entry[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const setLiveNow = (next: Live | null) => {
    liveRef.current = next;
    setLive(next);
  };
  const statusCopy = (status: CheckStatus) =>
    toolStatusText(status === 'ok' ? 'bad_response' : status, current.current.spend ?? undefined, current.current.who) ?? '';

  /** The field's stored conversation becomes the view. */
  function load(tabId: number, fieldId: string) {
    const seq = ++loadSeq.current;
    loadingRef.current = true;
    setLoading(true);
    const turn = liveRef.current;
    loadDuring.current = turn && turn.key === `${tabId}:${fieldId}` ? turn.id : null;
    const settle = (turns: ChatTurn[] | null) => {
      if (seq !== loadSeq.current) return;
      loadingRef.current = false;
      setLoading(false);
      const waiting = held.current;
      held.current = [];
      if (turns) setEntries([...turns.map(toEntry), ...waiting]);
      else if (waiting.length > 0) setEntries((prev) => [...prev, ...waiting]);
    };
    void loadChat(tabId, fieldId).then(settle, () => settle(null));
  }

  /** Reads the field's text, selection and mode from its frame; null when it can't be reached. */
  async function readText(): Promise<{ text: string; focus: ChatFocus; mode: Mode } | null> {
    const { tabId, fieldId, frameId, key } = current.current;
    if (tabId === null || fieldId === null || key === null) return null;
    try {
      const r = await sendMessage('fieldText', { fieldId }, { tabId, frameId });
      if (!r?.ok || typeof r.text !== 'string') return null;
      const got = { text: r.text, focus: r.focus ?? null, mode: r.mode ?? 'standard' };
      if (current.current.key === key) setDoc({ key, text: got.text, mode: got.mode });
      return got;
    } catch {
      return null;
    }
  }

  /** Ends the streaming turn with `answer`. An answer about a field no longer shown isn't painted here. */
  function endTurn(answer: Extract<Entry, { role: 'assistant' }>) {
    const ended = liveRef.current;
    if (!ended) return;
    setLiveNow(null);
    if (ended.key !== viewKey.current) return;
    const turn: Entry[] = [{ role: 'user', text: ended.message }, answer];
    if (answer.status !== undefined) {
      // Not kept by the background, so only shown here; a load on its way would replace it, so it waits for that.
      if (loadingRef.current) held.current = [...held.current, ...turn];
      else setEntries((prev) => [...prev, ...turn]);
      return;
    }
    // Kept before its done was sent. A load that began during this turn (the panel came back to this field) may
    // hold it already, or may have read storage just before: read again rather than add it a second time.
    if (loadingRef.current || loadDuring.current === ended.id) {
      loadDuring.current = null;
      load(ended.tabId, ended.fieldId);
    } else {
      setEntries((prev) => [...prev, ...turn]);
    }
    if (answer.edits.length > 0) void readText(); // the text may have changed while it streamed
  }

  function onPortMessage(raw: unknown) {
    const m = raw as ChatServerMessage;
    const turn = liveRef.current;
    if (!turn || typeof m !== 'object' || m === null) return; // nothing asked, or New chat stopped it: a late piece
    if (m.type === 'delta' && typeof m.text === 'string') setLiveNow({ ...turn, raw: turn.raw + m.text });
    else if (m.type === 'done') endTurn({ role: 'assistant', text: m.message, edits: m.edits ?? [] });
    else if (m.type === 'status') endTurn({ role: 'assistant', text: visibleSoFar(turn.raw), edits: [], status: statusCopy(m.status) });
  }
  const onPortMessageRef = useRef(onPortMessage);
  onPortMessageRef.current = onPortMessage;
  const onPortGoneRef = useRef(() => {});
  onPortGoneRef.current = () => {
    const turn = liveRef.current;
    if (turn) endTurn({ role: 'assistant', text: visibleSoFar(turn.raw), edits: [], status: statusCopy('offline') });
  };

  function port(): ChatPortLike {
    if (portRef.current) return portRef.current;
    const p = connect();
    portRef.current = p;
    p.onMessage.addListener((m) => {
      if (portRef.current === p) onPortMessageRef.current(m);
    });
    p.onDisconnect.addListener(() => {
      if (portRef.current !== p) return;
      portRef.current = null;
      onPortGoneRef.current();
    });
    return p;
  }

  /** Posts on the port, connecting again once if it broke unnoticed; false when that fails too. */
  function post(message: ChatClientMessage): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        port().postMessage(message);
        return true;
      } catch {
        portRef.current = null;
      }
    }
    return false;
  }

  // Another field (or tab): its stored conversation, and its text for judging the edits there. Hidden, the Chat
  // reads nothing (on Docs each read is a bridge round trip) and catches up when shown; a field gone needs no read.
  useEffect(() => {
    if (key === viewKey.current) return;
    if (key !== null && !shown) return;
    viewKey.current = key;
    held.current = [];
    loadDuring.current = null;
    setEntries([]);
    setNote(null);
    setEdits({});
    setDoc(null);
    if (tabId === null || fieldId === null) {
      ++loadSeq.current;
      loadingRef.current = false;
      setLoading(false);
      return;
    }
    load(tabId, fieldId);
    void readText();
  }, [key, shown]); // load() and readText() read the latest props through `current`

  useEffect(
    () => () => {
      const p = portRef.current;
      portRef.current = null;
      p?.disconnect();
    },
    [],
  );

  const shownLive = live && live.key === key ? live : null;
  const elsewhere = live !== null && live.key !== key && key !== null; // another field's answer is streaming
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [entries.length, shownLive?.raw]);

  async function send() {
    const { tabId, fieldId, key } = current.current;
    const message = draft.trim();
    if (tabId === null || fieldId === null || key === null) return;
    if (message === '' || draft.length > MAX_CHAT_MESSAGE || liveRef.current || reading || loadingRef.current) return;
    setNote(null);
    setReading(true);
    const got = await readText();
    setReading(false);
    if (current.current.key !== key) return; // the panel moved to another field meanwhile
    if (!got) return setNote(UNREACHABLE_FIELD);
    setLiveNow({ id: ++turnIds.current, key, tabId, fieldId, message, raw: '' });
    setDraft('');
    if (!post({ type: 'send', tabId, fieldId, mode: got.mode, text: got.text, focus: got.focus, message })) onPortGoneRef.current();
  }

  function newChat() {
    const { tabId, fieldId } = current.current;
    if (tabId === null || fieldId === null) return;
    // The background stops this field's answer if it is streaming (its last pieces may still arrive, and are
    // dropped); another field's answer goes on.
    if (liveRef.current?.key === current.current.key) setLiveNow(null);
    ++loadSeq.current; // a load on its way must not bring the old turns back
    loadingRef.current = false;
    held.current = [];
    loadDuring.current = null;
    setLoading(false);
    setEntries([]);
    setNote(null);
    setEdits({});
    post({ type: 'reset', tabId, fieldId });
  }

  async function apply(n: number, edit: Edit) {
    const { tabId, fieldId, frameId, key } = current.current;
    if (tabId === null || fieldId === null) return;
    setNote(null);
    setEdits((prev) => ({ ...prev, [n]: 'applying' }));
    let result: ApplyEditResult | null = null;
    try {
      result = (await sendMessage('applyEdit', { fieldId, original: edit.original, replacement: edit.replacement }, { tabId, frameId }))?.result ?? null;
    } catch {
      // the frame is gone
    }
    if (current.current.key !== key) return;
    if (result === null) {
      setEdits(({ [n]: _, ...rest }) => rest); // nothing happened: Apply stays
      return setNote(UNREACHABLE_FIELD);
    }
    setEdits((prev) => ({ ...prev, [n]: result === 'applied' || result === 'too_big' ? result : 'copy' }));
    if (result === 'changed' || result === 'ambiguous') setNote(CHAT_COPY.changed);
    else if (result === 'blocked') setNote(CHAT_COPY.blocked);
    else if (result === 'failed') setNote((await copyText(edit.replacement)) ? CHAT_COPY.failedCopied : CHAT_COPY.failed);
    void readText();
  }

  const onCopied = (ok: boolean) => setCopyNote(ok ? 'Copied.' : "Couldn't copy.");
  const docText = doc && doc.key === key ? doc : null;
  // Judged once per conversation and text read, not on every delta of an answer streaming, and every edit of
  // every answer against one fold of the text.
  const checks = useMemo(() => {
    const all = entries.flatMap((e) => (e.role === 'assistant' ? e.edits : []));
    const judged: ApplyCheck[] = docText ? canApplyAll(docText.text, all, docText.mode) : all.map(() => 'missing');
    let next = 0;
    return entries.map((e) => (e.role === 'assistant' ? e.edits.map(() => judged[next++]!) : []));
  }, [entries, docText]);
  const disabled = key === null || loading || reading || live !== null;
  let editNumber = 0; // numbered through the conversation, so every button's name is its own

  return (
    <section aria-label="Chat" className="chat">
      <div className="chat-head">
        <button type="button" className="btn" disabled={key === null} onClick={newChat}>
          {CHAT_COPY.newChat}
        </button>
      </div>
      <div className="chat-log" role="log">
        {key === null ? (
          <p className="muted chat-empty">{CHAT_COPY.noField}</p>
        ) : (
          entries.length === 0 && !shownLive && !loading && <p className="muted chat-empty">{CHAT_COPY.empty}</p>
        )}
        {entries.map((e, i) =>
          e.role === 'user' ? (
            <div key={i} className="chat-msg chat-user">
              <p className="chat-text">{e.text}</p>
            </div>
          ) : (
            <div key={i} className="chat-msg chat-answer">
              {e.text !== '' && <p className="chat-text">{e.text}</p>}
              {e.edits.length > 0 && (
                <ul className="chat-edits">
                  {e.edits.map((edit, j) => {
                    const n = ++editNumber;
                    return (
                      <EditRow
                        key={j}
                        n={n}
                        edit={edit}
                        check={checks[i]?.[j] ?? 'missing'}
                        state={edits[n]}
                        onApply={() => void apply(n, edit)}
                        onCopied={onCopied}
                      />
                    );
                  })}
                </ul>
              )}
              {e.status && (
                <p className="chat-status" role="alert">
                  {e.status}
                </p>
              )}
            </div>
          ),
        )}
        {shownLive && (
          <>
            <div className="chat-msg chat-user">
              <p className="chat-text">{shownLive.message}</p>
            </div>
            <div className="chat-msg chat-answer" aria-busy="true">
              <p className="chat-text" data-testid="chat-live">
                {visibleSoFar(shownLive.raw)}
              </p>
            </div>
          </>
        )}
      </div>
      {note && (
        <p className="chat-note" role="alert">
          {note}
        </p>
      )}
      {elsewhere && (
        <p className="muted chat-elsewhere" role="status">
          {CHAT_COPY.elsewhere}
        </p>
      )}
      <div className="chat-input" ref={endRef}>
        <textarea
          className="tools-input"
          rows={3}
          placeholder={CHAT_COPY.placeholder}
          aria-label="Ask about your writing"
          maxLength={MAX_CHAT_MESSAGE}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void send();
          }}
        />
      </div>
      <p className="sr-only" role="status">
        {copyNote}
      </p>
    </section>
  );
}
