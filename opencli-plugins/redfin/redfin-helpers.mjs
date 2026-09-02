// Pure helpers for the Redfin plugin. Nothing here touches the browser or the
// filesystem, so every function is exercised directly by redfin-helpers.test.mjs.

export const DEFAULT_REDFIN_OUTPUT = "./redfin-downloads";
export const DEFAULT_REDFIN_EXAMPLE_URL =
  "https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461";

/**
 * Redfin's CDN serves each listing photo in fixed variants. `full` is the
 * uncropped frame from Redfin's full-screen viewer (`bigphoto`, up to 1280px
 * wide) and the most faithful copy. `large` (`mbphotov3`) is a fixed 1080x771
 * crop, so it can carry more pixels than `full` on a small source photo while
 * still losing the frame edges. Redfin's per-photo `width`/`height` describe the
 * uploaded source, not any served variant, hence the `source_*` row fields.
 */
export const REDFIN_PHOTO_SIZES = ["full", "large", "medium", "small", "thumb"];

const PHOTO_URL_PATHS = {
  full: ["photoUrls", "fullScreenPhotoUrl"],
  large: ["photoUrls", "nonFullScreenPhotoUrlCompressed"],
  medium: ["photoUrls", "nonFullScreenPhotoUrl"],
  small: ["photoUrls", "lightboxListUrl"],
  thumb: ["thumbnailData", "thumbnailUrl"],
};

const REDFIN_HOSTNAME = /^(?:[a-z0-9-]+\.)*redfin\.(?:com|ca)$/i;

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
 * Accept a listing URL with or without a scheme, require a Redfin host, and
 * drop query/hash so tracking parameters never reach the browser or the output.
 */
export function canonicalRedfinListingUrl(input) {
  const text = cleanText(input);
  if (!text) throw new Error("url must not be empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (_) {
    throw new Error(`url is not a valid URL: ${text}`);
  }
  if (!/^https?:$/i.test(url.protocol) || !REDFIN_HOSTNAME.test(url.hostname)) {
    throw new Error(`url must be a Redfin listing URL such as ${DEFAULT_REDFIN_EXAMPLE_URL}`);
  }
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function isRedfinUrl(value) {
  try {
    return REDFIN_HOSTNAME.test(new URL(String(value ?? "")).hostname);
  } catch (_) {
    return false;
  }
}

function sanitizeSegment(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Folder name for one listing: `<address slug>[-<unit>]-<property id>` from a
 * canonical URL such as `/CA/Atherton/349-Walsh-Rd-94027/home/1061461`. The id
 * keeps two listings that share a street address apart.
 */
export function redfinListingSlug(url) {
  let segments;
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean);
  } catch (_) {
    segments = [];
  }
  const homeIndex = segments.findIndex(
    (segment, index) =>
      /^(?:home|apartment|building)$/i.test(segment) && /^\d+$/.test(segments[index + 1] || ""),
  );
  const parts = [];
  if (homeIndex >= 0) {
    let addressIndex = homeIndex - 1;
    const unit = [];
    while (addressIndex >= 0 && /^unit-/i.test(segments[addressIndex])) {
      unit.unshift(segments[addressIndex]);
      addressIndex -= 1;
    }
    if (addressIndex >= 0) parts.push(segments[addressIndex]);
    parts.push(...unit);
    if (parts.length === 0) parts.push("redfin");
    parts.push(segments[homeIndex + 1]);
  } else {
    parts.push(...segments);
  }
  const slug = sanitizeSegment(parts.join("-"));
  return slug || "redfin-listing";
}

/**
 * Photo position encoded in a CDN file name. Redfin names the first photo
 * `<MLS>_<version>.jpg` and every later one `<MLS>_<position>_<version>.jpg`.
 */
export function redfinPhotoPosition(fileName) {
  const match = /^(.*?)_(?:(\d+)_)?(\d+)\.[A-Za-z0-9]+$/.exec(cleanText(fileName));
  if (!match) return null;
  return match[2] === undefined ? 0 : Number(match[2]);
}

