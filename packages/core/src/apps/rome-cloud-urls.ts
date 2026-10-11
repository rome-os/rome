/**
 * Rome Cloud URL construction helpers — shared by `bundle-fetcher` and
 * `rome-cloud-listing-client`. The canonical wire shape for an appstore source
 * carries a **logical** listing id (`xiaohongshu` or `@handle/slug`, grammar
 * in packaging/listing-id.ts); these helpers derive the bundle and
 * listing-detail URLs
 * from that id plus the configured Rome Cloud origin.
 *
 * Legacy lockfile entries written before this convention stored a full bundle
 * URL in `listingId`. `normalizeListingId` extracts the logical id from such
 * URLs so existing installs keep working without an on-disk migration.
 * `AppManager.install` rewrites the listingId on the next successful install.
 */
import { createLogger } from "../logger.js";
import { parseListingId, type ParsedListingId } from "@rome-os/app-runtime/packaging";

const log = createLogger("apps-rome-cloud-urls");

const LEGACY_BUNDLE_PATH_RE =
  /^(.*\/api\/store\/listings\/)(@[^/]+\/[^/]+|[^/@][^/]*)\/versions\/[^/]+\/bundle\/?$/;

const LEGACY_LISTING_DETAIL_PATH_RE = /^(.*\/api\/store\/listings\/)(@[^/]+\/[^/]+|[^/@][^/]*)\/?$/;

/**
 * Accepts either a logical listing id or a legacy full bundle URL and returns
 * the parsed logical id. Returns `null` when the input is neither a valid
 * logical id under the listing-id grammar nor a URL whose path carries one —
 * URL-shaped strings never fall through to the logical-id path, and an id
 * extracted from a URL is held to the same grammar as a directly-passed one.
 */
export function normalizeListingId(listingIdOrUrl: string): ParsedListingId | null {
  if (!listingIdOrUrl.includes("://")) {
    return parseListingId(listingIdOrUrl);
  }
  let parsed: URL;
  try {
    parsed = new URL(listingIdOrUrl);
  } catch {
    return null;
  }
  // Decode the pathname before regex matching so percent-encoded scoped
  // segments (e.g. `/listings/%40handle/slug/...` produced by older clients
  // that ran `encodeURIComponent("@handle")`) match the same path patterns
  // as their literal `@` counterparts. decodeURIComponent is safe to run
  // again inside `decodeListingPath` — it's a no-op on already-decoded text.
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    pathname = parsed.pathname;
  }
  const bundleMatch = LEGACY_BUNDLE_PATH_RE.exec(pathname);
  if (bundleMatch) {
    const decoded = decodeListingPath(bundleMatch[2]);
    if (decoded) {
      log.warn("normalized legacy bundle URL listingId", {
        listingIdOrUrl,
        normalized: decoded.id,
      });
      return decoded;
    }
  }
  const detailMatch = LEGACY_LISTING_DETAIL_PATH_RE.exec(pathname);
  if (detailMatch) {
    const decoded = decodeListingPath(detailMatch[2]);
    if (decoded) {
      log.warn("normalized legacy listing-detail URL listingId", {
        listingIdOrUrl,
        normalized: decoded.id,
      });
      return decoded;
    }
  }
  return null;
}

/**
 * Resolves the Rome Cloud bundle URL for `(listingId, version)`. Accepts both
 * the new logical id form and the legacy full-URL form via
 * `normalizeListingId`. Throws when the registry origin is not configured.
 */
export function resolveBundleUrl(
  listingIdOrUrl: string,
  version: string,
  resolveOrigin: () => string | null,
): URL {
  const normalized = normalizeListingId(listingIdOrUrl);
  if (normalized == null) {
    throw new Error(
      `AppstoreSource.listingId is neither a logical id nor a recognisable Rome Cloud URL: ${JSON.stringify(listingIdOrUrl)}`,
    );
  }
  const origin = resolveOrigin();
  if (!origin) {
    throw new Error(
      `Cannot resolve Rome Cloud bundle URL: registry origin is not configured. ` +
        `Set PANTHEON_BASE_ORIGIN, or pass an explicit ` +
        `registryOriginResolver.`,
    );
  }
  // The listing-id grammar admits only URL-safe characters, so the canonical
  // id doubles as the path segment with no further encoding.
  return new URL(
    `/api/store/listings/${normalized.id}/versions/${encodeURIComponent(version)}/bundle`,
    origin,
  );
}

/**
 * Resolves the Rome Cloud listing-detail URL for `listingId`. Same legacy
 * normalisation as `resolveBundleUrl`. Returns `null` when the input cannot
 * be normalised or the origin is not configured (callers want to skip the
 * lookup gracefully rather than throw — getHighestVersion / getContentHash
 * are best-effort).
 */
export function resolveListingDetailUrl(
  listingIdOrUrl: string,
  resolveOrigin: () => string | null,
): URL | null {
  const normalized = normalizeListingId(listingIdOrUrl);
  if (normalized == null) return null;
  const origin = resolveOrigin();
  if (!origin) return null;
  return new URL(`/api/store/listings/${normalized.id}`, origin);
}

/**
 * Decode one extracted URL path candidate and hold it to the listing-id
 * grammar. Per-half decoding tolerates older clients that percent-encoded
 * the handle and slug separately.
 */
function decodeListingPath(segment: string): ParsedListingId | null {
  if (segment.startsWith("@")) {
    const slashIdx = segment.indexOf("/");
    if (slashIdx < 0) return null;
    try {
      const handle = decodeURIComponent(segment.slice(1, slashIdx));
      const slug = decodeURIComponent(segment.slice(slashIdx + 1));
      return parseListingId(`@${handle}/${slug}`);
    } catch {
      return null;
    }
  }
  try {
    return parseListingId(decodeURIComponent(segment));
  } catch {
    return null;
  }
}
