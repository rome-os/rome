import type { AppCatalog } from "./catalog.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";
import { parseListingId } from "./packaging/index.js";

export interface AppStoreInstalledState {
  appId: string;
  installed: boolean;
  phase: "installed" | "failed" | "broken" | "installing" | "uninstalling" | null;
  enabled: boolean | null;
  installedVersion: string | null;
  sourceMode: "source" | "bundle" | "appstore" | null;
}

export interface AppStoreListing {
  id: string;
  handle: string;
  slug: string;
  name: string | null;
  description: string | null;
  /** Absolute icon URL persisted by the store (S3 object or the store's default icon). */
  iconUrl: string | null;
  /** @deprecated The store API never emitted this; kept so older callers still typecheck. */
  iconPath?: string | null;
  categories: string[];
  installCount: number;
  highestVersion: string;
  verified: boolean;
  updatedAt: string;
  installed?: AppStoreInstalledState;
}

export interface AppStoreVersion {
  version: string;
  contentHash: string;
  sizeBytes: number;
  sourceAvailable: boolean;
  state: "live" | "revoked";
  publishedAt: string;
}

export interface AppStoreListingsBody {
  available: boolean;
  reason?: string;
  error?: string;
  browseOrigin: string | null;
  listings: AppStoreListing[];
  paging?: { limit: number; offset: number; sort: string; q?: string };
}

export interface AppStoreListingDetailBody {
  available: boolean;
  reason?: string;
  error?: string;
  browseOrigin: string | null;
  listing?: AppStoreListing;
  versions?: AppStoreVersion[];
}

export interface AppStoreListParams {
  query?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  includeInstalledState?: boolean;
}

export interface AppStoreGetParams {
  listingId: string;
  includeInstalledState?: boolean;
}

export interface AppStoreServiceResult<T> {
  status: number;
  body: T;
}

export interface AppStoreReader {
  listListings(params?: AppStoreListParams): Promise<AppStoreServiceResult<AppStoreListingsBody>>;
  getListing(params: AppStoreGetParams): Promise<AppStoreServiceResult<AppStoreListingDetailBody>>;
}

export interface CreateAppStoreServiceOptions {
  appCatalog?: Pick<AppCatalog, "get">;
  fetch?: typeof fetch;
  browseOriginResolver?: () => string | null;
  fetchOriginResolver?: () => string | null;
}

interface RomeCloudListingsResponse {
  listings: AppStoreListing[];
  paging: { limit: number; offset: number; sort: string; q?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoreVersions(value: unknown): AppStoreVersion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map(
    (version) =>
      ({
        ...version,
        sourceAvailable: version.sourceAvailable === true,
      }) as unknown as AppStoreVersion,
  );
}

function defaultBrowseOriginResolver(): string | null {
  return getRomeCloudOrigin();
}

function defaultFetchOriginResolver(): string | null {
  return getRomeCloudOrigin();
}

function readErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Network error";
}

function listingAppId(listing: Pick<AppStoreListing, "id" | "slug">): string {
  const parsed = parseListingId(listing.id);
  if (parsed) return parsed.id;
  return listing.slug || listing.id;
}

function enrichListing(
  listing: AppStoreListing,
  appCatalog: Pick<AppCatalog, "get"> | undefined,
  includeInstalledState: boolean | undefined,
): AppStoreListing {
  if (!includeInstalledState) return listing;
  const appId = listingAppId(listing);
  const view = appCatalog?.get(appId);
  return {
    ...listing,
    installed: {
      appId,
      installed: view !== undefined,
      phase: view?.state ?? null,
      enabled: view?.enabled ?? null,
      installedVersion: view?.installedVersion ?? null,
      sourceMode: view?.source.mode ?? null,
    },
  };
}

function toListingDetailPath(listingId: string): string | null {
  const parsed = parseListingId(listingId);
  if (!parsed) return null;
  return `/api/store/listings/${parsed.id}`;
}

function maybeNumberParam(url: URL, name: string, value: number | undefined): void {
  if (value !== undefined) url.searchParams.set(name, String(value));
}

