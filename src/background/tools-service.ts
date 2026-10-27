import { MAX_VOICE_SAMPLE_CHARS } from '../core/context';
import { costFromUsage } from '../core/cost';
import { keyNeeded, type ProviderConfig } from '../core/provider';
import { MAX_ECHO_CHARS, MAX_FOLLOW_UPS, MAX_QUESTION_CHARS } from '../core/follow-up';
import { MAX_FOCUS_REASON, isVoice, presetsFor, type ToolRequest } from '../core/presets';
import { hashText } from '../core/paragraphs';
import { isPageDisabled, isExtensionPage } from '../core/sites';
import { MAX_PROFILE_SOURCE_CHARS, MIN_PROFILE_SOURCE_CHARS } from '../core/style-profile';
import {
  CRITIQUE_JSON_SCHEMA,
  FOLLOW_UP_JSON_SCHEMA,
  STYLE_PROFILE_JSON_SCHEMA,
  SYNONYMS_JSON_SCHEMA,
  VARIANTS_JSON_SCHEMA,
  VOICE_JSON_SCHEMA,
  cleanCritique,
  cleanFollowUp,
  cleanStyleProfile,
  cleanSynonyms,
  cleanVariants,
  cleanVoice,
} from '../core/tool-schema';
import type { CheckStatus, Mode } from '../core/types';
import type {
  FollowUpRequest,
  FollowUpResponse,
  RewriteRequest,
  RewriteResponse,
  StyleProfileRequest,
  StyleProfileResponse,
  SynonymsRequest,
  SynonymsResponse,
} from '../shared/messages';
import { dialectItem, disabledSitesItem, styleProfileItem } from '../shared/settings';
import { REWRITE_MODEL, SYNONYMS_MODEL, type ToolCall, type ToolResult } from './claude';
import { statusFromError } from './errors';
import { endpointBlocked, readProvider, type ProviderDeps } from './provider-gate';
import type { LlmClient } from './llm';
import { buildFollowUpSystem, buildFollowUpUser } from './prompts/follow-up';
import { buildStyleProfileSystem, buildStyleProfileUser } from './prompts/style-profile';
import { buildRewriteSystem, buildRewriteUser } from './prompts/rewrite';
import { buildSynonymsSystem, buildSynonymsUser } from './prompts/synonyms';
import { isOverCap, recordSpend } from './usage';

export { REWRITE_MODEL, SYNONYMS_MODEL };

/** Backstop limits (the content side limits too): the selection, and the context each side. */
export const MAX_SELECTION_CHARS = 2000;
export const MAX_CONTEXT_CHARS = 300;
/** Backstop for a note's focus: its label (the content side sends a kind's short label) and reason. */
export const MAX_FOCUS_LABEL_CHARS = 100;

const SYNONYM_CACHE_MAX = 200;

/** Whether a rewrite's selection, context or note focus is over its limit (or the selection is blank). */
function overLimits(req: { text: string; before: string; after: string; request: ToolRequest }): boolean {
  if (req.text.trim() === '' || req.text.length > MAX_SELECTION_CHARS) return true;
  if (req.before.length > MAX_CONTEXT_CHARS || req.after.length > MAX_CONTEXT_CHARS) return true;
  const focus = req.request.kind === 'preset' ? req.request.focus : undefined;
  return !!focus && (focus.label.length > MAX_FOCUS_LABEL_CHARS || focus.reason.length > MAX_FOCUS_REASON);
}

/** Whether the request's mode offers its preset (Expand isn't offered on Essay sites); a custom request always is. */
function offered(req: { mode: Mode; request: ToolRequest }): boolean {
  const { request } = req;
  return request.kind !== 'preset' || presetsFor(req.mode).some((p) => p.id === request.presetId);
}

