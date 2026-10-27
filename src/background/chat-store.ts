import { z } from 'zod';
import { storage } from 'wxt/utils/storage';
import { ChatTurnSchema, type ChatTurn } from '../core/chat-format';

/** The most user+assistant pairs kept per field. */
export const MAX_CHAT_PAIRS = 20;

/** The `storage.session` key of one field's conversation. */
export const chatKey = (tabId: number, fieldId: string) => `chat:${tabId}:${fieldId}` as const;
const tabPrefix = (tabId: number) => `chat:${tabId}:`;

const TurnsSchema = z.array(ChatTurnSchema);

/** A field's conversation, oldest first; empty when there is none (or it can't be read). */
export async function loadChat(tabId: number, fieldId: string): Promise<ChatTurn[]> {
  const r = TurnsSchema.safeParse(await storage.getItem(`session:${chatKey(tabId, fieldId)}`));
  return r.success ? r.data : [];
}

// In memory: bumped by every clear, so an answer that finishes after its chat was cleared isn't kept.
const tabEpochs = new Map<number, number>();
const fieldEpochs = new Map<string, number>();
const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

/** A token for the chat's current life; `appendChat` keeps turns only while it still matches. */
export function chatEpoch(tabId: number, fieldId: string): string {
  return `${tabEpochs.get(tabId) ?? 0}:${fieldEpochs.get(chatKey(tabId, fieldId)) ?? 0}`;
}

// Serializes read-modify-write: a clear and an append on one chat must not interleave.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Adds turns to a field's conversation, keeping the last MAX_CHAT_PAIRS pairs. False when the chat was cleared since `epoch`. */
export function appendChat(tabId: number, fieldId: string, turns: ChatTurn[], epoch: string): Promise<boolean> {
  return serialized(async () => {
    if (chatEpoch(tabId, fieldId) !== epoch) return false;
    const all = [...(await loadChat(tabId, fieldId)), ...turns].slice(-2 * MAX_CHAT_PAIRS);
    await storage.setItem(`session:${chatKey(tabId, fieldId)}`, all);
    return true;
  });
}

/** Clears one field's conversation, or (without a field) every conversation in the tab. */
export function clearChat(tabId: number, fieldId?: string): Promise<void> {
  if (fieldId === undefined) bump(tabEpochs, tabId);
  else bump(fieldEpochs, chatKey(tabId, fieldId));
  return serialized(async () => {
    if (fieldId !== undefined) return storage.removeItem(`session:${chatKey(tabId, fieldId)}`);
    const keys = Object.keys(await browser.storage.session.get(null)).filter((k) => k.startsWith(tabPrefix(tabId)));
    await browser.storage.session.remove(keys);
  });
}