export function detectRedfinChallenge(pageData) {
  const title = cleanText(pageData?.title);
  const body = cleanText(pageData?.body_text);
  return (
    /access to this page has been denied|access denied|captcha/i.test(title) ||
    /press\s*&\s*hold|confirm you are (?:a )?human|verify you are (?:a )?human|are you a robot|unusual (?:traffic|activity)|captcha/i.test(
      body,
    )
  );
}

export function detectRedfinNotFound(pageData) {
  const title = cleanText(pageData?.title);
  const body = cleanText(pageData?.body_text);
  return (
    /page not found/i.test(title) ||
    /lost that one|page (?:you requested )?(?:could not|cannot|can't) be found|no longer available/i.test(
      body,
    )
  );
}

export function describeRedfinListing(pageData, fallbackUrl = "") {
  const media = pageData?.media_browser_info || {};
  const address = pageData?.address_section_info || {};
  const initial = pageData?.initial_info || {};
  const assembled = cleanText(
    media.altTextForImage || media.assembledAddress || address.assembledAddress,
  );
  return {
    url: cleanText(pageData?.url) || cleanText(fallbackUrl),
    title: cleanText(pageData?.title),
    address: assembled,
    city: cleanText(address.city),
    state: cleanText(address.state),
    zip: cleanText(address.zip),
    status: cleanText(address.status),
    listing_id: initial.listingId != null ? String(initial.listingId) : "",
    property_id: initial.propertyId != null ? String(initial.propertyId) : "",
  };
}

export function normalizeRedfinPhoto(candidate, index, tagsByPhotoId = {}) {
  const urls = {};
  for (const size of REDFIN_PHOTO_SIZES) {
    const [group, key] = PHOTO_URL_PATHS[size];
    const value = candidate?.[group]?.[key];
    urls[size] = isHttpUrl(value) ? value : "";
  }
  const photoId = candidate?.photoId != null ? String(candidate.photoId) : "";
  const tagEntry = photoId && tagsByPhotoId ? tagsByPhotoId[photoId] : undefined;
  const tags = Array.isArray(tagEntry?.tags)
    ? tagEntry.tags.map(cleanText).filter((tag) => tag && !/^all$/i.test(tag))
    : [];
  const sourceWidth = Number(candidate?.width);
  const sourceHeight = Number(candidate?.height);
  return {
    index: index + 1,
    photo_id: photoId,
    caption: cleanText(tagEntry?.shortCaption),
    long_caption: cleanText(tagEntry?.longCaption),
    tags,
    source_width: Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : null,
    source_height: Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : null,
    file_name: cleanText(candidate?.fileName) || urlBasename(urls.full),
    urls,
  };
}

