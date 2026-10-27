import { chatContext } from '../core/chat-context';
import {
  CHAT_PORT,
  MAX_CHAT_MESSAGE,
  MAX_CHAT_SELECTION,
  parseChatClientMessage,
  splitAnswer,
  type ChatClientMessage,
  type ChatServerMessage,
} from '../core/chat-format';
import { costFromUsage } from '../core/cost';
import { keyNeeded, type ProviderConfig } from '../core/provider';
import { dialectItem } from '../shared/settings';
import { appendChat, chatEpoch, clearChat, loadChat } from './chat-store';
import type { ChatStream } from './claude';
import { statusFromError } from './errors';
import type { LlmClient } from './llm';
import { buildChatMessages, buildChatSystem } from './prompts/chat';
import { isExtensionPage } from './key-store';
import { endpointBlocked, readProvider, type ProviderDeps } from './provider-gate';
import { tabIsOff } from './tab-site';
import { isOverCap, recordSpend } from './usage';

export interface ChatServiceDeps extends ProviderDeps {
  /**
   * The key a call on `provider` (the settings the call read, once) may carry: its slot's, and a Custom key only for
   * the address it was saved for; null when there is none.
   */
  getApiKey(provider: ProviderConfig): Promise<string | null>;
  /** The client for `provider`, the settings the call read once; `key` is null only for a provider that needs none. */
  makeClient(provider: ProviderConfig, key: string | null): LlmClient | Promise<LlmClient>;
  now(): Date;
  /** The tab's URL (null when Chrome hides it): its host for the off-site check. */
  tabUrl(tabId: number): Promise<string | null>;
  /** This extension's origin (`runtime.getURL('/')`): only its own pages may connect. */
  extensionOrigin: string;
}

