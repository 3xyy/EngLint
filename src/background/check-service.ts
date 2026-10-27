import { costFromUsage } from '../core/cost';
import { keyNeeded, type ProviderConfig } from '../core/provider';
import { isPageDisabled, webHost } from '../core/sites';
import type { CheckStatus, RawIssue } from '../core/types';
import type { CheckRequest, CheckResponse } from '../shared/messages';
import { dialectItem, dictionaryItem, disabledSitesItem } from '../shared/settings';
import { cacheKey, cacheVia, getCached, getDismissalsFor, putCached } from './cache';
import { LiveCheckParseError } from './claude';
import { statusFromError } from './errors';
import type { LlmClient } from './llm';
import { learnedKey, type Learned } from './prompts/live-check';
import { endpointBlocked, readProvider, type ProviderDeps } from './provider-gate';
import { isOverCap, recordSpend } from './usage';

const MAX_PARAGRAPHS = 12;
const MAX_CHARS = 6000;
const PAUSE_MS = 30_000;

export interface CheckServiceDeps extends ProviderDeps {
  /**
   * The key a call on `provider` (the settings the call read, once) may carry: its slot's, and a Custom key only for
   * the address it was saved for; null when there is none.
   */
  getApiKey(provider: ProviderConfig): Promise<string | null>;
  /** The client for `provider`, the settings the call read once; `key` is null only for a provider that needs none. */
  makeClient(provider: ProviderConfig, key: string | null): LlmClient | Promise<LlmClient>;
  now(): Date;
}

/** Highest first. */
const SEVERITY_ORDER: CheckStatus[] = [
  'key_invalid', 'key_missing', 'endpoint_blocked', 'out_of_credit', 'paused_cap', 'rate_limited', 'overloaded', 'offline', 'bad_response', 'ok',
];
function worst(statuses: Iterable<CheckStatus>): CheckStatus {
  const set = new Set(statuses);
  return SEVERITY_ORDER.find((s) => set.has(s)) ?? 'ok';
}

/** A response that fails the schema is dropped and logged. Counts and error classes only: the cause's message can quote page text. */
function logSchemaFailure(err: LiveCheckParseError, paragraphs: number): void {
  const cause = err.cause instanceof Error ? err.cause.name : typeof err.cause;
  console.warn('EngLint: dropped a response that did not match the schema', { error: err.name, cause, paragraphs });
}

/** Groups paragraphs into batches of at most 12 paragraphs / 6,000 characters; an oversize paragraph ends up alone because it overflows the current batch and the next item overflows it in turn. */
function makeBatches<T extends { text: string }>(items: T[]): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  const flush = () => {
    if (cur.length) batches.push(cur);
    cur = [];
    chars = 0;
  };
  for (const it of items) {
    if (cur.length >= MAX_PARAGRAPHS || chars + it.text.length > MAX_CHARS) flush();
    cur.push(it);
    chars += it.text.length;
  }
  flush();
  return batches;
}

export interface CheckContext {
  /** The sender tab's top-level host (from `sender.tab.url`, never from the page): a frame inside a switched-off site is off too. */
  topHost?: string | null;
}

export type CheckService = { check(req: CheckRequest, ctx?: CheckContext): Promise<CheckResponse> };

/** The `check` message: the top-level host comes from the sender's tab, never from the page's request. */
export function checkFromSender(service: CheckService, req: CheckRequest, sender: { tab?: { url?: string } }): Promise<CheckResponse> {
  return service.check(req, { topHost: webHost(sender.tab?.url) });
}