function largestGroupInOrder(urls) {
  const groups = new Map();
  for (const url of urls) {
    const key = url.replace(/[^/]*$/, "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(url);
  }
  let best = [];
  for (const group of groups.values()) {
    if (group.length > best.length) best = group;
  }
  return best;
}

/**
 * Gallery photos for the listing, in Redfin's display order. The server-rendered
 * media browser payload is authoritative; when it is missing, full-size CDN
 * URLs scraped from the HTML stand in, narrowed to the single listing directory
 * that contributes the most photos and ordered by their encoded position.
 */
export function collectRedfinPhotos(pageData) {
  const rawPhotos = Array.isArray(pageData?.media_browser_info?.photos)
    ? pageData.media_browser_info.photos
    : [];
  const tagsByPhotoId =
    pageData?.tags_by_photo_id && typeof pageData.tags_by_photo_id === "object"
      ? pageData.tags_by_photo_id
      : {};
  const photos = rawPhotos
    .map((candidate, index) => normalizeRedfinPhoto(candidate, index, tagsByPhotoId))
    .filter((photo) => Object.values(photo.urls).some(Boolean))
    .map((photo, index) => ({ ...photo, index: index + 1 }));
  if (photos.length > 0) return { photos, source: "state" };

  const seen = new Set();
  const htmlUrls = (Array.isArray(pageData?.html_photo_urls) ? pageData.html_photo_urls : [])
    .filter(isHttpUrl)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  const ordered = largestGroupInOrder(htmlUrls)
    .map((url, order) => ({ url, order, position: redfinPhotoPosition(urlBasename(url)) }))
    .sort((a, b) => {
      if (a.position === null && b.position === null) return a.order - b.order;
      if (a.position === null) return 1;
      if (b.position === null) return -1;
      return a.position - b.position || a.order - b.order;
    });
  return {
    photos: ordered.map((entry, index) =>
      normalizeRedfinPhoto(
        { photoUrls: { fullScreenPhotoUrl: entry.url }, fileName: urlBasename(entry.url) },
        index,
      ),
    ),
    source: ordered.length > 0 ? "html" : "none",
  };
}

/** Requested variant when Redfin published it, else the largest available one. */
export function selectRedfinPhotoUrl(photo, size) {
  const order = [size, ...REDFIN_PHOTO_SIZES.filter((candidate) => candidate !== size)];
  for (const candidate of order) {
    if (photo?.urls?.[candidate]) return { url: photo.urls[candidate], size: candidate };
  }
  return { url: "", size: "" };
}

/**
 * `01-ML82027150_2.jpg`: a zero-padded gallery position keeps files sorted the
 * way Redfin shows them, and the CDN base name keeps the MLS provenance. Sizes
 * other than `full` carry the size so variants of one photo never overwrite each
 * other in a shared folder.
 */
export function buildRedfinPhotoFilename({ url, index, total, size }) {
  const width = Math.max(2, String(Math.max(Number(total) || 0, Number(index) || 0)).length);
  const prefix = String(index).padStart(width, "0");
  const extension = (/\.([A-Za-z0-9]{2,5})$/.exec(urlBasename(url)) || [])[1] || "jpg";
  const base = sanitizeSegment(urlBasename(url)) || `photo.${extension.toLowerCase()}`;
  return size && size !== "full" ? `${prefix}-${size}-${base}` : `${prefix}-${base}`;
}

/** One download plan entry per photo: which URL to fetch and what to name it. */
export function planRedfinDownloads(photos, { size = "full", limit = 0 } = {}) {
  const selected = limit > 0 ? photos.slice(0, limit) : photos;
  const total = selected.length;
  return selected.map((photo, order) => {
    const index = order + 1;
    const chosen = selectRedfinPhotoUrl(photo, size);
    return {
      index,
      photo_id: photo.photo_id,
      caption: photo.caption,
      tags: photo.tags,
      source_width: photo.source_width,
      source_height: photo.source_height,
      size_variant: chosen.size,
      url: chosen.url,
      file_name: chosen.url
        ? buildRedfinPhotoFilename({ url: chosen.url, index, total, size: chosen.size })
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
export function summarizeRedfinDownload(item, result, { listing = {}, file = "" } = {}) {
  const success = result?.success === true;
  return {
    index: item.index,
    status: success ? "success" : "failed",
    size: success ? formatBytes(result.size) : "",
    bytes: success ? Number(result.size) || 0 : 0,
    file: success ? file : "",
    error: success ? "" : cleanText(result?.error) || "unknown error",
    photo_id: item.photo_id,
    caption: item.caption,
    tags: Array.isArray(item.tags) ? item.tags.join(", ") : "",
    source_width: item.source_width,
    source_height: item.source_height,
    size_variant: item.size_variant,
    url: item.url,
    address: listing.address || "",
    listing_url: listing.url || "",
  };
}

export function normalizePhotoRow(photo, listing, size) {
  const chosen = selectRedfinPhotoUrl(photo, size);
  return {
    index: photo.index,
    photo_id: photo.photo_id,
    caption: photo.caption,
    tags: photo.tags.join(", "),
    source_width: photo.source_width,
    source_height: photo.source_height,
    url: chosen.url,
    size_variant: chosen.size,
    thumbnail_url: photo.urls.thumb,
    full_url: photo.urls.full,
    long_caption: photo.long_caption,
    address: listing.address,
    listing_url: listing.url,
  };
}
