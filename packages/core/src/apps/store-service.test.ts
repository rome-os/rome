import { describe, expect, it, rs } from "@rstest/core";
import { createAppStoreService } from "./store-service.js";

describe("createAppStoreService", () => {
  it("uses the complete scoped listing id for installed-state lookup", async () => {
    const get = rs.fn(() => null);
    const service = createAppStoreService({
      fetch: rs.fn(async () =>
        Response.json({
          listings: [
            {
              id: "@foo/bar",
              handle: "foo",
              slug: "bar",
              name: "Bar",
              description: null,
              iconUrl: null,
              categories: [],
              installCount: 0,
              highestVersion: "1.0.0",
              verified: false,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          paging: { limit: 10, offset: 0, sort: "best" },
        }),
      ) as unknown as typeof fetch,
      browseOriginResolver: () => "https://store.example",
      fetchOriginResolver: () => "https://internal-store.example",
      appCatalog: { get },
    });

    const result = await service.listListings({ includeInstalledState: true });

    expect(get).toHaveBeenCalledWith("@foo/bar");
    expect(result.body.listings[0].installed?.appId).toBe("@foo/bar");
  });

  it("lists store listings and annotates installed state when requested", async () => {
    const fetchMock = rs.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(
          JSON.stringify({
            listings: [
              {
                id: "calendar",
                handle: "rome",
                slug: "calendar",
                name: "Calendar",
                description: "Calendar tools",
                iconUrl: null,
                categories: ["productivity"],
                installCount: 12,
                highestVersion: "1.0.0",
                verified: true,
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            paging: { limit: 10, offset: 0, sort: "best" },
          }),
          { status: 200 },
        ),
    );
    const service = createAppStoreService({
      fetch: fetchMock as unknown as typeof fetch,
      browseOriginResolver: () => "https://store.example",
      fetchOriginResolver: () => "https://internal-store.example",
      appCatalog: {
        get: () =>
          ({
            appId: "calendar",
            state: "installed",
            enabled: true,
            installedVersion: "1.0.0",
            source: { mode: "appstore" },
          }) as never,
      },
    });

    const result = await service.listListings({
      query: "calendar",
      sort: "best",
      limit: 10,
      includeInstalledState: true,
    });

    expect(result.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://internal-store.example/api/store/listings?sort=best&q=calendar&limit=10",
    );
    expect(result.body.listings[0].installed).toEqual({
      appId: "calendar",
      installed: true,
      phase: "installed",
      enabled: true,
      installedVersion: "1.0.0",
      sourceMode: "appstore",
    });
  });

  it("returns a clear 400 for invalid listing ids", async () => {
    const service = createAppStoreService({
      browseOriginResolver: () => "https://store.example",
      fetchOriginResolver: () => "https://internal-store.example",
    });

    const result = await service.getListing({ listingId: "not a valid id" });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Invalid App Store listing id");
  });

  it("normalizes sourceAvailable for current and legacy version responses", async () => {
    const fetchMock = rs.fn(
      async () =>
        new Response(
          JSON.stringify({
            listing: {
              id: "calendar",
              handle: "rome",
              slug: "calendar",
              highestVersion: "2.0.0",
            },
            versions: [
              {
                version: "2.0.0",
                contentHash: "a".repeat(64),
                sizeBytes: 200,
                sourceAvailable: true,
                state: "live",
                publishedAt: "2026-08-18T00:00:00.000Z",
              },
              {
                version: "1.0.0",
                contentHash: "b".repeat(64),
                sizeBytes: 100,
                state: "live",
                publishedAt: "2026-08-17T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const service = createAppStoreService({
      fetch: fetchMock as unknown as typeof fetch,
      browseOriginResolver: () => "https://store.example",
      fetchOriginResolver: () => "https://internal-store.example",
    });

    const result = await service.getListing({ listingId: "calendar" });

    expect(result.status).toBe(200);
    expect(result.body.versions?.map((version) => version.sourceAvailable)).toEqual([true, false]);
  });
});