export function createCheckService(deps: CheckServiceDeps): CheckService {
  // In-memory only; a service-worker restart forgets both, which is acceptable.
  let invalidKey: string | null = null;
  let pause: { until: number; status: CheckStatus } | null = null;

  async function check(req: CheckRequest, ctx: CheckContext = {}): Promise<CheckResponse> {
    const unique = [...new Map(req.paragraphs.map((p) => [p.hash, p])).values()];
    const dismissedFor = () => getDismissalsFor(unique.map((p) => p.hash));

    const disabled = await disabledSitesItem.getValue();
    if (isPageDisabled(disabled, req.host, ctx.topHost)) {
      return { status: 'off_site', results: {}, dismissed: [] };
    }

    // The family toggles and the "Stop suggesting" rules are a client filter (selectIssues): the request and its
    // cache key never depend on them. The dictionary is part of the prompt, so it is part of the cache key.
    // The provider settings are read once: the key, the permission, the client and the cache key all follow that
    // one read, so a Save landing mid-call can't send one provider's key to another's endpoint.
    const provider = await readProvider(deps);
    const [key, dialect, dictionary] = await Promise.all([deps.getApiKey(provider), dialectItem.getValue(), dictionaryItem.getValue()]);
    const learned: Learned = { dictionary };
    const userHash = learnedKey(learned);
    const via = cacheVia(provider);
    const keyOf = (hash: string) => cacheKey(hash, req.mode, dialect, userHash, via);

    const cached = await getCached(unique.map((p) => keyOf(p.hash)));
    const results: Record<string, RawIssue[]> = {};
    const uncached: typeof unique = [];
    for (const p of unique) {
      const hit = cached.get(keyOf(p.hash));
      if (hit) results[p.hash] = hit;
      else uncached.push(p);
    }
    const done = async (status: CheckStatus): Promise<CheckResponse> => ({
      status,
      results,
      dismissed: await dismissedFor(),
    });

    if (!key && keyNeeded(provider)) return done('key_missing');
    if (invalidKey !== null && invalidKey !== key) invalidKey = null;
    if (invalidKey !== null) return done('key_invalid');
    if (await isOverCap(deps.now())) return done('paused_cap');
    if (pause && deps.now().getTime() < pause.until) return done(pause.status);
    if (uncached.length === 0) return done('ok');
    if (await endpointBlocked(deps, provider)) return done('endpoint_blocked');

    let client: LlmClient;
    try {
      client = await deps.makeClient(provider, key);
    } catch (err) {
      return done(statusFromError(err));
    }
    const statuses: CheckStatus[] = [];
    let stop = false;

    async function runBatch(batch: typeof uncached, canSplit: boolean): Promise<void> {
      if (stop) return;
      if (await isOverCap(deps.now())) {
        statuses.push('paused_cap');
        stop = true;
        return;
      }
      let out: Awaited<ReturnType<LlmClient['liveCheck']>>;
      try {
        out = await client.liveCheck({
          mode: req.mode,
          dialect,
          learned,
          paragraphs: batch.map((p, i) => ({ id: `p${i}`, text: p.text })),
        });
      } catch (err) {
        const status = statusFromError(err);
        if (err instanceof LiveCheckParseError) {
          logSchemaFailure(err, batch.length);
          // An answer that didn't parse was billed all the same (when the client knows its usage).
          if (err.billed) await recordSpend(costFromUsage(err.billed.model, err.billed.usage, client.prices), deps.now());
        }
        statuses.push(status);
        if (status === 'key_invalid') invalidKey = key;
        if (status === 'rate_limited' || status === 'overloaded') {
          pause = { until: deps.now().getTime() + PAUSE_MS, status };
        }
        // Retrying the remaining batches would fail the same way.
        if (status !== 'bad_response') stop = true;
        return;
      }
      // Truncated calls are billed too.
      await recordSpend(costFromUsage(out.model, out.usage, client.prices), deps.now());
      if (out.droppedInvalid > 0) {
        console.warn('EngLint: dropped issues that did not match the schema', {
          droppedIssues: out.droppedInvalid,
          paragraphs: batch.length,
        });
      }
      if (out.truncated) {
        if (batch.length > 1 && canSplit) {
          const mid = Math.ceil(batch.length / 2);
          await runBatch(batch.slice(0, mid), false);
          await runBatch(batch.slice(mid), false);
        } else {
          statuses.push('bad_response');
        }
        return;
      }
      const byId = new Map<string, RawIssue[]>();
      for (const r of out.output.results) {
        byId.set(r.paragraph_id, [...(byId.get(r.paragraph_id) ?? []), ...r.issues]);
      }
      const entries: Array<[string, RawIssue[]]> = [];
      batch.forEach((p, i) => {
        const issues = byId.get(`p${i}`) ?? [];
        results[p.hash] = issues;
        entries.push([keyOf(p.hash), issues]);
      });
      await putCached(entries);
    }

    for (const batch of makeBatches(uncached)) await runBatch(batch, true);
    return done(worst(statuses));
  }

  return { check };
}
