// Per-route social card for the SPA shell. Pure string work: the caller
// decides whether a request maps to an app (api/app-social-card.ts) and
// whether the response reaches a browser (Caddy proxies /apps/* documents to
// Hono precisely so this replacement is visible outside the container).

export const DEFAULT_SOCIAL_IMAGE_URL = "https://romeos.cc/public-og-20260825.jpg";

const START_MARKER = "<!-- rome:social:start -->";
const END_MARKER = "<!-- rome:social:end -->";
const TITLE_RE = /<title>[^<]*<\/title>/;

export interface SocialCard {
  title: string;
  description: string;
  /** Absolute URL of the page being shared. */
  url: string;
  /** Absolute URL of a 1200x630 image. */
  imageUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function socialTags(card: SocialCard): string {
  const t = escapeHtml(card.title);
  const d = escapeHtml(card.description);
  const u = escapeHtml(card.url);
  const i = escapeHtml(card.imageUrl);
  // One tag per line, never wrapped: Rsbuild drops multi-line <meta> tags.
  return [
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Rome" />',
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:image" content="${i}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${i}" />`,
  ]
    .map((line) => `    ${line}`)
    .join("\n");
}

/**
 * Swap the shell's `<title>` and the marked social block for `card`. Returns
 * the input unchanged when there is no card or the markers are absent, so a
 * shell built without them still serves.
 */
export function renderSocialMeta(indexHtml: string, card: SocialCard | null): string {
  if (card === null) return indexHtml;
  const start = indexHtml.indexOf(START_MARKER);
  const end = indexHtml.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) return indexHtml;

  const before = indexHtml.slice(0, start + START_MARKER.length);
  const after = indexHtml.slice(end);
  const withBlock = `${before}\n${socialTags(card)}\n    ${after}`;
  return withBlock.replace(TITLE_RE, () => `<title>${escapeHtml(card.title)}</title>`);
}
