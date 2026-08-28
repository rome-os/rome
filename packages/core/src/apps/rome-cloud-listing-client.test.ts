import { describe, expect, it } from "@rstest/core";
import { createFetchRecorder } from "../test/kit/index.js";
import { createRomeCloudListingClient } from "./rome-cloud-listing-client.js";

// Both read paths are best-effort by contract: any miss (unconfigured origin,
// network failure, non-2xx, malformed body, non-live row) yields null, never a
// throw — the upgrade detector and installer degrade gracefully on a flaky or
// absent Rome Cloud.

const ORIGIN = "https://rome-cloud.example";
const DETAIL_URL = `${ORIGIN}/api/store/listings/xiaohongshu`;
const HASH = "a".repeat(64);

function makeClient(http: ReturnType<typeof createFetchRecorder>) {
  return createRomeCloudListingClient({
    fetch: http.fetch,
    registryOriginResolver: () => ORIGIN,
  });
}

// Null is the client's answer to *every* miss — including a URL typo in the
// test's own rule. Where the outcome alone can't tell those apart, prove the
// scripted rule is what answered.
function expectScriptedBranch(http: ReturnType<typeof createFetchRecorder>) {
  expect(http.calls).toHaveLength(1);
  expect(http.unmatched).toHaveLength(0);
}

describe("RomeCloudListingClient.getHighestVersion", () => {
  it("reads listing.highestVersion from the listing-detail endpoint", async () => {
    const http = createFetchRecorder();
    http.when("GET", DETAIL_URL).reply(200, { listing: { highestVersion: "1.4.0" } });

    expect(await makeClient(http).getHighestVersion("xiaohongshu")).toBe("1.4.0");
    expect(http.calls[0].headers.get("accept")).toBe("application/json");
  });

  it("addresses a scoped @handle/slug listing by its encoded path segment", async () => {
    const http = createFetchRecorder();
    http
      .when("GET", `${ORIGIN}/api/store/listings/@handle/slug`)
      .reply(200, { listing: { highestVersion: "2.0.0" } });

    expect(await makeClient(http).getHighestVersion("@handle/slug")).toBe("2.0.0");
  });

  it("returns null without fetching when the registry origin is not configured", async () => {
    const http = createFetchRecorder();
    const client = createRomeCloudListingClient({
      fetch: http.fetch,
      registryOriginResolver: () => null,
    });

    expect(await client.getHighestVersion("xiaohongshu")).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it("returns null on a non-2xx response", async () => {
    const http = createFetchRecorder();
    http.when("GET", DETAIL_URL).reply(404, { error: "not_found" });
    expect(await makeClient(http).getHighestVersion("xiaohongshu")).toBeNull();
    expectScriptedBranch(http);
  });

  it("returns null on a network failure", async () => {
    const http = createFetchRecorder();
    http.when("GET", DETAIL_URL).failWith(new Error("ECONNREFUSED"));
    expect(await makeClient(http).getHighestVersion("xiaohongshu")).toBeNull();
    expectScriptedBranch(http);
  });

  it("returns null on a non-JSON body", async () => {
    const http = createFetchRecorder();
    http.when("GET", DETAIL_URL).reply(200, "<html>gateway error</html>");
    expect(await makeClient(http).getHighestVersion("xiaohongshu")).toBeNull();
    expectScriptedBranch(http);
  });
});

describe("RomeCloudListingClient.getContentHash", () => {
  it("returns the lowercased hash of the matching live version row", async () => {
    const http = createFetchRecorder();
    http.when("GET", DETAIL_URL).reply(200, {
      versions: [
        { version: "1.0.0", state: "live", contentHash: "b".repeat(64) },
        { version: "1.1.0", state: "live", contentHash: HASH.toUpperCase() },
      ],
    });

    expect(await makeClient(http).getContentHash("xiaohongshu", "1.1.0")).toBe(HASH);
  });

  it("returns null when the matching row is not live", async () => {
    const http = createFetchRecorder();
    http.when("GET", DETAIL_URL).reply(200, {
      versions: [{ version: "1.1.0", state: "draft", contentHash: HASH }],
    });

    expect(await makeClient(http).getContentHash("xiaohongshu", "1.1.0")).toBeNull();
    expectScriptedBranch(http);
  });

  it("returns null when no row matches the requested version", async () => {
    const http = createFetchRecorder();
    http.when("GET", DETAIL_URL).reply(200, {
      versions: [{ version: "1.0.0", state: "live", contentHash: HASH }],
    });

    expect(await makeClient(http).getContentHash("xiaohongshu", "9.9.9")).toBeNull();
    expectScriptedBranch(http);
  });
});
