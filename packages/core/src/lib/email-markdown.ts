// Email body conversion. Channel contract: docs/architecture/channels.md.
// The value beyond the conversion libraries is the email-specific
// cleaning: invisible/tracking-filler stripping, tracking pixel/URL removal,
// entity decoding, whitespace folding, and readability extraction for big
// bodies.
//
// Direction:
//   inbound  HTML/text → Markdown   (Turndown + @mozilla/readability + cleaning)
//   outbound Markdown   → HTML      (marked + juice; CSS inlined for Gmail etc.)
//   outbound app HTML   → sanitized (DOMPurify; drops scripts/handlers/etc.)

import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import juice from "juice";
import { marked, type Tokens } from "marked";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { RomeMailBody } from "./rome-cloud-mail.js";

// Strip zero-width / invisible / format chars commonly used as filler in
// marketing emails to defeat preview snippets:
//   U+00AD   SOFT HYPHEN (invisible between letters)
//   U+034F   COMBINING GRAPHEME JOINER
//   U+061C   ARABIC LETTER MARK
//   U+180E   MONGOLIAN VOWEL SEPARATOR
//   U+200B–F ZWSP / ZWNJ / ZWJ / LRM / RLM
//   U+2028–F line/paragraph/bidi separators
//   U+2060–F medium math space, word joiner, invisible operators
//   U+3164   HANGUL FILLER
//   U+FEFF   BOM / zero-width no-break space
//   U+FFF9–B interlinear annotation anchors
const INVISIBLE_CHARS =
  /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFF9-\uFFFB]/g;

// Unicode horizontal whitespace beyond ASCII space/tab. Includes NBSP (U+00A0),
// OGHAM SPACE MARK (U+1680), en/em/figure/etc. spaces (U+2000-U+200A),
// NARROW NO-BREAK SPACE (U+202F), MEDIUM MATH SPACE (U+205F), and IDEOGRAPHIC
// SPACE (U+3000). Normalized to a regular space, then collapsed.
const UNICODE_HORIZONTAL_WS = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

// Many email bodies are HTML fragments without <html>/<body> wrappers. Treat
// anything with a few real tags as HTML.
const HTML_TAG = /<[a-z][a-z0-9]*[\s/>]/gi;
export function isHtml(t: string): boolean {
  if (!t) return false;
  let count = 0;
  HTML_TAG.lastIndex = 0;
  while (HTML_TAG.exec(t)) if (++count >= 3) return true;
  return false;
}

// Below this threshold, emails are typically transactional (receipts, alerts)
// where the legal disclaimer is often longer than the actual notification.
// Readability tends to latch onto the disclaimer, so skip it entirely.
const READABILITY_MIN_HTML_BYTES = 15000;

let turndownWithLinks: TurndownService | null = null;
let turndownNoLinks: TurndownService | null = null;

function buildTurndown(includeLinks: boolean): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.remove(["script", "style", "noscript", "iframe"]);
  // Override turndown's default image rule (which would emit `![]()`) — emails
  // are full of tracking pixels and brand logos that just waste tokens.
  td.addRule("strip-images", { filter: "img", replacement: () => "" });
  if (!includeLinks) {
    // Replace <a> with its text content; drops tracking URLs (~30%+ of newsletter tokens).
    td.addRule("strip-link-urls", { filter: "a", replacement: (content) => content });
  }
  return td;
}

function turndownFor(includeLinks: boolean): TurndownService {
  if (includeLinks) return (turndownWithLinks ??= buildTurndown(true));
  return (turndownNoLinks ??= buildTurndown(false));
}

