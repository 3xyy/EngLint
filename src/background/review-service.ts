import Anthropic from '@anthropic-ai/sdk';
import { sourcesFromResponse } from '../core/citations';
import { costFromUsage, type UsageLike } from '../core/cost';
import { keyNeeded, supportsWebSearch, type ProviderConfig } from '../core/provider';
import type { SuggestionPolicy } from '../core/match';
import { selectIssues } from '../core/match';
import { hashText, splitParagraphs } from '../core/paragraphs';
import { DEEP_CHECK_JSON_SCHEMA, parseDeepCheckOutput } from '../core/schema';
import {
  MAX_CLAIM_CHARS,
  MAX_CLAIM_CONTEXT_CHARS,
  MAX_READER_CHARS,
  MAX_REVIEW_CHARS,
  MAX_RUBRIC_CHARS,
  MIN_CLAIM_CHARS,
  READER_CHOICES,
  TONE_MAX_CHARS,
} from '../core/review';
import { GRADER_JSON_SCHEMA, READERS_JSON_SCHEMA, TONE_JSON_SCHEMA, cleanGrading, cleanReaders, cleanTone } from '../core/review-schema';
import { defaultFamilies } from '../core/modes';
import { dictionaryForm } from '../core/typography';
import type { CheckStatus, LocatedIssue, Mode, RawIssue } from '../core/types';
import type {
  CitationsRequest,
  CitationsResponse,
  DeepCheckResponse,
  GradeRequest,
  GradeResponse,
  ReadersRequest,
  ReadersResponse,
  ReviewBase,
  ToneResponse,
} from '../shared/messages';
import { dialectItem, dictionaryItem, readSuggestionFamilies, rulesItem } from '../shared/settings';
import type { BilledRun, ToolCall } from './claude';
import { statusFromError } from './errors';
import { endpointBlocked, readProvider, type ProviderDeps } from './provider-gate';
import type { LlmClient } from './llm';
import { isExtensionPage } from './key-store';
import { buildCitationsSystem, buildCitationsUser } from './prompts/citations';
import { buildDeepCheckSystem, buildDeepCheckUser } from './prompts/deep-check';
import { buildGraderSystem, buildGraderUser } from './prompts/grader';
import { buildReadersSystem, buildReadersUser } from './prompts/readers';
import { buildToneSystem, buildToneUser } from './prompts/tone';
import { tabIsOff } from './tab-site';
import { isOverCap, recordSpend } from './usage';

export interface ReviewServiceDeps extends ProviderDeps {
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
  /** This extension's origin (`runtime.getURL('/')`): only its own pages may ask for a review. */
  extensionOrigin: string;
}
/** Who sent a request: only the URL matters (an extension page, never a content script or a web page). */
export interface ReviewSender {
  url?: string;
}

const TONE_CACHE_MAX = 50;

/** An API 400 saying the organization has web search turned off (an admin turns it on in the Claude Console). */
const isSearchOff = (err: unknown) => err instanceof Anthropic.APIError && err.status === 400 && /web search/i.test(err.message);

/** The writer's stored settings for `mode`, as selectIssues takes them: the same policy the page applies to a live check. */
async function readPolicy(mode: Mode): Promise<SuggestionPolicy> {
  const [families, rules, dictionary] = await Promise.all([readSuggestionFamilies(), rulesItem.getValue(), dictionaryItem.getValue()]);
  return {
    mode,
    families: families[mode] ?? defaultFamilies(mode),
    rules: new Set(rules.filter((r) => r.mode === mode).map((r) => r.kind)),
    dictionary: new Set(dictionary.map(dictionaryForm)),
  };
}

