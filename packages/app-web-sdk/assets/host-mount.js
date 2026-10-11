// The dashboard page host's CSS handling, which `rome run` serves to its page.
// It matches `scopeAppCss` and the page-canvas shell in
// packages/web/src/components/rome-app-host.tsx; rome-app-host.test.ts fails
// when the two disagree.

const isAbsolute = (url) =>
  url.startsWith("/") ||
  url.startsWith("#") ||
  url.startsWith("data:") ||
  url.startsWith("http:") ||
  url.startsWith("https:") ||
  url.startsWith("//");

/** Resolve the app CSS's relative `@import` and `url()` targets against its own
 *  URL, and scope `:root` to the shadow host. */
export function scopeAppCss(cssText, sourceUrl) {
  return cssText
    .replace(
      /@import\s+(url\()?\s*(['"]?)([^'")\s]+)\2\s*\)?/g,
      (match, urlPrefix, _quote, rawUrl) => {
        if (isAbsolute(rawUrl)) return match;
        const resolvedUrl = new URL(rawUrl, sourceUrl).toString();
        return urlPrefix ? `@import url("${resolvedUrl}")` : `@import "${resolvedUrl}"`;
      },
    )
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _quote, rawUrl) =>
      isAbsolute(rawUrl) ? match : `url("${new URL(rawUrl, sourceUrl).toString()}")`,
    )
    .replaceAll(":root", ":host");
}

/** The shadow root's first style for a page mount: the app canvas alias. */
export const PAGE_SHELL_CSS =
  ":host { --background: var(--app-canvas); background-color: var(--background); display: block; min-height: inherit; }";