function postProcessMarkdown(md: string): string {
  return (
    md
      .replace(INVISIBLE_CHARS, "")
      .replace(UNICODE_HORIZONTAL_WS, " ")
      // Collapse runs of 2+ spaces to a single space — after stripping invisible
      // filler and normalizing NBSPs, runs of 50+ spaces are common. Emails almost
      // never rely on markdown's trailing-2-space hard break or 4-space code blocks.
      .replace(/ {2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function htmlToMarkdown(html: string, includeLinks = false): string {
  if (!html) return "";
  const td = turndownFor(includeLinks);
  const fullMd = td.turndown(html);
  if (html.length < READABILITY_MIN_HTML_BYTES) return postProcessMarkdown(fullMd);
  try {
    const dom = new JSDOM(html, { url: "https://mail.example/" });
    const article = new Readability(dom.window.document).parse();
    if (article && article.content) {
      const readMd = td.turndown(article.content);
      // Reject extractions tiny relative to the full body — that's readability
      // locking onto a footer/disclaimer instead of the article.
      if (readMd.length >= 1500 && readMd.length >= fullMd.length * 0.4) {
        return postProcessMarkdown(readMd);
      }
    }
  } catch {
    // fall through to fullMd
  }
  return postProcessMarkdown(fullMd);
}

export function cleanPlainText(text: string, includeLinks = false): string {
  if (!text) return "";
  // Decode common HTML entities that survive when senders ship "plain text"
  // bodies that still contain HTML escapes (e.g. &zwnj;, &nbsp;, &amp;).
  let out = text
    .replace(/&zwnj;/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(INVISIBLE_CHARS, "");
  // Marketing emails embed dozens of long tracking URLs. When the caller asked
  // to drop links, strip bare URLs from plain text too (matches HTML behavior).
  if (!includeLinks) out = out.replace(/https?:\/\/\S+/g, "");
  return out
    .replace(UNICODE_HORIZONTAL_WS, " ")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Falls through markdown → HTML → text → stripped variants → preview so a message body is never empty. */
export function inboundBodyToMarkdown(body: RomeMailBody, preview?: string): string {
  if (body.markdown?.trim()) return body.markdown.trim();
  if (body.html?.trim()) {
    const md = htmlToMarkdown(body.html);
    if (md) return md;
  }
  if (body.text?.trim()) {
    const md = cleanPlainText(body.text);
    if (md) return md;
  }
  if (body.strippedHtml?.trim()) {
    const md = htmlToMarkdown(body.strippedHtml);
    if (md) return md;
  }
  if (body.strippedText?.trim()) {
    const md = cleanPlainText(body.strippedText);
    if (md) return md;
  }
  return (preview ?? "").trim();
}

// ── Outbound ───────────────────────────────────────────────────────────────

// Outbound email styling: Tailwind Typography's `prose` defaults (sizes,
// spacing, weights) rendered with Rome's own theme tokens for colour — the same
// pairing the dashboard uses for `.prose` (globals.css). Email clients don't
// support CSS variables, external classes, or the typography plugin, so the
// prose rules are written out as plain CSS and juice inlines them onto the
// elements (Gmail & friends strip <style> and only honour inline styles).
//
// Colours are the resolved values of Rome's DEFAULT theme — Ember, light mode —
// since an email has no theme/mode toggle. Source of truth: packages/web's
// src/lib/themes.ts (EMBER.light). If those tokens change, refresh the hex
// values here.
const ROME = {
  background: "#f4f3ef", // background  = sand-50
  foreground: "#1a130f", // foreground  = sand-900
  muted: "#8a7868", // muted-foreground = sand-500
  border: "#ece6de", // border       = sand-150
  surfaceMuted: "#efe9e1", // surface-muted = sand-100
  primary: "#d86f4c", // primary/links = ember-brand
} as const;

// The footer's Settings link when the instance has no public origin to send
// recipients to.
const ROME_SETTINGS_URL = "https://romeos.cc";

// Hosted logo PNGs (Gmail/Outlook render hosted PNG; they strip inline SVG and
// block data-URI). The header uses the white-background tile so it reads as an
// app-icon chip on the ember band; the footer uses the transparent glyph so it
// sits cleanly on the white footer.
const ROME_LOGO_TILE_URL = "https://romeos.cc/public-icon.png";
const ROME_LOGO_GLYPH_URL = "https://romeos.cc/public-transparent.png";

const OUTBOUND_BASE_CSS = `
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         font-size: 16px; line-height: 1.75; color: ${ROME.foreground}; margin: 0; }

  /* ── Branded shell ("accent-band" template) ──
     Full-width canvas → centered white card → ember top band (white "Rome"
     wordmark) → prose body → muted footer. Table-based for Outlook; juice
     inlines these class rules onto the elements. */
  .rome-bg { background: ${ROME.background}; padding: 24px 12px; }
  .rome-card { width: 600px; max-width: 100%; background: #ffffff;
               border: 1px solid ${ROME.border}; border-radius: 12px; overflow: hidden; }
  /* Round the band's own top corners (and the footer's bottom corners below) to
     match the card: table overflow:hidden doesn't clip children in many email
     clients, so the coloured band would otherwise poke a square corner past the
     card's rounded edge. 11px = card's 12px minus its 1px border. */
  .rome-band { background: ${ROME.primary}; padding: 16px 24px; color: #ffffff;
               font-size: 18px; font-weight: 700; letter-spacing: -0.01em;
               border-radius: 11px 11px 0 0; }
  /* White app-icon tile carrying the Rome glyph, sat on the ember band beside
     the wordmark. Explicit width/height (attr + style) so Outlook sizes it. */
  .rome-band-logo { width: 32px; height: 32px; border-radius: 7px;
                    background: #ffffff; vertical-align: middle; margin-right: 10px; }
  .rome-band-mark { vertical-align: middle; }
  /* Transparent glyph in the footer, small and muted so it stays quieter than
     the signature text. */
  .rome-footer-logo { width: 16px; height: 16px; vertical-align: middle;
                      margin-right: 8px; opacity: 0.55; }
  .rome-footer-text { vertical-align: middle; }
  /* Standalone sign-off appended under app-supplied HTML (no card to anchor to,
     so it's centered on the canvas rather than a bordered card row). */
  .rome-standalone-footer { padding: 24px 12px; color: ${ROME.muted};
                            font-size: 13px; line-height: 1.6; }
  .rome-standalone-footer a { color: ${ROME.muted}; text-decoration: underline; }
  .rome-body { padding: 28px 24px; }
  .rome-footer { padding: 16px 24px; border-top: 1px solid ${ROME.border};
                 color: ${ROME.muted}; font-size: 13px; border-radius: 0 0 11px 11px; }
  .rome-footer a { color: ${ROME.muted}; text-decoration: underline; }

  /* ── Body content: prose defaults with Rome's tokens ── */
  p { margin: 1.25em 0; }
  a { color: ${ROME.primary}; text-decoration: underline; font-weight: 500; }
  strong { color: ${ROME.foreground}; font-weight: 600; }
  em { font-style: italic; }
  h1 { color: ${ROME.foreground}; font-weight: 800; font-size: 2.25em;
       line-height: 1.1111; margin: 0 0 0.8888em; }
  h2 { color: ${ROME.foreground}; font-weight: 700; font-size: 1.5em;
       line-height: 1.3333; margin: 2em 0 1em; }
  h3 { color: ${ROME.foreground}; font-weight: 600; font-size: 1.25em;
       line-height: 1.6; margin: 1.6em 0 0.6em; }
  h4 { color: ${ROME.foreground}; font-weight: 600; line-height: 1.5; margin: 1.5em 0 0.5em; }
  ul, ol { margin: 1.25em 0; padding-left: 1.625em; }
  li { margin: 0.5em 0; }
  blockquote { margin: 1.6em 0; padding-left: 1em; font-style: italic; font-weight: 500;
               color: ${ROME.muted}; border-left: 0.25rem solid ${ROME.border}; }
  hr { border: 0; border-top: 1px solid ${ROME.border}; margin: 3em 0; }
  code { color: ${ROME.foreground}; font-weight: 600; font-size: 0.875em;
         background: ${ROME.surfaceMuted}; padding: 0.15em 0.35em; border-radius: 4px; }
  pre { color: ${ROME.foreground}; background: ${ROME.surfaceMuted}; font-size: 0.875em;
        line-height: 1.7142; margin: 1.7142em 0; padding: 0.857em 1.142em;
        border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; font-weight: 400; font-size: inherit; }
  /* Markdown tables are scoped to the body so these rules never hit the shell's
     own layout <table>/<td> elements. */
  .rome-body table { width: 100%; border-collapse: collapse; font-size: 0.875em;
                     line-height: 1.7142; margin: 1.7142em 0; }
  .rome-body th { color: ${ROME.foreground}; font-weight: 600; text-align: left;
                  padding: 0.571em 0.714em; border-bottom: 1px solid ${ROME.border}; }
  .rome-body td { padding: 0.571em 0.714em; border-bottom: 1px solid ${ROME.border};
                  vertical-align: top; }
  img { max-width: 100%; }
`;

let purifier: ReturnType<typeof DOMPurify> | null = null;
function getPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const { window } = new JSDOM("");
  purifier = DOMPurify(window as unknown as Parameters<typeof DOMPurify>[0]);
  return purifier;
}

/**
 * Sanitize app-provided HTML before it leaves as an outbound email. Self-
 * generated HTML (from `markdownToEmailHtml`) is trusted, but an app may hand us
 * arbitrary HTML — strip scripts, event handlers, and other unsendable/unsafe
 * constructs. We keep `style`/`class` so juice can still inline styling.
 */
export function sanitizeEmailHtml(html: string): string {
  return getPurifier().sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "noscript"],
    FORBID_ATTR: ["srcset"],
    ALLOW_DATA_ATTR: false,
  });
}

const MARKDOWN_OPTIONS = { gfm: true, breaks: true } as const;

function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { ...MARKDOWN_OPTIONS, async: false }) as string;
}

