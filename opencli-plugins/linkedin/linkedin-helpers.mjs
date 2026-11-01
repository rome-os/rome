export const LINKEDIN_ORIGIN = "https://www.linkedin.com";

const PROFILE_PATH_RE = /^\/in\/([^/?#]+)(?:\/.*)?$/i;

export function cleanText(value) {
  return typeof value === "string"
    ? value
        .replace(/[\u00a0\u202f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

export function unwrapEvaluateResult(payload) {
  if (payload && typeof payload === "object" && "data" in payload && "session" in payload) {
    return payload.data;
  }
  return payload;
}

function normalizeIdentifier(value) {
  let identifier;
  try {
    identifier = decodeURIComponent(cleanText(value).replace(/^@/, ""));
  } catch {
    throw new Error("profile contains an invalid percent-encoded LinkedIn identifier");
  }
  if (!identifier || identifier === "." || identifier === "..") {
    throw new Error("profile must include a LinkedIn public identifier");
  }
  if (identifier.toLowerCase() === "me") return "me";
  if (!/^[\p{L}\p{N}._-]+$/u.test(identifier)) {
    throw new Error(
      "profile must be a LinkedIn /in/ URL or public identifier containing only letters, numbers, dots, underscores, or hyphens",
    );
  }
  return identifier;
}

export function normalizeLinkedInProfile(value) {
  const raw = cleanText(value);
  if (!raw) throw new Error("profile is required");

  let identifier = "";
  const looksLikeUrl = /^(?:https?:\/\/|\/\/|(?:www\.)?linkedin\.com\/)/i.test(raw);
  if (looksLikeUrl) {
    const candidate = /^https?:\/\//i.test(raw)
      ? raw
      : raw.startsWith("//")
        ? `https:${raw}`
        : `https://${raw}`;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("profile must be a valid LinkedIn profile URL or public identifier");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !/^(?:www\.)?linkedin\.com$/i.test(parsed.hostname)
    ) {
      throw new Error(
        "profile URL must use https://www.linkedin.com without credentials or a port",
      );
    }
    const match = parsed.pathname.match(PROFILE_PATH_RE);
    if (!match) throw new Error("profile URL must point to a LinkedIn /in/<identifier> profile");
    identifier = normalizeIdentifier(match[1]);
  } else if (/^\/?in\//i.test(raw)) {
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    const match = path.match(PROFILE_PATH_RE);
    if (!match) throw new Error("profile path must use /in/<identifier>");
    identifier = normalizeIdentifier(match[1]);
  } else {
    identifier = normalizeIdentifier(raw);
  }

  const encoded = encodeURIComponent(identifier);
  return {
    identifier,
    profile_url: `${LINKEDIN_ORIGIN}/in/${encoded}/`,
  };
}

export function contactInfoUrl(profileUrl) {
  const normalized = normalizeLinkedInProfile(profileUrl);
  return `${normalized.profile_url}overlay/contact-info/`;
}

function typeFromHeading(heading, icon = "") {
  const label = cleanText(heading).toLowerCase();
  const iconId = cleanText(icon).toLowerCase();
  if (/^(?:your )?profile$/.test(label) || /linkedin/.test(iconId)) return "profile";
  if (/^websites?$/.test(label) || /(?:^|-)link(?:-|$)/.test(iconId)) return "website";
  if (/^e-?mails?$/.test(label) || /envelope|email/.test(iconId)) return "email";
  if (/^phones?$/.test(label) || /phone/.test(iconId)) return "phone";
  if (/^address(?:es)?$/.test(label) || /address|location|map-pin/.test(iconId)) return "address";
  if (/^birthdays?$/.test(label) || /birthday|cake/.test(iconId)) return "birthday";
  if (/^connected$/.test(label) || /connection/.test(iconId)) return "connected";
  if (/^twitter$|^x \(twitter\)$/.test(label) || /twitter/.test(iconId)) return "twitter";
  if (/instant messag|messenger/.test(label) || /message/.test(iconId)) {
    return "instant_messenger";
  }
  return "other";
}

function normalizeHttpUrl(parsed) {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password) return "";
  if (
    /^(?:www\.)?linkedin\.com$/i.test(parsed.hostname) &&
    /^\/safety\/go\/?$/i.test(parsed.pathname)
  ) {
    const target = parsed.searchParams.get("url");
    if (!target) return "";
    try {
      return normalizeHttpUrl(new URL(target));
    } catch {
      return "";
    }
  }
  return parsed.toString();
}

export function normalizeContactHref(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw, LINKEDIN_ORIGIN);
    if (parsed.protocol === "mailto:") {
      const address = decodeURIComponent(parsed.pathname).trim();
      return address ? `mailto:${address}` : "";
    }
    if (parsed.protocol === "tel:") {
      const phone = decodeURIComponent(parsed.pathname).trim();
      return phone ? `tel:${phone}` : "";
    }
    return normalizeHttpUrl(parsed);
  } catch {
    return "";
  }
}

function typeFromHref(href, fallback) {
  if (/^mailto:/i.test(href)) return "email";
  if (/^tel:/i.test(href)) return "phone";
  try {
    const parsed = new URL(href);
    if (/^(?:www\.)?linkedin\.com$/i.test(parsed.hostname) && /^\/in\//i.test(parsed.pathname)) {
      return "profile";
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return fallback === "twitter" ? "twitter" : "website";
    }
  } catch {}
  return fallback;
}

function hrefValue(href, text) {
  if (/^mailto:/i.test(href)) {
    return cleanText(text) || decodeURIComponent(href.slice("mailto:".length));
  }
  if (/^tel:/i.test(href)) {
    return cleanText(text) || decodeURIComponent(href.slice("tel:".length));
  }
  return cleanText(text) || href;
}

function uniqueTexts(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(cleanText).filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowBase(profile, status, message = "") {
  return {
    profile_url: cleanText(profile?.profile_url) || null,
    profile_id: cleanText(profile?.identifier) || null,
    name: cleanText(profile?.name) || null,
    status,
    type: null,
    label: null,
    value: null,
    url: null,
    message: message || null,
  };
}

function normalizeSection(section, profile) {
  const heading = cleanText(section?.heading) || "Other";
  const fallbackType = typeFromHeading(heading, section?.icon);
  const blocks = uniqueTexts(section?.blocks);
  const lines = uniqueTexts(section?.lines);
  const links = (Array.isArray(section?.links) ? section.links : [])
    .map((link) => ({
      text: cleanText(link?.text),
      context: cleanText(link?.context),
      href: normalizeContactHref(link?.href),
    }))
    .filter((link) => link.href);
  const rows = [];
  const consumed = new Set([heading.toLowerCase()]);

  for (const link of links) {
    const type = typeFromHref(link.href, fallbackType);
    const value = hrefValue(link.href, link.text);
    const detail = cleanText(link.context.replace(link.text, ""));
    rows.push({
      ...rowBase(profile, "available"),
      type,
      label: detail && detail !== heading ? `${heading} ${detail}` : heading,
      value: value || null,
      url: link.href || null,
    });
    for (const consumedValue of [link.text, link.context, value]) {
      if (cleanText(consumedValue)) consumed.add(cleanText(consumedValue).toLowerCase());
    }
  }

  const residual = (blocks.length > 0 ? blocks : lines).filter((value) => {
    const lower = value.toLowerCase();
    if (consumed.has(lower)) return false;
    return !links.some(
      (link) =>
        link.text && (lower === link.text.toLowerCase() || lower === link.context.toLowerCase()),
    );
  });
  for (const value of residual) {
    rows.push({
      ...rowBase(profile, "available"),
      type: fallbackType,
      label: heading,
      value,
    });
  }
  return rows;
}

export function normalizeProfileProbe(payload, requestedProfile) {
  const probe = unwrapEvaluateResult(payload);
  if (!probe || typeof probe !== "object") {
    throw new Error("LinkedIn profile lookup returned a malformed browser payload");
  }
  const currentUrl = cleanText(probe.current_url);
  let resolved = null;
  try {
    resolved = normalizeLinkedInProfile(currentUrl);
  } catch {}
  const profile = {
    identifier: resolved?.identifier || requestedProfile.identifier,
    profile_url: resolved?.profile_url || requestedProfile.profile_url,
    name: cleanText(probe.name),
  };
  const unavailable = probe.unavailable === true || (!resolved && probe.auth_wall !== true);
  return {
    ...profile,
    auth_wall: probe.auth_wall === true,
    unavailable,
    unavailable_reason: cleanText(probe.unavailable_reason),
  };
}

export function normalizeContactPayload(payload, profile) {
  const contact = unwrapEvaluateResult(payload);
  if (!contact || typeof contact !== "object") {
    throw new Error("LinkedIn contact-info returned a malformed browser payload");
  }
  if (profile?.unavailable) {
    return [
      rowBase(
        profile,
        "profile_unavailable",
        profile.unavailable_reason ||
          "The LinkedIn profile is unavailable or restricted for the logged-in account.",
      ),
    ];
  }
  if (contact.dialog_found !== true) {
    const restricted = contact.restricted === true;
    return [
      rowBase(
        profile,
        restricted ? "contact_info_restricted" : "contact_info_unavailable",
        restricted
          ? "LinkedIn does not allow the logged-in account to view this profile's contact information."
          : contact.timed_out === true
            ? "LinkedIn did not open the Contact info section before the command's time limit."
            : "LinkedIn did not expose a contact information section for this profile.",
      ),
    ];
  }

  const rows = (Array.isArray(contact.sections) ? contact.sections : []).flatMap((section) =>
    normalizeSection(section, profile),
  );
  const seen = new Set();
  const deduped = rows.filter((row) => {
    const key = [row.type, row.label, row.value, row.url]
      .map((value) => cleanText(value).toLowerCase())
      .join("|");
    if (!row.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length > 0) return deduped;
  return [
    rowBase(
      profile,
      "no_visible_contact_info",
      "No contact information is visible to the logged-in LinkedIn account.",
    ),
  ];
}

export const __test__ = {
  typeFromHeading,
};