export function createReviewService(deps: ReviewServiceDeps) {
  // In-memory only; a service-worker restart forgets it.
  const toneCache = new Map<string, string[]>();

  /**
   * The gates before anything is read from the request's tab: the sender must be one of this extension's pages,
   * and `valid` (the request's own checks) must hold; then the site must be on. `valid` runs only for a trusted
   * sender. Returns the status that stopped it, or null.
   */
  async function senderAndSite(tabId: number, sender: ReviewSender, valid: () => boolean): Promise<CheckStatus | null> {
    if (!isExtensionPage(sender.url, deps.extensionOrigin)) return 'bad_response';
    if (!valid()) return 'bad_response';
    if (await tabIsOff(tabId, deps)) return 'off_site';
    return null;
  }

  /**
   * The gates before a billed call on `provider` (the settings the call read, once): a key, room under the monthly
   * cap, and access to the endpoint; then the client, from the same settings. Returns the client, or the status that
   * stopped it (a client that can't be built included).
   */
  async function keyAndCap(provider: ProviderConfig): Promise<{ client: LlmClient } | { status: CheckStatus }> {
    const key = await deps.getApiKey(provider);
    if (!key && keyNeeded(provider)) return { status: 'key_missing' };
    if (await isOverCap(deps.now())) return { status: 'paused_cap' };
    if (await endpointBlocked(deps, provider)) return { status: 'endpoint_blocked' };
    try {
      return { client: await deps.makeClient(provider, key) };
    } catch (err) {
      return { status: statusFromError(err) };
    }
  }

  /**
   * Waits for a billed request and records its spend: the whole usage of an answer (a truncated one included),
   * or, for a stream that broke after it started, what it had shown (BilledRun.spentSoFar). Returns the answer,
   * or the error.
   */
  async function settle<T extends { usage: UsageLike }>(run: BilledRun<T>, prices: LlmClient['prices']): Promise<{ out: T } | { err: unknown }> {
    let out: T;
    try {
      out = await run.done;
    } catch (err) {
      const spent = run.spentSoFar();
      if (spent) await recordSpend(costFromUsage(run.model, spent, prices), deps.now());
      return { err };
    }
    await recordSpend(costFromUsage(run.model, out.usage, prices), deps.now());
    return { out };
  }

  /**
   * The gates every review passes, in order: the sender, the length backstop and the request's own checks
   * (`valid`), the site, then (unless `cached` has the answer) the key and the cap; then the call that `build`
   * makes, and its spend. The request's own checks run only for a trusted sender, and nothing of it is hashed or
   * built into a prompt before the site passes. `cached` returns an earlier answer's data. Returns the parsed JSON,
   * or the status that stopped it.
   */
  async function runReview(
    req: ReviewBase,
    sender: ReviewSender,
    steps: { valid?: () => boolean; build: () => Promise<ToolCall>; cached?: () => unknown },
  ): Promise<{ status: CheckStatus; data?: unknown }> {
    const stopped = await senderAndSite(
      req.tabId,
      sender,
      () => typeof req.text === 'string' && req.text.length <= MAX_REVIEW_CHARS && (steps.valid?.() ?? true),
    );
    if (stopped) return { status: stopped };
    const hit = steps.cached?.();
    if (hit !== undefined) return { status: 'ok', data: hit };
    const gate = await keyAndCap(await readProvider(deps));
    if ('status' in gate) return gate;

    const settled = await settle(gate.client.startToolCall(await steps.build()), gate.client.prices);
    if ('err' in settled) return { status: statusFromError(settled.err) };
    const { out } = settled;
    if (out.truncated || out.data === null) return { status: 'bad_response' };
    return { status: 'ok', data: out.data };
  }

  async function tone(req: ReviewBase, sender: ReviewSender): Promise<ToneResponse> {
    // Keyed by what is sent: the mode and the first TONE_MAX_CHARS characters.
    const sent = () => req.text.slice(0, TONE_MAX_CHARS);
    const cacheKey = () => hashText(`${req.mode}\n${sent()}`);
    const { status, data } = await runReview(req, sender, {
      build: async () => ({
        kind: 'tone',
        system: buildToneSystem(req.mode, await dialectItem.getValue()),
        user: buildToneUser(sent()),
        schema: TONE_JSON_SCHEMA,
      }),
      cached: () => {
        const tones = toneCache.get(cacheKey());
        return tones && { tones };
      },
    });
    if (status !== 'ok') return { status };
    const tones = cleanTone(data);
    if (!tones) return { status: 'bad_response' };
    const key = cacheKey();
    if (!toneCache.has(key)) {
      if (toneCache.size >= TONE_CACHE_MAX) toneCache.delete(toneCache.keys().next().value!);
      toneCache.set(key, tones);
    }
    return { status: 'ok', tones };
  }

  async function readers(req: ReadersRequest, sender: ReviewSender): Promise<ReadersResponse> {
    const custom = () => (typeof req.custom === 'string' ? req.custom.trim() : '');
    const { status, data } = await runReview(req, sender, {
      valid: () => READER_CHOICES.includes(req.reader) && (req.reader !== 'custom' || (custom() !== '' && custom().length <= MAX_READER_CHARS)),
      build: async () => ({
        kind: 'readers',
        system: buildReadersSystem(req.mode, await dialectItem.getValue(), req.reader),
        user: buildReadersUser(req.text, req.reader, custom()),
        schema: READERS_JSON_SCHEMA,
      }),
    });
    if (status !== 'ok') return { status };
    const reaction = cleanReaders(data, { text: req.text, mode: req.mode });
    return reaction ? { status: 'ok', reaction } : { status: 'bad_response' };
  }

  async function grade(req: GradeRequest, sender: ReviewSender): Promise<GradeResponse> {
    const rubric = () => (typeof req.rubric === 'string' ? req.rubric.trim() : '');
    const { status, data } = await runReview(req, sender, {
      valid: () => rubric() !== '' && rubric().length <= MAX_RUBRIC_CHARS,
      build: async () => ({
        kind: 'grader',
        system: buildGraderSystem(req.mode, await dialectItem.getValue()),
        user: buildGraderUser(req.text, rubric()),
        schema: GRADER_JSON_SCHEMA,
      }),
    });
    if (status !== 'ok') return { status };
    const grading = cleanGrading(data, rubric(), req.text, req.mode);
    return grading ? { status: 'ok', grading } : { status: 'bad_response' };
  }

  async function deepCheck(req: ReviewBase, sender: ReviewSender): Promise<DeepCheckResponse> {
    const { status, data } = await runReview(req, sender, {
      build: async () => ({
        kind: 'deepCheck',
        system: buildDeepCheckSystem(req.mode, await dialectItem.getValue(), { dictionary: await dictionaryItem.getValue() }),
        user: buildDeepCheckUser(req.text),
        schema: DEEP_CHECK_JSON_SCHEMA,
      }),
    });
    if (status !== 'ok') return { status };
    let parsed: ReturnType<typeof parseDeepCheckOutput>;
    try {
      parsed = parseDeepCheckOutput(data, { text: req.text, mode: req.mode });
    } catch {
      return { status: 'bad_response' };
    }
    const policy = await readPolicy(req.mode);
    const byId = new Map<string, RawIssue[]>();
    for (const r of parsed.output.results) byId.set(r.paragraph_id, [...(byId.get(r.paragraph_id) ?? []), ...r.issues]);
    const issues: LocatedIssue[] = splitParagraphs(req.text).flatMap((p) => selectIssues(p, byId.get(p.id) ?? [], policy));
    return { status: 'ok', issues, notes: parsed.output.notes };
  }

  /**
   * Sources for a claim, from Sonnet with web search: the same sender, site, key and cap gates as the reviews.
   * Only URLs the search returned are ever kept (sourcesFromResponse). Every billed answer is recorded, a
   * truncated, paused or refused one included, and so is a search stream that broke after it started (as far as
   * it showed); a refused one shows nothing and says so (`refused`).
   */
  async function citations(req: CitationsRequest, sender: ReviewSender): Promise<CitationsResponse> {
    const claim = () => (typeof req.claim === 'string' ? req.claim.trim() : '');
    const context = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_CLAIM_CONTEXT_CHARS;
    const valid = () => claim().length >= MIN_CLAIM_CHARS && claim().length <= MAX_CLAIM_CHARS && context(req.before) && context(req.after);
    const stopped = await senderAndSite(req.tabId, sender, valid);
    if (stopped) return { status: stopped };
    // Web search is Claude's: nothing else is read, built or sent for another provider.
    const provider = await readProvider(deps);
    if (!supportsWebSearch(provider)) return { status: 'bad_response' };
    const gate = await keyAndCap(provider);
    if ('status' in gate) return gate;

    const search = gate.client.citations;
    if (!search) return { status: 'bad_response', searchOff: true };
    const settled = await settle(search.start({ system: buildCitationsSystem(), user: buildCitationsUser(claim(), req.before, req.after) }), gate.client.prices);
    if ('err' in settled) {
      if (isSearchOff(settled.err)) return { status: 'bad_response', searchOff: true };
      return { status: statusFromError(settled.err) };
    }
    const { out } = settled;
    if (out.stopReason === 'refusal') return { status: 'bad_response', refused: true };
    return { status: 'ok', sources: sourcesFromResponse(out.content) };
  }

  return { tone, readers, grade, deepCheck, citations };
}

export type ReviewService = ReturnType<typeof createReviewService>;