// A root-relative href is a dashboard route, the shape the agent charter gives
// file links. A mail client has no dashboard page to resolve it against, so
// outbound mail prefixes the instance origin. `//host` names another host and
// stays as written.
function isRootRelative(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

let linkDocument: Document | null = null;

// Prefixes the instance origin onto each root-relative `<a href>`, keeping the
// path, query and fragment as written. Markup with no such link comes back
// byte for byte.
function resolveHtmlLinks(html: string, instanceOrigin: string | null): string {
  if (!instanceOrigin) return html;
  linkDocument ??= new JSDOM("").window.document;
  const template = linkDocument.createElement("template");
  template.innerHTML = html;
  let resolved = false;
  for (const anchor of template.content.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!isRootRelative(href)) continue;
    anchor.setAttribute("href", instanceOrigin + href);
    resolved = true;
  }
  return resolved ? template.innerHTML : html;
}

// The text/plain alternative is markdown, so its link and definition
// destinations get the same prefix. Only the lexer's link and definition
// tokens are candidates, so code never is. A token is rewritten by replacing
// its source text, which is exact only while every occurrence of that text is
// the token itself. Text that also appears inside a code sample stays as
// written.
function resolveMarkdownLinks(markdown: string, instanceOrigin: string | null): string {
  if (!instanceOrigin) return markdown;
  const links = new Map<string, { resolved: string | null; count: number }>();
  marked.walkTokens(marked.lexer(markdown, MARKDOWN_OPTIONS), (token) => {
    if (token.type !== "link" && token.type !== "def") return;
    const link = token as Tokens.Link | Tokens.Def;
    if (!isRootRelative(link.href)) return;
    const seen = links.get(link.raw);
    if (seen) seen.count++;
    else links.set(link.raw, { resolved: resolveDestination(link, instanceOrigin), count: 1 });
  });
  let text = markdown;
  for (const [raw, { resolved, count }] of links) {
    if (resolved && markdown.split(raw).length - 1 === count) text = text.split(raw).join(resolved);
  }
  return text;
}

