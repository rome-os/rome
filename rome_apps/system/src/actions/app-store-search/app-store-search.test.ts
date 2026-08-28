import { describe, expect, it, rs } from "@rstest/core";
import type { AppStoreReader } from "../app-store-common.js";
import { appStoreSearch } from "./index.js";

function makeStore(): AppStoreReader {
  return {
    listListings: rs.fn(async () => ({
      status: 200,
      body: {
        available: true,
        browseOrigin: "https://store.example",
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
            installed: {
              appId: "calendar",
              installed: false,
              phase: null,
              enabled: null,
              installedVersion: null,
              sourceMode: null,
            },
          },
        ],
      },
    })),
    getListing: rs.fn(async () => ({
      status: 200,
      body: {
        available: true,
        browseOrigin: "https://store.example",
        listing: {
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
        versions: [],
      },
    })),
  };
}

describe("appStoreSearch", () => {
  it("searches the Rome App Store with installed state enabled by default", async () => {
    const appStore = makeStore();

    const result = await appStoreSearch(
      { op: "search", query: "calendar", limit: 5, offset: 0, includeInstalledState: true },
      { appStore },
    );

    expect(result.status).toBe("ok");
    expect(appStore.listListings).toHaveBeenCalledWith({
      query: "calendar",
      sort: undefined,
      limit: 5,
      offset: 0,
      includeInstalledState: true,
    });
  });

  it("reads one listing by logical listing id", async () => {
    const appStore = makeStore();

    const result = await appStoreSearch(
      {
        op: "get",
        query: "",
        listingId: "@rome/calendar",
        limit: 10,
        offset: 0,
        includeInstalledState: true,
      },
      { appStore },
    );

    expect(result.status).toBe("ok");
    expect(appStore.getListing).toHaveBeenCalledWith({
      listingId: "@rome/calendar",
      includeInstalledState: true,
    });
  });

  it("returns an action error when op=get omits listingId", async () => {
    const result = await appStoreSearch(
      { op: "get", query: "", limit: 10, offset: 0, includeInstalledState: true },
      { appStore: makeStore() },
    );

    expect(result).toEqual({ status: "error", error: "listingId is required when op='get'." });
  });
});
