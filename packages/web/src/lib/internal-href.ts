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