// The destination follows the last `](` of `[label](dest "title")`, or the
// `]:` of `[label]: dest`, after optional spaces and `<`. The last, because a
// label can quote link syntax. A destination written with backslash escapes
// does not read as `href` and stays as written, and so does a reference such
// as `[label][ref]`, whose destination sits on its definition.
function resolveDestination(
  token: Tokens.Link | Tokens.Def,
  instanceOrigin: string,
): string | null {
  const opener = token.raw.lastIndexOf(token.type === "link" ? "](" : "]:");
  if (opener === -1) return null;
  const lead = /^\s*<?/.exec(token.raw.slice(opener + 2))?.[0] ?? "";
  const start = opener + 2 + lead.length;
  if (!token.raw.startsWith(token.href, start)) return null;
  return token.raw.slice(0, start) + instanceOrigin + token.raw.slice(start);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function inlineStyles(bodyHtml: string): string {
  const doc = `<!doctype html><html><head><style>${OUTBOUND_BASE_CSS}</style></head><body>${bodyHtml}</body></html>`;
  return juice(doc);
}

// Splices an already-inlined fragment before </body> — used to append the Rome
// footer, inlined in a separate juice pass (see `htmlToEmailMultipart`).
function appendBeforeBodyClose(doc: string, fragment: string): string {
  const i = doc.lastIndexOf("</body>");
  return i === -1 ? doc + fragment : doc.slice(0, i) + fragment + doc.slice(i);
}

// The branded "accent-band" shell wrapped around outbound markdown emails: a
// centered white card on Rome's canvas, an ember top band carrying the Rome
// logo tile + wordmark, the prose body, and a muted footer with the Rome glyph.
// Table-based for client compatibility; juice inlines the `.rome-*` rules.
// Logos are hosted PNGs (clients strip inline SVG and block data-URI).
// The Rome sign-off shared by every outbound email: the transparent glyph plus
// "Sent by Rome · Settings". Inside the markdown shell it's the card's footer
// row; appended to app-supplied HTML it rides in `standaloneFooter` below.
function footerContent(instanceOrigin: string | null): string {
  const settingsUrl = instanceOrigin ? `${instanceOrigin}/settings` : ROME_SETTINGS_URL;
  return (
    `<img src="${ROME_LOGO_GLYPH_URL}" width="16" height="16" alt="" class="rome-footer-logo" />` +
    `<span class="rome-footer-text">Sent by Rome · <a href="${escapeAttribute(settingsUrl)}">Settings</a></span>`
  );
}

// A centered, muted footer block appended below app-supplied HTML so those
// emails carry the same Rome sign-off as the markdown ones. No card/band shell —
// the app owns its body design; we only add the footer underneath it.
function standaloneFooter(instanceOrigin: string | null): string {
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">',
    `<tr><td align="center" class="rome-standalone-footer">${footerContent(instanceOrigin)}</td></tr>`,
    "</table>",
  ].join("");
}

