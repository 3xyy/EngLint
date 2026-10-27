import type { FamilyToggles, Mode } from './types';

export const ESSAY_SITES_DEFAULT = ['docs.google.com', 'commonapp.org'];
export const CASUAL_SITES = ['discord.com', 'web.whatsapp.com', 'messenger.com'];

/** True when `host` is `domain` or a subdomain of it (case-insensitive). */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith('.' + d);
}

export function effectiveMode(
  host: string,
  siteModes: Record<string, Mode>,
  essaySites: string[],
): Mode {
  const explicit = siteModes[host];
  if (explicit) return explicit;
  if (essaySites.some((d) => hostMatches(host, d))) return 'essay';
  if (CASUAL_SITES.some((d) => hostMatches(host, d))) return 'casual';
  return 'standard';
}

/*
 * Default suggestion families, set by the suggestion eval. A toggle whose precision with the
 * defaults is under 0.9 starts off; the user can turn it on. Clarity is the exception: it is on in both modes by
 * choice, though the latest run measured it just under the bar. Since lc-6 the request always asks
 * for every family the mode allows, so these only filter on the client.
 * Essay (lc-6, latest run): clarity 0.895 on by choice; engagement 0.957 and delivery 1.00 on; generic off (0.84 under lc-5).
 * Standard (lc-6, latest run): clarity 0.875 on by choice; engagement off (0.88); delivery off (0.89 under lc-5); generic off.
 * A clarityByMode the writer saved still sets Clarity per mode: migrateFamilies copies it over this value.
 */
export const ESSAY_FAMILY_DEFAULTS: FamilyToggles = { clarity: true, engagement: true, delivery: true, generic: false };
export const STANDARD_FAMILY_DEFAULTS: FamilyToggles = { clarity: true, engagement: false, delivery: false, generic: false };

export function defaultFamilies(mode: Mode): FamilyToggles {
  if (mode === 'casual') return { clarity: false, engagement: false, delivery: false, generic: false };
  if (mode === 'essay') return { ...ESSAY_FAMILY_DEFAULTS };
  return { ...STANDARD_FAMILY_DEFAULTS };
}

/** Clarity takes the old per-mode toggle (Essay and Standard); the rest take the defaults. Casual is always off. */
export function migrateFamilies(clarityByMode: Record<Mode, boolean> | null): Record<Mode, FamilyToggles> {
  const out = { essay: defaultFamilies('essay'), standard: defaultFamilies('standard'), casual: defaultFamilies('casual') };
  if (clarityByMode) {
    out.essay.clarity = clarityByMode.essay;
    out.standard.clarity = clarityByMode.standard;
  }
  return out;
}