export function createAppStoreService(opts: CreateAppStoreServiceOptions = {}): AppStoreReader {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const resolveBrowseOrigin = opts.browseOriginResolver ?? defaultBrowseOriginResolver;
  const resolveFetchOrigin = opts.fetchOriginResolver ?? defaultFetchOriginResolver;

  return {
    async listListings(params: AppStoreListParams = {}) {
      const browseOrigin = resolveBrowseOrigin();
      const fetchOrigin = resolveFetchOrigin();
      if (!browseOrigin || !fetchOrigin) {
        return {
          status: 200,
          body: {
            available: false,
            reason: "Rome Cloud origin is not configured for this Rome instance.",
            listings: [],
            browseOrigin: null,
          },
        };
      }

      const url = new URL("/api/store/listings", fetchOrigin);
      if (params.sort) url.searchParams.set("sort", params.sort);
      if (params.query?.trim()) url.searchParams.set("q", params.query.trim());
      maybeNumberParam(url, "limit", params.limit);
      maybeNumberParam(url, "offset", params.offset);

      let upstream: Response;
      try {
        upstream = await fetchImpl(url, { headers: { accept: "application/json" } });
      } catch (err) {
        return {
          status: 502,
          body: {
            available: true,
            browseOrigin,
            listings: [],
            error: `Failed to reach Rome Cloud: ${readErrorMessage(err)}`,
          },
        };
      }
      if (!upstream.ok) {
        const body = await upstream.text().catch(() => "");
        return {
          status: 502,
          body: {
            available: true,
            browseOrigin,
            listings: [],
            error: `Rome Cloud ${upstream.status}: ${body || upstream.statusText}`,
          },
        };
      }

      const payload = (await upstream.json()) as RomeCloudListingsResponse;
      return {
        status: 200,
        body: {
          available: true,
          browseOrigin,
          listings: payload.listings.map((listing) =>
            enrichListing(listing, opts.appCatalog, params.includeInstalledState),
          ),
          paging: payload.paging,
        },
      };
    },

    async getListing(params: AppStoreGetParams) {
      const browseOrigin = resolveBrowseOrigin();
      const fetchOrigin = resolveFetchOrigin();
      if (!browseOrigin || !fetchOrigin) {
        return {
          status: 200,
          body: {
            available: false,
            reason: "Rome Cloud origin is not configured for this Rome instance.",
            browseOrigin: null,
          },
        };
      }

      const upstreamPath = toListingDetailPath(params.listingId);
      if (!upstreamPath) {
        return {
          status: 400,
          body: {
            available: true,
            browseOrigin,
            error: `Invalid App Store listing id: ${JSON.stringify(params.listingId)}`,
          },
        };
      }

      const url = new URL(upstreamPath, fetchOrigin);
      let upstream: Response;
      try {
        upstream = await fetchImpl(url, { headers: { accept: "application/json" } });
      } catch (err) {
        return {
          status: 502,
          body: {
            available: true,
            browseOrigin,
            error: `Failed to reach Rome Cloud: ${readErrorMessage(err)}`,
          },
        };
      }

      const body = await upstream.text();
      if (!upstream.ok) {
        // Callers read 404 as "no such listing". Rome Cloud answers that in
        // JSON, so a non-JSON 404 comes from a wrong origin, an edge, or a
        // missing route, and says nothing about the listing. A non-JSON body
        // is an error page, and the install dialog shows `error` as copy.
        const isJson = (upstream.headers.get("content-type") ?? "").includes("application/json");
        const listingNotFound = upstream.status === 404 && isJson;
        return {
          status: listingNotFound || upstream.status === 410 ? upstream.status : 502,
          body: {
            available: true,
            browseOrigin,
            error: isJson && body ? body : `Rome Cloud returned HTTP ${upstream.status}`,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return {
          status: 502,
          body: { available: true, browseOrigin, error: "Invalid response from Rome Cloud" },
        };
      }

      const parsedBody = isRecord(parsed) ? parsed : {};
      const listing = isRecord(parsedBody.listing)
        ? enrichListing(
            parsedBody.listing as unknown as AppStoreListing,
            opts.appCatalog,
            params.includeInstalledState,
          )
        : undefined;
      const versions = normalizeStoreVersions(parsedBody.versions);
      return {
        status: 200,
        body: {
          available: true,
          browseOrigin,
          ...parsedBody,
          ...(listing ? { listing } : {}),
          ...(versions ? { versions } : {}),
        } as AppStoreListingDetailBody,
      };
    },
  };
}
