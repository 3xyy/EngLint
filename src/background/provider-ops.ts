import { costFromUsage } from '../core/cost';
import { endpointOf, keyNeeded, PRESETS, validateBaseURL, type KeySlot, type PresetId, type ProviderConfig } from '../core/provider';
import { isExtensionPage } from '../core/sites';
import type { Dialect } from '../core/types';
import type { ListModelsResponse, TestKeyResponse } from '../shared/messages';
import { dialectItem } from '../shared/settings';
import { LiveCheckParseError } from './claude';
import { isModelNotFound, statusFromError, statusFromHttp } from './errors';
import { keyForProvider } from './key-store';
import type { LlmClient } from './llm';
import { compatibleBlocked, endpointBlocked, readProvider, type ProviderDeps } from './provider-gate';
import { recordSpend } from './usage';

/** A model list that hasn't arrived by then is given up (Chrome's own limit is far longer). */
const LIST_TIMEOUT_MS = 15_000;

export interface ProviderOpsDeps extends ProviderDeps {
  extensionOrigin: string;
  /** The key in `slot` for calls to `endpoint` (a Custom key only for the address it was saved for), or null. */
  getKey(slot: KeySlot, endpoint: string): Promise<string | null>;
  /** The client for `provider`, the settings the call read once; `key` is null only for a provider that needs none. */
  makeClient(provider: ProviderConfig, key: string | null): LlmClient | Promise<LlmClient>;
  /** Default: the saved dialect. */
  getDialect?(): Promise<Dialect>;
  now(): Date;
  /** Default: the global fetch. */
  fetch?: typeof fetch;
}

/** The preset a compatible slot names, or null for any other value (the message comes from a page). */
function presetOf(slot: unknown): PresetId | null {
  if (typeof slot !== 'string' || !slot.startsWith('compatible:')) return null;
  const id = slot.slice('compatible:'.length);
  return Object.hasOwn(PRESETS, id) ? (id as PresetId) : null;
}

/** The ids in an OpenAI-style model list (`{ data: [{ id }] }`), sorted, once each; null when it isn't one. */
function modelIds(body: unknown): string[] | null {
  const data = body !== null && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return null;
  const ids = data.flatMap((m) => (m !== null && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? [(m as { id: string }).id] : []));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** What the Options page asks of the provider: an endpoint's models, and a test call. Both answer only to EngLint's pages. */
export function createProviderOps(deps: ProviderOpsDeps) {
  const bad = { ok: false as const, status: 'bad_response' as const };
  return {
    /**
     * The models the endpoint for `slot` lists. The address is endpointOf's (a fixed preset's own, whatever the page
     * sent). The key is the one typed on the page (`key`: the Options page lists before it stores a key, which it does
     * only with the config), else the stored one for that address; none for a local server. Chrome must allow the
     * endpoint, as for any call.
     */
    async listModels(p: { slot: KeySlot; baseURL: string; key?: string }, senderUrl: string | undefined): Promise<ListModelsResponse> {
      if (!isExtensionPage(senderUrl, deps.extensionOrigin)) return bad;
      const preset = presetOf(p?.slot);
      if (!preset) return bad;
      const target = { preset, baseURL: typeof p.baseURL === 'string' ? p.baseURL : '' };
      const endpoint = endpointOf(target);
      if (!validateBaseURL(endpoint).ok) return bad;
      const typed = typeof p.key === 'string' ? p.key.trim() : '';
      const key = PRESETS[preset].needsKey ? typed || (await deps.getKey(`compatible:${preset}`, endpoint)) : null;
      if (PRESETS[preset].needsKey && !key) return { ok: false, status: 'key_missing' };
      if (await compatibleBlocked(deps, target)) return { ok: false, status: 'endpoint_blocked' };
      try {
        const res = await (deps.fetch ?? fetch)(`${endpoint.replace(/\/+$/, '')}/models`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, status: statusFromHttp(res.status, await res.text().catch(() => '')) };
        const models = modelIds(await res.json());
        return models ? { ok: true, models } : bad;
      } catch (err) {
        return { ok: false, status: statusFromError(err) };
      }
    },

    /**
     * One sentence through the active provider's live check, billed like any other. `model` is the one that answered,
     * or, with `modelNotFound`, the one the endpoint doesn't know.
     */
    async testKey(senderUrl: string | undefined): Promise<TestKeyResponse> {
      if (!isExtensionPage(senderUrl, deps.extensionOrigin)) return bad;
      const provider = await readProvider(deps);
      const key = await keyForProvider({ keyFor: deps.getKey }, provider);
      if (!key && keyNeeded(provider)) return { ok: false, status: 'key_missing' };
      if (await endpointBlocked(deps, provider)) return { ok: false, status: 'endpoint_blocked' };
      let client: LlmClient | null = null;
      try {
        const dialect = await (deps.getDialect ?? (() => dialectItem.getValue()))();
        client = await deps.makeClient(provider, key);
        const { usage, model } = await client.liveCheck({ mode: 'standard', dialect, paragraphs: [{ id: 'p0', text: 'This are a test.' }] });
        await recordSpend(costFromUsage(model, usage, client.prices), deps.now());
        return { ok: true, status: 'ok', usage, model };
      } catch (err) {
        if (client?.provider === 'compatible' && isModelNotFound(err)) return { ok: false, status: 'bad_response', model: client.fastModel, modelNotFound: true };
        // An answer that didn't parse was billed all the same.
        if (err instanceof LiveCheckParseError && err.billed) await recordSpend(costFromUsage(err.billed.model, err.billed.usage, client?.prices), deps.now());
        return { ok: false, status: statusFromError(err) };
      }
    },
  };
}
