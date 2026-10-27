/** The site toggle works on exact hostnames (lowercased); parents and siblings are never affected. */
export function isSiteDisabled(disabled: string[], host: string): boolean {
  const h = host.toLowerCase();
  return disabled.some((d) => d.toLowerCase() === h);
}

export function toggleSite(disabled: string[], host: string, enabled: boolean): string[] {
  const h = host.toLowerCase();
  const rest = disabled.filter((d) => d.toLowerCase() !== h);
  return enabled ? rest : [...rest, h];
}

/**
 * A page or frame is off when its own host is switched off, or when the tab's top-level host is: switching a
 * site off covers the widgets it embeds from other hosts. Without a known top-level host, only its own counts.
 */
export function isPageDisabled(disabled: string[], host: string, topHost?: string | null): boolean {
  return isSiteDisabled(disabled, host) || (!!topHost && isSiteDisabled(disabled, topHost));
}

/** The hostname of an http(s) URL; null for anything else (no URL, chrome://, file://, about:blank). */
export function webHost(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/** A URL on this extension's own origin (its options, popup and panel pages, its worker), never a web page. */
export function isExtensionPage(senderUrl: string | undefined, extensionOrigin: string): boolean {
  try {
    // Scheme and host, not `origin`: URL gives "null" as the origin of every non-web scheme outside Chrome.
    const url = new URL(senderUrl ?? '');
    const own = new URL(extensionOrigin);
    return own.host !== '' && url.protocol === own.protocol && url.host === own.host;
  } catch {
    return false;
  }
}
