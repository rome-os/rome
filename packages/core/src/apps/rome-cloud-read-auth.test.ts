import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { setInstanceTokenInMemory } from "../lib/instance-identity.js";
import { createBundleFetcher } from "./bundle-fetcher.js";
import { withRomeCloudReadAuth } from "./rome-cloud-read-auth.js";

const CLOUD = "https://rome-cloud.example.com";

describe("withRomeCloudReadAuth", () => {
  const previousOrigin = process.env.PANTHEON_BASE_ORIGIN;
  beforeEach(() => {
    process.env.PANTHEON_BASE_ORIGIN = CLOUD;
    setInstanceTokenInMemory("romeinst_test-token");
  });
  afterEach(() => {
    setInstanceTokenInMemory(null);
    if (previousOrigin === undefined) delete process.env.PANTHEON_BASE_ORIGIN;
    else process.env.PANTHEON_BASE_ORIGIN = previousOrigin;
  });

  it("adds the instance token for the Rome Cloud origin", () => {
    expect(withRomeCloudReadAuth(new URL(`${CLOUD}/api/store/listings`), { accept: "x" })).toEqual({
      accept: "x",
      authorization: "Bearer romeinst_test-token",
    });
  });

  it("never sends the token to another origin", () => {
    expect(
      withRomeCloudReadAuth(new URL("https://elsewhere.example.com/api/store/listings"), {
        accept: "x",
      }),
    ).toEqual({ accept: "x" });
  });

  it("stays anonymous without a token", () => {
    setInstanceTokenInMemory(null);
    expect(withRomeCloudReadAuth(new URL(`${CLOUD}/api/store/listings`), {})).toEqual({});
  });

  it("authenticates bundle downloads so invite-only apps can install", async () => {
    const seen: Array<string | null> = [];
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => CLOUD,
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return new Response(Buffer.from("ok"), { status: 200 });
      },
    });
    await fetcher({
      mode: "appstore",
      listingId: "@ray/inbox",
      version: "1.0.0",
      contentHash: "0".repeat(64),
    });
    expect(seen).toEqual(["Bearer romeinst_test-token"]);
  });
});
