function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  return normalizeWhitespace(value)
    .replace(/\s*[•·]\s*(?:1st|2nd|3rd\+?|degree connection).*$/i, "")
    .replace(/\s+LinkedIn.*$/i, "")
    .replace(/\b(p\.?eng\.?|cpa|mba|ph\.?d\.?)\b/gi, "")
    .replace(/[^\p{L}\p{N}\s.'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function canonicalizeLinkedInProfileUrl(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    const isLinkedInHost = hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    const profilePath = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !isLinkedInHost ||
      !profilePath?.[1]
    ) {
      return "";
    }

    url.hostname = "www.linkedin.com";
    url.pathname = url.pathname.toLowerCase();
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return "";
  }
}

export function matchesLinkedInSentInvitation(invitation, expectedName, expectedProfileUrl) {
  const expectedUrl = canonicalizeLinkedInProfileUrl(expectedProfileUrl);
  const actualUrl = canonicalizeLinkedInProfileUrl(invitation?.profile_url);
  const expected = normalizeName(expectedName);
  const actual = normalizeName(invitation?.name);
  const expectedTokens = expected
    .replace(/[.'-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const actualTokens = new Set(
    actual
      .replace(/[.'-]+/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );

  return Boolean(
    expectedUrl &&
      actualUrl === expectedUrl &&
      expectedTokens.length > 0 &&
      expectedTokens.every((token) => actualTokens.has(token)),
  );
}
