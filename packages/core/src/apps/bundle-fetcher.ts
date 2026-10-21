/**
 * Fetch an app-store bundle's bytes for AppInstaller.
 *
 * `AppstoreSource.listingId` is the **logical** Rome Cloud listing id (`xiaohongshu`
 * or `@handle/slug`). The fetcher resolves the bundle URL from
 * `(listingId, version)` against the configured Rome Cloud origin.
 *
 * For backward-compat with lockfile entries written before this convention
 * change, a `listingId` that looks like a full http(s) URL is still accepted:
 * `normalizeListingId` extracts the logical id from the URL path, and
 * `resolveBundleUrl` re-derives the bundle URL from the configured registry
 * origin — the legacy URL's origin is **discarded**, not preserved. The
 * daemon emits a warn log so operators can spot legacy entries; on the next
 * successful install, `AppManager.install` rewrites the listingId in the
 * lockfile (see manager.ts).
 */
import { createLogger } from "../logger.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";
import type { BundleFetcher } from "./store-bundle.js";
import { resolveBundleUrl } from "./rome-cloud-urls.js";
import { withRomeCloudReadAuth } from "./rome-cloud-read-auth.js";

const log = createLogger("apps-bundle-fetcher");

/** Hard cap on a single bundle fetch. Bundle install is interactive — long enough not to flake on a slow link, short enough to fail loudly. */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

export interface CreateBundleFetcherOptions {
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Resolves the Rome Cloud origin used to build the bundle URL. Defaults to
   * `getRomeCloudOrigin()`. Returning `null` causes
   * appstore installs to fail with a clear "origin not configured" error.
   */
  registryOriginResolver?: () => string | null;
}

export function createBundleFetcher(opts: CreateBundleFetcherOptions = {}): BundleFetcher {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const resolveOrigin = opts.registryOriginResolver ?? defaultRegistryOriginResolver;

  return async function defaultBundleFetcher(source) {
    const url = resolveBundleUrl(source.listingId, source.version, resolveOrigin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: withRomeCloudReadAuth(url, {
          accept: "application/gzip, application/octet-stream",
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `Bundle fetch for "${source.listingId}@${source.version}" timed out after ${timeoutMs}ms`,
        );
      }
      throw new Error(
        `Bundle fetch for "${source.listingId}@${source.version}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Bundle fetch for "${source.listingId}@${source.version}" returned HTTP ${response.status}: ${
          body || response.statusText
        }`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    log.debug("fetched bundle", {
      listingId: source.listingId,
      version: source.version,
      bytes: buffer.length,
    });
    return buffer;
  };
}

function defaultRegistryOriginResolver(): string | null {
  return getRomeCloudOrigin();
}
