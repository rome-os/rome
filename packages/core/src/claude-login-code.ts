const MIN_CLAUDE_LOGIN_CODE_PART_LENGTH = 16;
const INVALID_CLAUDE_LOGIN_CODE =
  "Paste a valid Claude sign-in callback link or authorization code.";
const CODE_BOUNDARY = /[\s"'`<>()\[\]{}]/;
const EMBEDDED_CODE = /[^\s"'`<>()\[\]{}]+#[^\s"'`<>()\[\]{}]+/;
const SPLIT_EMBEDDED_CODE = /([^\s"'`<>()\[\]{}]{16,})\s*#\s*([^\s"'`<>()\[\]{}]{16,})/;
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/i;

export class ClaudeLoginCodeValidationError extends Error {
  constructor(message = INVALID_CLAUDE_LOGIN_CODE) {
    super(message);
    this.name = "ClaudeLoginCodeValidationError";
  }
}

function invalidCode(): never {
  throw new ClaudeLoginCodeValidationError();
}

function collapseWhitespace(raw: string): string {
  return raw.trim().replace(/\s+/g, "");
}

function hasControlCharacters(raw: string): boolean {
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw);
}

function decodeUrlFragment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    invalidCode();
  }
}

function leadingCodePart(raw: string): string {
  const end = raw.search(/[&?\s"'`<>()\[\]{}]/);
  return end === -1 ? raw : raw.slice(0, end);
}

function trimWrappers(raw: string): string {
  return raw
    .trim()
    .replace(/^[,.;:]+/, "")
    .replace(/[,.;:]+$/, "");
}

function validateClaudeLoginCode(code: string): string {
  const normalized = trimWrappers(collapseWhitespace(code));
  if (hasControlCharacters(normalized)) invalidCode();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) invalidCode();

  const parts = normalized.split("#");
  if (parts.length !== 2) invalidCode();
  const [left, right] = parts;
  if (
    left.length < MIN_CLAUDE_LOGIN_CODE_PART_LENGTH ||
    right.length < MIN_CLAUDE_LOGIN_CODE_PART_LENGTH
  ) {
    invalidCode();
  }
  return `${left}#${right}`;
}

function decodeUrlComponentLiteralPlus(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    invalidCode();
  }
}

function extractRawQueryParam(search: string, name: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    if (!part) continue;
    const [rawKey, ...rawValueParts] = part.split("=");
    if (decodeUrlComponentLiteralPlus(rawKey) !== name) continue;
    return decodeUrlComponentLiteralPlus(rawValueParts.join("="));
  }
  return null;
}

function extractCodeFromUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalidCode();
  }

  if (url.protocol !== "https:") invalidCode();
  let code = extractRawQueryParam(url.search, "code");
  if (!code) invalidCode();
  if (!code.includes("#") && url.hash.length > 1) {
    const fragmentCode = leadingCodePart(decodeUrlFragment(url.hash.slice(1)));
    if (fragmentCode) {
      code = `${code}#${fragmentCode}`;
    }
  }
  return validateClaudeLoginCode(code);
}

function extractEmbeddedCode(raw: string): string | null {
  const splitMatch = raw.match(SPLIT_EMBEDDED_CODE);
  if (splitMatch) return `${splitMatch[1]}#${splitMatch[2]}`;

  const directMatch = raw.match(EMBEDDED_CODE)?.[0];
  if (directMatch) return directMatch;

  const hashIndex = raw.indexOf("#");
  if (hashIndex === -1) return null;

  let leftStart = hashIndex - 1;
  while (leftStart >= 0 && !CODE_BOUNDARY.test(raw[leftStart])) leftStart--;
  let rightEnd = hashIndex + 1;
  while (rightEnd < raw.length && !CODE_BOUNDARY.test(raw[rightEnd])) rightEnd++;

  return raw.slice(leftStart + 1, rightEnd);
}

/**
 * Extract and validate the value Claude expects at the "Paste code here" prompt.
 *
 * The browser may copy either the raw OAuth code or a callback URL containing a
 * `code=` query parameter. Claude codes contain a literal `#`; if a copied
 * callback URL leaves that unescaped, the browser parses the right side as the
 * URL fragment, so extraction stitches `code=<left>` and `#<right>` back
 * together before validation.
 */
export function extractClaudeLoginCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || hasControlCharacters(trimmed)) invalidCode();

  if (/^https?:\/\//i.test(trimmed)) {
    return extractCodeFromUrl(trimmed);
  }

  const urlMatch = trimmed.match(URL_IN_TEXT)?.[0];
  if (urlMatch) {
    return extractCodeFromUrl(urlMatch);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) invalidCode();

  return validateClaudeLoginCode(extractEmbeddedCode(trimmed) ?? trimmed);
}

/**
 * Format a validated Claude OAuth code as terminal input for the Ink TUI.
 *
 * The code rides inside a bracketed-paste envelope (`ESC[200~` … `ESC[201~`)
 * followed by a carriage return. CLI 2.1.251's Ink "Paste code here" prompt
 * treats a single burst of many characters as a paste and folds a trailing
 * `\r` in that same burst into the pasted text instead of submitting — so a
 * bare `${code}\r` write hangs for realistic (~130-char) codes while short
 * ones happen to submit. The `ESC[201~` terminator ends the paste explicitly,
 * so the following `\r` reads as a clean submit keypress regardless of length.
 * Validation rejects control characters, so the code can never contain ESC and
 * thus cannot forge the paste sentinels.
 */
export function formatClaudeLoginCodeInput(raw: string): string {
  const code = extractClaudeLoginCode(raw);
  return `\x1b[200~${code}\x1b[201~\r`;
}
