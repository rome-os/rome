// Pure helpers for the Zillow plugin. Nothing here touches the browser or the
// filesystem, so every function is exercised directly by zillow-helpers.test.mjs.

export const DEFAULT_ZILLOW_OUTPUT = "./zillow-downloads";
export const DEFAULT_ZILLOW_EXAMPLE_URL =
  "https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/";

/**
 * Zillow publishes each listing photo as a fixed ladder of width buckets. The
 * original-ratio ladder (`d_d` 800, `o_a` 1024, `uncropped_scaled_within_1344_1008`,
 * `uncropped_scaled_within_1536_1152`) scales the source photo down to fit the
 * bucket and never scales it up, so the widest bucket is the most faithful
 * served copy. The cropped ladder (`cc_ft_<width>`, 192 to 1536) trims the frame
 * to a fixed aspect ratio at small widths and only serves `thumb`. The listing's
 * `hiResImageLink` (`p_f`) is not on either ladder: it resizes every photo to
 * 1024px wide, upscaling small sources, so no size maps to it.
 */
export const ZILLOW_PHOTO_SIZES = ["full", "large", "medium", "small", "thumb"];

const SIZE_TARGET_WIDTH = {
  full: Number.POSITIVE_INFINITY,
  large: 1344,
  medium: 1024,
  small: 800,
  thumb: 384,
};

const ZILLOW_HOSTNAME = /^(?:[a-z0-9-]+\.)*zillow\.com$/i;
const PX_COOKIE_NAME = /^(?:_px[a-z0-9]*|pxcts)$/i;
const PHOTO_KEY = /^[0-9a-f]{32}$/i;

export function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function integerInRange(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function urlBasename(url) {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] || "");
  } catch (_) {
    return "";
  }
}

/**
 * Accept a listing URL with or without a scheme, require a Zillow host, and
 * drop query/hash so tracking parameters never reach the browser or the output.
 */
export function canonicalZillowListingUrl(input) {
  const text = cleanText(input);
  if (!text) throw new Error("url must not be empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (_) {
    throw new Error(`url is not a valid URL: ${text}`);
  }
  if (!/^https?:$/i.test(url.protocol) || !ZILLOW_HOSTNAME.test(url.hostname)) {
    throw new Error(`url must be a Zillow listing URL such as ${DEFAULT_ZILLOW_EXAMPLE_URL}`);
  }
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  const canonical = url.toString();
  return canonical.endsWith("/") ? canonical : `${canonical}/`;
}

export function isZillowUrl(value) {
  try {
    return ZILLOW_HOSTNAME.test(new URL(String(value ?? "")).hostname);
  } catch (_) {
    return false;
  }
}

/** PerimeterX cookies carry Zillow's bot verdict; nothing else on the site does. */
export function isPerimeterXCookie(cookie) {
  return PX_COOKIE_NAME.test(cleanText(cookie?.name));
}

function sanitizeSegment(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** The zpid encoded in a home details path such as `/homedetails/<slug>/15598337_zpid/`. */
export function zillowZpidFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (_) {
    return "";
  }
  const match = /\/(\d+)_zpid(?:\/|$)/i.exec(pathname);
  return match ? match[1] : "";
}

/**
 * Folder name for one listing: `<address slug>-<zpid>` from a canonical home
 * details URL such as `/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/`.
 * The zpid keeps two listings that share a street address apart.
 */
export function zillowListingSlug(url) {
  let segments;
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean);
  } catch (_) {
    segments = [];
  }
  const zpidIndex = segments.findIndex((segment) => /^\d+_zpid$/i.test(segment));
  const parts = [];
  if (zpidIndex >= 0) {
    const address = segments[zpidIndex - 1];
    if (address && !/^homedetails$/i.test(address)) parts.push(address);
    if (parts.length === 0) parts.push("zillow");
    parts.push(segments[zpidIndex].replace(/_zpid$/i, ""));
  } else {
    parts.push(...segments.filter((segment) => !/^homedetails$/i.test(segment)));
  }
  const slug = sanitizeSegment(parts.join("-"));
  return slug || "zillow-listing";
}

export function detectZillowChallenge(pageData) {
  const title = cleanText(pageData?.title);
  const body = cleanText(pageData?.body_text);
  return (
    pageData?.challenge === true ||
    /access to this page has been denied|access denied|captcha/i.test(title) ||
    /press\s*&\s*hold|confirm you are (?:a )?human|verify you are (?:a )?human|are you a robot|unusual (?:traffic|activity)|captcha/i.test(
      body,
    )
  );
}

export function detectZillowNotFound(pageData) {
  const title = cleanText(pageData?.title);
  const body = cleanText(pageData?.body_text);
  const error = cleanText(pageData?.error_message);
  return (
    /page not found|not found/i.test(error) ||
    /page not found/i.test(title) ||
    /error 404|page not found/i.test(body)
  );
}

/**
 * Zillow answers some automated loads with a bare HTTP 5xx and no page at all,
 * which Chrome renders as its own error page. That load is a refusal, not a
 * listing, so the loader treats it like a challenge and retries once.
 */