/** The parts of a `runtime.Port` the service uses. */
export interface ChatPort {
  name: string;
  /** Who opened the port: an extension page (the side panel) or a content script (then with a tab). */
  sender?: { url?: string };
  postMessage(message: ChatServerMessage): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

type Send = Extract<ChatClientMessage, { type: 'send' }>;

/** About how many characters of English text make one output token, for the spend of a stopped answer. */
const CHARS_PER_TOKEN = 4;

/** The text the writer selected (none for a caret or no focus), cut to MAX_CHAT_SELECTION. */
function selectionOf(msg: Send): string {
  if (!msg.focus || msg.focus.end <= msg.focus.start) return '';
  const text = msg.text.slice(msg.focus.start, msg.focus.end);
  return text.length <= MAX_CHAT_SELECTION ? text : `${text.slice(0, MAX_CHAT_SELECTION - 1)}…`;
}

export function createChatService(deps: ChatServiceDeps) {
  /**
   * Serves one panel's port: one answer streams at a time, and a new send, or a reset of the field being
   * answered, stops the one before.
   * Only this extension's pages are served: the content scripts run on every site, and the port reads any
   * tab's stored chat and spends the API key's credit.
   */
  function connect(port: ChatPort): void {
    if (port.name !== CHAT_PORT || !isExtensionPage(port.sender?.url, deps.extensionOrigin)) return;
    let open = true;
    // The answer streaming now, and whether it was stopped on purpose (nothing more is sent for it).
    let active: { stream: ChatStream; stopped: boolean } | null = null;
    // Incremented by every send, and by a reset of the field being answered, so a send still passing its checks
    // knows it was overtaken.
    let turn = 0;
    // The field (tab:field) the newest send is about, until its turn ends. A reset of another field leaves it be:
    // the writer may start a new chat in one text box while another box's answer streams.
    let turnField: string | null = null;

    const post = (m: ChatServerMessage) => {
      if (!open) return;
      try {
        port.postMessage(m);
      } catch {
        open = false; // the panel went away
      }
    };
    const stop = () => {
      if (!active) return;
      active.stopped = true;
      active.stream.abort();
      active = null;
    };

    async function send(msg: Send, mine: number): Promise<void> {
      const message = msg.message.trim();
      if (message === '' || msg.message.length > MAX_CHAT_MESSAGE) return post({ type: 'status', status: 'bad_response' });
      const url = (await deps.tabUrl(msg.tabId)) ?? '';
      if (await tabIsOff(msg.tabId, deps)) return post({ type: 'status', status: 'off_site' });
      // The provider settings are read once: the key, the permission and the client all follow that read.
      const provider = await readProvider(deps);
      const key = await deps.getApiKey(provider);
      if (!key && keyNeeded(provider)) return post({ type: 'status', status: 'key_missing' });
      if (await isOverCap(deps.now())) return post({ type: 'status', status: 'paused_cap' });
      if (await endpointBlocked(deps, provider)) return post({ type: 'status', status: 'endpoint_blocked' });

      const epoch = chatEpoch(msg.tabId, msg.fieldId);
      const [history, dialect] = await Promise.all([loadChat(msg.tabId, msg.fieldId), dialectItem.getValue()]);
      if (mine !== turn || !open) return; // a newer send or a reset came in meanwhile

      let client: LlmClient;
      try {
        client = await deps.makeClient(provider, key);
      } catch (err) {
        return post({ type: 'status', status: statusFromError(err) });
      }
      if (mine !== turn || !open) return;
      let current: { stream: ChatStream; stopped: boolean };
      let streamed = 0; // characters of answer text received, shown or not: all of it was generated and billed
      try {
        current = {
          stream: client.streamChat(
            {
              system: buildChatSystem(msg.mode, dialect, chatContext(msg.text, msg.focus)),
              messages: buildChatMessages(history, message, selectionOf(msg)),
            },
            (text) => {
              streamed += text.length;
              if (!current.stopped) post({ type: 'delta', text });
            },
          ),
          stopped: false,
        };
      } catch (err) {
        return post({ type: 'status', status: statusFromError(err) });
      }
      active = current;

      let out: Awaited<ChatStream['done']>;
      try {
        out = await current.stream.done;
      } catch (err) {
        // A stopped answer (an abort, the 90 s timer, a dropped connection) is billed for its input once the
        // request starts, and for the output generated before the stop. message_start gives the input and cache
        // tokens; the output is estimated from the text streamed. Thinking isn't in that text, so it is a floor.
        // Nothing is recorded when the stop came before message_start (no text came either).
        const usage = current.stream.usageSoFar();
        if (usage) {
          const output = Math.max(usage.output_tokens, Math.ceil(streamed / CHARS_PER_TOKEN));
          await recordSpend(costFromUsage(client.smartModel, { ...usage, output_tokens: output }, client.prices), deps.now());
        }
        if (!current.stopped) post({ type: 'status', status: statusFromError(err) });
        return;
      } finally {
        if (active === current) active = null;
      }
      // Cut-off answers are billed too.
      await recordSpend(costFromUsage(out.model, out.usage, client.prices), deps.now());
      // A reset or a newer send that came in meanwhile ends this turn: nothing kept, nothing more sent.
      if (current.stopped || mine !== turn) return;
      const answer = splitAnswer(out.text);
      if (!out.complete || (answer.message === '' && answer.edits.length === 0)) return post({ type: 'status', status: 'bad_response' });
      await appendChat(
        msg.tabId,
        msg.fieldId,
        [{ role: 'user', text: message }, { role: 'assistant', text: answer.message, ...(answer.edits.length ? { edits: answer.edits } : {}) }],
        epoch,
      );
      if (mine === turn) post({ type: 'done', message: answer.message, edits: answer.edits });
    }

    port.onMessage.addListener((raw) => {
      const msg = parseChatClientMessage(raw);
      if (!msg) return post({ type: 'status', status: 'bad_response' });
      const field = `${msg.tabId}:${msg.fieldId}`;
      if (msg.type === 'reset') {
        if (turnField === null || turnField === field) {
          stop();
          ++turn;
          turnField = null;
        }
        void clearChat(msg.tabId, msg.fieldId).catch(() => {});
        return;
      }
      // One answer streams at a time: a send stops the one before, whichever field it was about (the panel
      // keeps its box disabled while another field's answer streams).
      stop();
      const mine = ++turn;
      turnField = field;
      void send(msg, mine)
        .catch(() => post({ type: 'status', status: 'bad_response' }))
        .finally(() => {
          if (mine === turn) turnField = null;
        });
    });
    port.onDisconnect.addListener(() => {
      open = false;
      stop();
    });
  }

  return { connect };
}

export type ChatService = ReturnType<typeof createChatService>;

/** Ends a tab's chats when it closes (a new page in the tab: background/tab-pages.ts). */
export function watchTabsForChat(tabs: Pick<typeof browser.tabs, 'onRemoved'>): void {
  tabs.onRemoved.addListener((tabId) => {
    void clearChat(tabId).catch(() => {});
  });
}
