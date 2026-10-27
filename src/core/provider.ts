import { isPriced } from './cost';

export type ProviderId = 'anthropic' | 'compatible';
export type PresetId = 'openai' | 'gemini' | 'openrouter' | 'groq' | 'ollama' | 'lmstudio' | 'custom';

/** The OpenAI-compatible providers the Options page offers. `custom` has no address of its own: the writer types it. */
export const PRESETS: Record<PresetId, { label: string; baseURL: string; structuredOutputs: boolean; needsKey: boolean }> = {
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', structuredOutputs: true, needsKey: true },
  gemini: { label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', structuredOutputs: true, needsKey: true },
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', structuredOutputs: false, needsKey: true },
  groq: { label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', structuredOutputs: false, needsKey: true },
  ollama: { label: 'Ollama (on this computer)', baseURL: 'http://localhost:11434/v1', structuredOutputs: false, needsKey: false },
  lmstudio: { label: 'LM Studio (on this computer)', baseURL: 'http://localhost:1234/v1', structuredOutputs: false, needsKey: false },
  custom: { label: 'Custom endpoint', baseURL: '', structuredOutputs: false, needsKey: true },
};

export interface CompatibleConfig {
  preset: PresetId;
  baseURL: string;
  /** Live checks, synonyms and tone. */
  fastModel: string;
  /** Everything heavier: rewrites, reviews, chat. */
  smartModel: string;
  structuredOutputs: boolean;
  /** USD per 1M tokens, by model id: what the writer typed from the provider's pricing page. */
  prices: Record<string, { input: number; output: number }>;
}

/** The address calls go to: a fixed preset's own, never the stored one; only a custom endpoint uses what the writer typed. */
export function endpointOf(c: Pick<CompatibleConfig, 'preset' | 'baseURL'>): string {
  return (c.preset === 'custom' ? c.baseURL : PRESETS[c.preset].baseURL).trim();
}

export interface ProviderConfig {
  active: ProviderId;
  compatible: CompatibleConfig | null;
}

export const DEFAULT_PROVIDER: ProviderConfig = { active: 'anthropic', compatible: null };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPrice = (v: unknown): v is { input: number; output: number } =>
  isObject(v) && [v.input, v.output].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);

/** Compatible settings as saved by the Options page, field for field, or null for anything else. */
function normalizeCompatible(raw: unknown): CompatibleConfig | null {
  if (!isObject(raw)) return null;
  const { preset, baseURL, fastModel, smartModel, structuredOutputs, prices } = raw;
  if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) return null;
  if (typeof baseURL !== 'string' || typeof fastModel !== 'string' || typeof smartModel !== 'string') return null;
  if (typeof structuredOutputs !== 'boolean' || !isObject(prices) || !Object.values(prices).every(isPrice)) return null;
  return {
    preset: preset as PresetId,
    baseURL,
    fastModel,
    smartModel,
    structuredOutputs,
    prices: Object.fromEntries(Object.entries(prices).map(([m, p]) => [m, { input: (p as { input: number }).input, output: (p as { output: number }).output }])),
  };
}

/**
 * The stored provider settings as the background may use them (chrome.storage can hold anything): `active` one of
 * the two providers, and compatible settings whole or dropped. Dropped compatible settings leave Claude active;
 * anything else unusable is the default, Claude.
 */
export function normalizeProvider(raw: unknown): ProviderConfig {
  if (!isObject(raw) || (raw.active !== 'anthropic' && raw.active !== 'compatible')) return DEFAULT_PROVIDER;
  const compatible = normalizeCompatible(raw.compatible);
  return { active: raw.active === 'compatible' && compatible ? 'compatible' : 'anthropic', compatible };
}

/** Where a key is kept: one per provider, so switching providers never loses a key. */
export type KeySlot = 'anthropic' | `compatible:${PresetId}`;

/** The slot whose key the active provider's calls carry; null for settings it doesn't know (they reach no key). */
export function activeSlot(c: ProviderConfig): KeySlot | null {
  if (c.active === 'anthropic') return 'anthropic';
  if (c.active === 'compatible' && c.compatible) return `compatible:${c.compatible.preset}`;
  return null;
}

/**
 * Whether the API offers server-side web search (the Citation finder needs it). Anthropic's Messages API does;
 * the panel hides the Citation finder otherwise.
 */
export function supportsWebSearch(c: ProviderConfig): boolean {
  return c.active === 'anthropic';
}

/**
 * The provider as the writer knows it, for copy: 'Claude', the preset's label without its bracketed part ("Ollama",
 * not "Ollama (on this computer)": the select keeps the full label), or a custom endpoint's host.
 */
export function providerName(c: ProviderConfig): string {
  if (c.active === 'anthropic' || !c.compatible) return 'Claude';
  if (c.compatible.preset !== 'custom') return PRESETS[c.compatible.preset].label.replace(/ \(.*\)$/, '');
  try {
    return new URL(c.compatible.baseURL).host || PRESETS.custom.label;
  } catch {
    return PRESETS.custom.label;
  }
}

/** The provider as status copy needs it: its name, and whether it takes no key (a server on this computer). */
export interface ProviderInfo {
  name: string;
  keyless: boolean;
}

export const CLAUDE_INFO: ProviderInfo = { name: 'Claude', keyless: false };

export function providerInfo(c: ProviderConfig): ProviderInfo {
  return { name: providerName(c), keyless: !keyNeeded(c) };
}

// http is allowed only where the manifest's optional host permissions can grant it: no [::1], which Chrome would
// never be asked to allow.
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

/** https, or http for this computer only: a key is never sent in the clear over a network. */
export function validateBaseURL(url: string): { ok: true; origin: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'Enter a full web address, like https://api.example.com/v1.' };
  }
  if (u.username || u.password) return { ok: false, reason: 'Remove the user name and password from the address.' };
  // Calls append their path to the address as typed: after a ? or # it would land in the query or the fragment.
  if (/[?#]/.test(url)) return { ok: false, reason: 'Remove the ? or # part of the address.' };
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return { ok: true, origin: u.origin };
  return { ok: false, reason: 'Use an https address (http is allowed only for this computer).' };
}

/**
 * The match pattern Chrome grants for the endpoint: its origin (port included), any path. The Options page asks for
 * this pattern on Save and the background checks it before each call, so the two can't drift apart. null for an
 * address validateBaseURL refuses.
 */
export function permissionPattern(c: Pick<CompatibleConfig, 'preset' | 'baseURL'>): string | null {
  const checked = validateBaseURL(endpointOf(c));
  return checked.ok ? `${checked.origin}/*` : null;
}

/** Whether a call needs a saved key: Anthropic and the keyed presets do, a local server (Ollama, LM Studio) doesn't. */
export function keyNeeded(c: ProviderConfig): boolean {
  return c.active === 'compatible' && c.compatible ? PRESETS[c.compatible.preset].needsKey : true;
}

/** Whether the active provider can make calls: a compatible one needs an address (endpointOf's) and both models. */
export function isUsable(c: ProviderConfig): boolean {
  if (c.active === 'anthropic') return true;
  if (c.active !== 'compatible') return false;
  const k = c.compatible;
  return !!k && endpointOf(k) !== '' && k.fastModel.trim() !== '' && k.smartModel.trim() !== '';
}

/** Whether the spending meter means anything: Claude's prices are built in; another provider's two models need the writer's. */
export function spendTracked(c: ProviderConfig): boolean {
  const k = c.active === 'compatible' ? c.compatible : null;
  return !k || (isPriced(k.fastModel, k.prices) && isPriced(k.smartModel, k.prices));
}