export function detectZillowUnavailable(pageData) {
  const url = cleanText(pageData?.url);
  const body = cleanText(pageData?.body_text);
  return (
    /^chrome-error:/i.test(url) ||
    /http error 5\d\d|is currently unable to handle this request|this page isn.t working/i.test(
      body,
    )
  );
}

export function describeZillowListing(pageData, fallbackUrl = "") {
  const property = pageData?.property || {};
  const address = property.address && typeof property.address === "object" ? property.address : {};
  const street = cleanText(property.streetAddress || address.streetAddress);
  const city = cleanText(property.city || address.city);
  const state = cleanText(property.state || address.state);
  const zip = cleanText(property.zipcode || address.zipcode);
  const locality = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const assembled = [street, locality].filter(Boolean).join(", ");
  let url = cleanText(pageData?.url) || cleanText(fallbackUrl);
  const hdpUrl = cleanText(property.hdpUrl);
  if (hdpUrl.startsWith("/")) url = `https://www.zillow.com${hdpUrl}`;
  return {
    url,
    title: cleanText(pageData?.title),
    address: assembled,
    street,
    city,
    state,
    zip,
    status: cleanText(property.homeStatus).toLowerCase().replace(/_/g, " "),
    zpid: property.zpid != null ? String(property.zpid) : zillowZpidFromUrl(url),
    mls_id: cleanText(property.mlsid),
    photo_count: Number.isInteger(property.photoCount) ? property.photoCount : null,
  };
}

/** Photo key encoded in a CDN URL such as `.../fp/<32 hex>-o_a.jpg`. */
export function zillowPhotoKey(url) {
  const match = /^([0-9a-f]{32})(?:-|\.|$)/i.exec(urlBasename(url));
  return match ? match[1].toLowerCase() : "";
}

/** The JPEG sources of one ladder entry, widest first. */
function jpegSources(entry) {
  const list = entry?.mixedSources?.jpeg;
  if (!Array.isArray(list)) return [];
  return list
    .filter((source) => isHttpUrl(source?.url))
    .map((source) => ({ url: source.url, width: Number(source.width) || 0 }))
    .sort((a, b) => b.width - a.width);
}

/**
 * One gallery entry from Zillow's `responsivePhotosOriginalRatio` list, joined
 * with the cropped ladder of the same position from `responsivePhotos`. Both
 * lists come from the same page state in the same order.
 */
export function normalizeZillowPhoto(candidate, index, cropped = null) {
  const original = jpegSources(candidate);
  const croppedSources = jpegSources(cropped);
  const anyUrl = original[0]?.url || croppedSources[0]?.url || candidate?.url || "";
  const key = PHOTO_KEY.test(String(candidate?.key ?? ""))
    ? String(candidate.key).toLowerCase()
    : zillowPhotoKey(anyUrl);
  return {
    index: index + 1,
    photo_key: key,
    caption: cleanText(candidate?.caption ?? cropped?.caption),
    subject_type: cleanText(candidate?.subjectType ?? cropped?.subjectType),
    original,
    cropped: croppedSources,
  };
}

function uniqueInOrder(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/**
 * Gallery photos for the listing, in Zillow's display order. The page state's
 * original-ratio list is authoritative. When it is missing, CDN URLs scraped
 * from the HTML stand in, grouped by photo key in order of first appearance,
 * with only the widest variant of each key kept.
 */
export function collectZillowPhotos(pageData) {
  const property = pageData?.property || {};
  const originals = Array.isArray(property.responsivePhotosOriginalRatio)
    ? property.responsivePhotosOriginalRatio
    : [];
  const cropped = Array.isArray(property.responsivePhotos) ? property.responsivePhotos : [];
  const fromState = originals
    .map((candidate, index) => normalizeZillowPhoto(candidate, index, cropped[index] || null))
    .filter((photo) => photo.original.length > 0 || photo.cropped.length > 0)
    .map((photo, index) => ({ ...photo, index: index + 1 }));
  if (fromState.length > 0) return { photos: fromState, source: "state" };

  const croppedOnly = cropped
    .map((candidate, index) => normalizeZillowPhoto(null, index, candidate))
    .filter((photo) => photo.cropped.length > 0)
    .map((photo, index) => ({ ...photo, index: index + 1 }));
  if (croppedOnly.length > 0) return { photos: croppedOnly, source: "state" };

  const htmlUrls = uniqueInOrder(
    (Array.isArray(pageData?.html_photo_urls) ? pageData.html_photo_urls : []).filter(isHttpUrl),
  );
  const byKey = new Map();
  for (const url of htmlUrls) {
    const key = zillowPhotoKey(url);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(url);
  }
  const photos = [...byKey.entries()].map(([key, urls], index) => {
    const ranked = urls
      .map((url) => ({ url, width: zillowVariantWidth(url) }))
      .sort((a, b) => b.width - a.width);
    return {
      index: index + 1,
      photo_key: key,
      caption: "",
      subject_type: "",
      original: ranked.filter((entry) => !/-cc_ft_\d+\./i.test(entry.url)),
      cropped: ranked.filter((entry) => /-cc_ft_\d+\./i.test(entry.url)),
    };
  });
  return { photos, source: photos.length > 0 ? "html" : "none" };
}

/** Width bucket encoded in a CDN variant name, for ranking scraped URLs. */
export function zillowVariantWidth(url) {
  const name = urlBasename(url);
  let match = /-uncropped_scaled_within_(\d+)_\d+\./i.exec(name);
  if (match) return Number(match[1]);
  match = /-cc_ft_(\d+)\./i.exec(name);
  if (match) return Number(match[1]);
  if (/-o_a\./i.test(name)) return 1024;
  if (/-d_d\./i.test(name)) return 800;
  if (/-p_f\./i.test(name)) return 1024;
  if (/-p_h\./i.test(name)) return 550;
  if (/-p_e\./i.test(name)) return 596;
  if (/-p_d\./i.test(name)) return 400;
  return 0;
}

/**
 * The variant for a requested size: the widest original-ratio bucket that fits
 * the size's target width, else the narrowest bucket above it. `thumb` reads
 * the cropped ladder instead, because the original-ratio ladder stops at 800.
 * A photo with no usable bucket at all yields an empty URL.
 */
export function selectZillowPhotoUrl(photo, size) {
  const target = SIZE_TARGET_WIDTH[size] ?? Number.POSITIVE_INFINITY;
  const ladder = size === "thumb" ? photo?.cropped : photo?.original;
  const fallback = size === "thumb" ? photo?.original : photo?.cropped;
  const chosen = pickWidth(ladder, target) || pickWidth(fallback, target);
  return chosen ? { url: chosen.url, width: chosen.width } : { url: "", width: 0 };
}

function pickWidth(sources, target) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const fitting = sources.filter((entry) => entry.width <= target);
  if (fitting.length > 0) return fitting[0];
  return sources[sources.length - 1];
}