function wrapInShell(bodyHtml: string, instanceOrigin: string | null): string {
  const band =
    `<img src="${ROME_LOGO_TILE_URL}" width="32" height="32" alt="" class="rome-band-logo" />` +
    `<span class="rome-band-mark">Rome</span>`;
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="rome-bg">',
    '<tr><td align="center">',
    '<table role="presentation" cellpadding="0" cellspacing="0" class="rome-card">',
    `<tr><td class="rome-band">${band}</td></tr>`,
    `<tr><td class="rome-body">${bodyHtml}</td></tr>`,
    `<tr><td class="rome-footer">${footerContent(instanceOrigin)}</td></tr>`,
    "</table>",
    "</td></tr></table>",
  ].join("");
}

/**
 * Render an outbound message into a multipart pair. AgentMail's send API takes
 * `text` and `html` together, so we always produce both: the markdown source is
 * the `text/plain` alternative and `marked`+`juice` produces the inlined HTML.
 * Root-relative links in both resolve against `instanceOrigin`, this instance's
 * public web origin, and the footer's Settings link opens its settings page.
 * Without an origin, links stay as written and Settings opens the Rome website.
 */
export function markdownToEmailHtml(
  markdown: string,
  instanceOrigin: string | null = null,
): { html: string; text: string } {
  const source = markdown.trim();
  const body = resolveHtmlLinks(renderMarkdown(source), instanceOrigin);
  const html = inlineStyles(wrapInShell(body, instanceOrigin));
  return { html, text: resolveMarkdownLinks(source, instanceOrigin) };
}

/**
 * Prepare an outbound multipart when an app supplied raw `html`. The HTML is
 * sanitized and CSS-inlined; the `text/plain` alternative is derived by
 * converting the (sanitized) HTML back to markdown so recipients on text-only
 * clients still get a readable body. `fallbackText`, when present, wins over the
 * derived text (the agent's own words).
 *
 * The Rome sign-off footer is appended below the app's body so HTML emails carry
 * the same footer as the markdown ones. It's added after sanitize/text-derive so
 * it neither gets stripped nor leaks into the text/plain alternative (which, like
 * the markdown path, omits the footer).
 *
 * The footer is inlined in a SEPARATE juice pass from the app body and only then
 * spliced in, so app CSS can never reach the Rome sign-off. `sanitizeEmailHtml`
 * already strips app `<style>` blocks today, so this is defense-in-depth: if the
 * sanitizer's allow-list ever lets `<style>` through, a single combined pass
 * would inline generic selectors (e.g. `img { display:block }`, `td { padding:0 }`)
 * onto the footer and distort it. Giving the footer its own pass — seeing only
 * `OUTBOUND_BASE_CSS` — keeps it isolated regardless.
 *
 * Root-relative links in the app's HTML and in either text resolve against
 * `instanceOrigin` as in {@link markdownToEmailHtml}.
 */
export function htmlToEmailMultipart(
  html: string,
  fallbackText?: string,
  instanceOrigin: string | null = null,
): { html: string; text: string } {
  const sanitized = resolveHtmlLinks(sanitizeEmailHtml(html), instanceOrigin);
  const inlinedBody = inlineStyles(sanitized);
  const inlinedFooter = juice.inlineContent(standaloneFooter(instanceOrigin), OUTBOUND_BASE_CSS);
  const inlined = appendBeforeBodyClose(inlinedBody, inlinedFooter);
  const text = fallbackText?.trim() || htmlToMarkdown(sanitized, true);
  return { html: inlined, text: resolveMarkdownLinks(text, instanceOrigin) };
}