export interface ToolsServiceDeps extends ProviderDeps {
  /**
   * The key a call on `provider` (the settings the call read, once) may carry: its slot's, and a Custom key only for
   * the address it was saved for; null when there is none.
   */
  getApiKey(provider: ProviderConfig): Promise<string | null>;
  /** The client for `provider`, the settings the call read once; `key` is null only for a provider that needs none. */
  makeClient(provider: ProviderConfig, key: string | null): LlmClient | Promise<LlmClient>;
  now(): Date;
  /** This extension's origin (`chrome-extension://<id>/`): only its own pages may build a style profile. */
  extensionOrigin: string;
}
export interface ToolsContext {
  /** The sender tab's top-level host (from `sender.tab.url`, never from the page). */
  topHost?: string | null;
}

export function createToolsService(deps: ToolsServiceDeps) {
  // In-memory only; a service-worker restart forgets it.
  const synonymCache = new Map<string, NonNullable<SynonymsResponse['options']>>();

  /**
   * The key and cap gates, the call, and spend. The provider settings are read once, and the key, the permission and
   * the client follow that read. Returns the parsed JSON, or the status that stopped it.
   */
  async function call(toolCall: ToolCall): Promise<{ status: CheckStatus; data?: unknown }> {
    const provider = await readProvider(deps);
    const key = await deps.getApiKey(provider);
    if (!key && keyNeeded(provider)) return { status: 'key_missing' };
    if (await isOverCap(deps.now())) return { status: 'paused_cap' };
    if (await endpointBlocked(deps, provider)) return { status: 'endpoint_blocked' };

    let out: ToolResult;
    let client: LlmClient;
    try {
      client = await deps.makeClient(provider, key);
      out = await client.startToolCall(toolCall).done;
    } catch (err) {
      return { status: statusFromError(err) };
    }
    // Truncated calls are billed too.
    await recordSpend(costFromUsage(out.model, out.usage, client.prices), deps.now());
    if (out.truncated || out.data === null) return { status: 'bad_response' };
    return { status: 'ok', data: out.data };
  }

  /** The site gate, then `call`. */
  async function run(host: string, topHost: string | null | undefined, toolCall: ToolCall): Promise<{ status: CheckStatus; data?: unknown }> {
    if (isPageDisabled(await disabledSitesItem.getValue(), host, topHost)) return { status: 'off_site' };
    return call(toolCall);
  }

  /** The profile text the writer saved, or null: read at each call, so a deleted profile is left out of the next one. */
  async function profileText(): Promise<string | null> {
    return (await styleProfileItem.getValue())?.text || null;
  }

  async function rewrite(req: RewriteRequest, ctx: ToolsContext = {}): Promise<RewriteResponse> {
    if (overLimits(req) || !offered(req)) return { status: 'bad_response' };
    const { voiceSample } = req;
    if (voiceSample !== undefined && (typeof voiceSample !== 'string' || voiceSample.length > MAX_VOICE_SAMPLE_CHARS)) return { status: 'bad_response' };
    const dialect = await dialectItem.getValue();
    const profile = await profileText();
    const voice = isVoice(req.request);
    const { status, data } = await run(req.host, ctx.topHost, {
      kind: 'rewrite',
      system: buildRewriteSystem(req.mode, dialect, profile),
      // The profile describes the writer better than a few paragraphs: with one, the sample isn't sent.
      user: buildRewriteUser({ ...req, voiceSample: profile ? undefined : voiceSample }),
      schema: req.stage === 'critique' ? CRITIQUE_JSON_SCHEMA : voice ? VOICE_JSON_SCHEMA : VARIANTS_JSON_SCHEMA,
    });
    if (status !== 'ok') return { status };
    if (req.stage === 'critique') {
      const critique = cleanCritique(data);
      return critique ? { status: 'ok', critique } : { status: 'bad_response' };
    }
    if (voice) {
      const answer = cleanVoice(data, req.text);
      return answer ? { status: 'ok', variants: [answer.final], tells: answer.tells } : { status: 'bad_response' };
    }
    const variants = cleanVariants(data, req.text);
    return variants ? { status: 'ok', variants } : { status: 'bad_response' };
  }

  async function synonyms(req: SynonymsRequest, ctx: ToolsContext = {}): Promise<SynonymsResponse> {
    if (req.target.trim() === '' || req.target.length > MAX_SELECTION_CHARS) return { status: 'bad_response' };
    // The sentence is the target and its context: at most MAX_CONTEXT_CHARS each side.
    if (req.sentence.length > req.target.length + 2 * MAX_CONTEXT_CHARS) return { status: 'bad_response' };
    const dialect = await dialectItem.getValue();
    const profile = await profileText();
    const cacheKey = JSON.stringify([req.mode, dialect, req.target, req.sentence, req.targetStart, profile ? hashText(profile) : '']);
    const hit = synonymCache.get(cacheKey);
    if (hit && !isPageDisabled(await disabledSitesItem.getValue(), req.host, ctx.topHost)) {
      return { status: 'ok', options: hit };
    }
    const { status, data } = await run(req.host, ctx.topHost, {
      kind: 'synonyms',
      system: buildSynonymsSystem(req.mode, dialect, profile),
      user: buildSynonymsUser(req),
      schema: SYNONYMS_JSON_SCHEMA,
    });
    if (status !== 'ok') return { status };
    const options = cleanSynonyms(data, req.target);
    if (!options) return { status: 'bad_response' };
    if (synonymCache.size >= SYNONYM_CACHE_MAX) synonymCache.delete(synonymCache.keys().next().value!);
    synonymCache.set(cacheKey, options);
    return { status: 'ok', options };
  }

  /** A question about a shown result: the same context as the rewrite, the shown results and earlier follow-ups. */
  async function followUp(req: FollowUpRequest, ctx: ToolsContext = {}): Promise<FollowUpResponse> {
    if (overLimits(req) || !offered(req)) return { status: 'bad_response' };
    if (req.question.trim() === '' || req.question.length > MAX_QUESTION_CHARS) return { status: 'bad_response' };
    // A popover has at most MAX_FOLLOW_UPS follow-ups, so the last one carries MAX_FOLLOW_UPS - 1 earlier ones.
    if (req.shown.length > MAX_ECHO_CHARS || req.history.length >= MAX_FOLLOW_UPS) return { status: 'bad_response' };
    if (req.history.some((h) => h.q.length > MAX_QUESTION_CHARS || h.a.length > MAX_ECHO_CHARS)) return { status: 'bad_response' };
    const dialect = await dialectItem.getValue();
    const profile = await profileText();
    const { status, data } = await run(req.host, ctx.topHost, {
      kind: 'followUp',
      system: buildFollowUpSystem(req.mode, dialect, profile),
      user: buildFollowUpUser(req),
      schema: FOLLOW_UP_JSON_SCHEMA,
    });
    if (status !== 'ok') return { status };
    const answer = cleanFollowUp(data, req.text, req.mode);
    return answer ? { status: 'ok', ...answer } : { status: 'bad_response' };
  }

  /**
   * A style profile described from the pieces the writer pasted. Answers only an extension page; nothing is stored
   * here (the options page saves the profile when the writer does), and the pieces are sent once, as data.
   */
  async function buildStyleProfile(req: StyleProfileRequest, sender: { url?: string }): Promise<StyleProfileResponse> {
    if (!isExtensionPage(sender.url, deps.extensionOrigin)) return { status: 'bad_response' };
    const { samples } = req;
    if (typeof samples !== 'string' || samples.trim().length < MIN_PROFILE_SOURCE_CHARS || samples.length > MAX_PROFILE_SOURCE_CHARS) {
      return { status: 'bad_response' };
    }
    const { status, data } = await call({
      kind: 'styleProfile',
      system: buildStyleProfileSystem(),
      user: buildStyleProfileUser(samples),
      schema: STYLE_PROFILE_JSON_SCHEMA,
    });
    if (status !== 'ok') return { status };
    const profile = cleanStyleProfile(data);
    return profile ? { status: 'ok', profile } : { status: 'bad_response' };
  }

  return { rewrite, synonyms, followUp, buildStyleProfile };
}

export type ToolsService = ReturnType<typeof createToolsService>;