/**
 * `01-40a2df03a9e1e7ce67de59c614683f5f.jpg`: a zero-padded gallery position
 * keeps files sorted the way Zillow shows them, and the CDN photo key keeps
 * the asset provenance. Sizes other than `full` carry the size so variants of
 * one photo never overwrite each other in a shared folder.
 */
export function buildZillowPhotoFilename({ url, key, index, total, size }) {
  const width = Math.max(2, String(Math.max(Number(total) || 0, Number(index) || 0)).length);
  const prefix = String(index).padStart(width, "0");
  const extension = (
    (/\.([A-Za-z0-9]{2,5})$/.exec(urlBasename(url)) || [])[1] || "jpg"
  ).toLowerCase();
  const base = PHOTO_KEY.test(String(key ?? ""))
    ? String(key).toLowerCase()
    : sanitizeSegment(urlBasename(url).replace(/\.[A-Za-z0-9]{2,5}$/, "")) || "photo";
  return size && size !== "full"
    ? `${prefix}-${size}-${base}.${extension}`
    : `${prefix}-${base}.${extension}`;
}

/** One download plan entry per photo: which URL to fetch and what to name it. */
export function planZillowDownloads(photos, { size = "full", limit = 0 } = {}) {
  const selected = limit > 0 ? photos.slice(0, limit) : photos;
  const total = selected.length;
  return selected.map((photo, order) => {
    const index = order + 1;
    const chosen = selectZillowPhotoUrl(photo, size);
    return {
      index,
      photo_key: photo.photo_key,
      caption: photo.caption,
      subject_type: photo.subject_type,
      width: chosen.width,
      url: chosen.url,
      file_name: chosen.url
        ? buildZillowPhotoFilename({ url: chosen.url, key: photo.photo_key, index, total, size })
        : "",
    };
  });
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Output row for one planned download. `result` follows opencli's httpDownload
 * shape (`{ success, size, error }`); `file` is only reported for a file that
 * exists on disk.
 */
export function summarizeZillowDownload(item, result, { listing = {}, file = "" } = {}) {
  const success = result?.success === true;
  return {
    index: item.index,
    status: success ? "success" : "failed",
    size: success ? formatBytes(result.size) : "",
    bytes: success ? Number(result.size) || 0 : 0,
    file: success ? file : "",
    error: success ? "" : cleanText(result?.error) || "unknown error",
    photo_key: item.photo_key,
    caption: item.caption,
    subject_type: item.subject_type,
    width: item.width,
    url: item.url,
    address: listing.address || "",
    zpid: listing.zpid || "",
    listing_url: listing.url || "",
  };
}

export function normalizePhotoRow(photo, listing, size) {
  const chosen = selectZillowPhotoUrl(photo, size);
  const full = selectZillowPhotoUrl(photo, "full");
  const thumb = selectZillowPhotoUrl(photo, "thumb");
  return {
    index: photo.index,
    photo_key: photo.photo_key,
    caption: photo.caption,
    subject_type: photo.subject_type,
    width: chosen.width,
    url: chosen.url,
    thumbnail_url: thumb.url,
    full_url: full.url,
    address: listing.address,
    zpid: listing.zpid,
    listing_url: listing.url,
  };
}
