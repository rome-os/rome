/**
 * Whether an href addresses this dashboard rather than somewhere else.
 *
 * Server-authored payloads mix the two freely — a setup view can point at
 * `https://t.me/BotFather` and at `/desktop` in the same list — so the renderer
 * has to tell them apart before deciding how to open one.
 */
export function isInternalHref(href: string | undefined): href is string {
  if (!href) return false;
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  if (href.startsWith("#") || href.startsWith("?")) return true;
  if (typeof window !== "undefined") {
    try {
      const url = new URL(href, window.location.href);
      return url.origin === window.location.origin;
    } catch {
      return false;
    }
  }
  return false;
}

/** The router path for an href `isInternalHref` accepted. */
export function toInternalPath(href: string): string {
  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return href;
  try {
    const url = new URL(href, window.location.href);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

/**
 * The raw path, query and hash of an href `isInternalHref` accepted, without
 * the canonicalization `new URL().pathname` applies. A leading `/`, `#` or `?`
 * href is already just that; an absolute same-origin URL has its scheme and
 * authority sliced off verbatim. A schemeless relative href has no such path
 * and gives null.
 */
export function getInternalRawPath(href: string): string | null {
  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return href;
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(href);
  return authority ? href.slice(authority[0].length) || "/" : null;
}
