/**
 * Query Rome Cloud's listing-detail endpoint by logical listing id
 * (`xiaohongshu` or `@handle/slug`). Two read paths:
 *
 *  - `getHighestVersion(listingId)` — drives the upgrade detector
 *    (`upgrade-detector.ts`) which compares Rome Cloud's `highestVersion`
 *    against the lockfile-installed version.
 *  - `getContentHash(listingId, version)` — resolves the authoritative
 *    sha256 for `AppstoreSource.contentHash` when the install caller omitted
 *    it. Installer pins the resolved hash via the lockfile's `installedHash`
 *    and (since manager.install normalises) also into `source.contentHash`.
 *
 * Both methods accept the legacy "listingId-as-bundle-URL" shape via
 * `normalizeListingId` so existing lockfile entries do not need an on-disk
 * migration.
 */
import { createLogger } from "../logger.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";
import { resolveListingDetailUrl } from "./rome-cloud-urls.js";
import { withRomeCloudReadAuth } from "./rome-cloud-read-auth.js";

const log = createLogger("apps-rome-cloud-listings");

export interface RomeCloudListingClient {
  /**
   * Returns the highest version Rome Cloud advertises for `listingId`, or
   * `null` on any failure (unconfigured origin, unrecognised id, network
   * error, non-2xx response, malformed body).
   */
  getHighestVersion(listingId: string): Promise<string | null>;
  /**
   * Returns the authoritative `contentHash` Rome Cloud recorded at publish time
   * for `(listingId, version)`, or `null` when the row is missing, not
   * `state: "live"`, or any transport-level failure. The installer uses this
   * when `AppstoreSource.contentHash` was omitted by the caller.
   */
  getContentHash(listingId: string, version: string): Promise<string | null>;
}

export interface CreateRomeCloudListingClientOptions {
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-call hard timeout. */
  timeoutMs?: number;
  /**
   * Resolves the Rome Cloud origin used to build the listing-detail URL.
   * Defaults to `getRomeCloudOrigin()`. Returning `null`
   * makes both read methods short-circuit to `null` (best-effort semantics).
   */
  registryOriginResolver?: () => string | null;
}

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export function createRomeCloudListingClient(
  opts: CreateRomeCloudListingClientOptions = {},
): RomeCloudListingClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const resolveOrigin = opts.registryOriginResolver ?? defaultRegistryOriginResolver;

  async function fetchListingDetail(listingId: string): Promise<Record<string, unknown> | null> {
    const detailUrl = resolveListingDetailUrl(listingId, resolveOrigin);
    if (!detailUrl) {
      log.debug("could not derive listing-detail URL; skipping", { listingId });
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(detailUrl, {
        headers: withRomeCloudReadAuth(detailUrl, { accept: "application/json" }),
        signal: controller.signal,
      });
    } catch (err) {
      log.debug("listing detail fetch failed", {
        listingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      log.debug("listing detail returned non-2xx", {
        listingId,
        status: response.status,
      });
      return null;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  }

  return {
    async getHighestVersion(listingId: string): Promise<string | null> {
      const body = await fetchListingDetail(listingId);
      if (body == null) return null;
      const version = extractHighestVersion(body);
      if (version == null) {
        log.debug("listing detail response missing highestVersion", { listingId });
      }
      return version;
    },

    async getContentHash(listingId: string, version: string): Promise<string | null> {
      const body = await fetchListingDetail(listingId);
      if (body == null) return null;
      const hash = extractContentHashForVersion(body, version);
      if (hash == null) {
        log.debug("listing detail missing contentHash for version", { listingId, version });
      }
      return hash;
    },
  };
}

function defaultRegistryOriginResolver(): string | null {
  return getRomeCloudOrigin();
}

function extractHighestVersion(body: Record<string, unknown>): string | null {
  const listing = body.listing;
  if (typeof listing !== "object" || listing === null) return null;
  const version = (listing as { highestVersion?: unknown }).highestVersion;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function extractContentHashForVersion(
  body: Record<string, unknown>,
  version: string,
): string | null {
  const versions = body.versions;
  if (!Array.isArray(versions)) return null;
  for (const row of versions) {
    if (typeof row !== "object" || row === null) continue;
    const rowVersion = (row as { version?: unknown }).version;
    if (rowVersion !== version) continue;
    const state = (row as { state?: unknown }).state;
    if (state !== "live") return null;
    const hash = (row as { contentHash?: unknown }).contentHash;
    return typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : null;
  }
  return null;
}
