import { normalizeProvider, permissionPattern, type CompatibleConfig, type ProviderConfig } from '../core/provider';
import { providerItem } from '../shared/settings';

/** What a service reads about the provider; tests replace both. */
export interface ProviderDeps {
  /** The saved provider settings (default: the stored ones). */
  getProvider?(): Promise<ProviderConfig>;
  /** Whether Chrome lets EngLint reach the match `pattern` (default: the permission the writer granted on the Options page). */
  canReach?(pattern: string): Promise<boolean>;
}

/** The saved provider settings, checked (normalizeProvider): a tampered or unknown value reads as the default, Claude. */
export const readProvider = async (deps: ProviderDeps): Promise<ProviderConfig> => normalizeProvider(await (deps.getProvider ?? (() => providerItem.getValue()))());

/**
 * Whether a call must stop because Chrome hasn't given access to the provider's endpoint (the writer removed it,
 * or never granted it). Claude's host is a required permission: no check. Settings it doesn't know are always blocked.
 */
export async function endpointBlocked(deps: ProviderDeps, c: ProviderConfig): Promise<boolean> {
  if (c.active === 'anthropic') return false;
  if (c.active === 'compatible' && c.compatible) return compatibleBlocked(deps, c.compatible);
  return true;
}

/**
 * The same for one compatible endpoint, saved or not (the Options page lists a preset's models before it is saved).
 * The pattern is permissionPattern's, the one the Options page asks Chrome for: it follows endpointOf, so a fixed
 * preset's stored address (which could be edited in storage) never decides where access is checked or a key goes.
 * An address validateBaseURL refuses is always blocked.
 */
export async function compatibleBlocked(deps: ProviderDeps, c: Pick<CompatibleConfig, 'preset' | 'baseURL'>): Promise<boolean> {
  const pattern = permissionPattern(c);
  if (!pattern) return true;
  const canReach = deps.canReach ?? ((p: string) => browser.permissions.contains({ origins: [p] }));
  return !(await canReach(pattern));
}
