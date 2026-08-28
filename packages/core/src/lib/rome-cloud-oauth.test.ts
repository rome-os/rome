import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { DrizzleDb } from "../db/index.js";
import { oauthPendingAttempts } from "../db/schema.js";
import { createTestDb } from "../test/helpers.js";
import { setInstanceTokenInMemory } from "./instance-identity.js";
import {
  createRomeCloudOAuthStartRedirect,
  createRomeCloudOAuthStartUrl,
  redeemRomeCloudOAuthHandoff,
} from "./rome-cloud-oauth.js";

describe("Rome Cloud OAuth brokering", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example";
    // The instance states its own origin authoritatively (no request inference),
    // so the broker callbackOrigin comes from config, not the incoming request.
    process.env.PANTHEON_INSTANCE_ORIGIN = "https://rome.local.test";
    delete process.env.PANTHEON_SLUG;
    setInstanceTokenInMemory(null);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    setInstanceTokenInMemory(null);
    rs.restoreAllMocks();
  });

  describe("createRomeCloudOAuthStartUrl", () => {
    it("is available, as a same-origin relative path", () => {
      const link = createRomeCloudOAuthStartUrl("github");
      expect(link.available).toBe(true);
      expect(link.connectUrl).toBe("/api/oauth/github/start");
    });

    it("is unavailable when Rome Cloud is not configured", () => {
      delete process.env.PANTHEON_BASE_ORIGIN;
      delete process.env.PANTHEON_DOMAIN;
      const link = createRomeCloudOAuthStartUrl("github");
      expect(link.available).toBe(false);
      expect(link.connectUrl).toBeNull();
    });
  });

  describe("createRomeCloudOAuthStartRedirect", () => {
    let db: DrizzleDb;
    let close: () => void;

    beforeEach(() => {
      ({ db, close } = createTestDb());
    });

    afterEach(() => close());

    it("targets /connections/:provider/authorize with no tenant", async () => {
      const url = await createRomeCloudOAuthStartRedirect(db, "github");
      const parsed = new URL(url);

      expect(parsed.pathname).toBe("/connections/github/authorize");
      expect(parsed.searchParams.has("tenant")).toBe(false);
      expect(parsed.searchParams.get("callbackOrigin")).toBe("https://rome.local.test");
      expect(parsed.searchParams.get("state")).toBeTruthy();
      expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
    });

    it("omits the reconnect flag for a plain connect", async () => {
      const url = await createRomeCloudOAuthStartRedirect(db, "github");
      expect(new URL(url).searchParams.has("reconnect")).toBe(false);
    });

    it("carries reconnect=1 through to the authorize URL when reconnecting", async () => {
      const url = await createRomeCloudOAuthStartRedirect(db, "github", { reconnect: true });
      expect(new URL(url).searchParams.get("reconnect")).toBe("1");
    });

    it("persists an empty tenant sentinel on the pending attempt", async () => {
      await createRomeCloudOAuthStartRedirect(db, "github");
      const [row] = await db.select().from(oauthPendingAttempts);
      expect(row.tenant).toBe("");
    });
  });

  describe("redeemRomeCloudOAuthHandoff", () => {
    let db: DrizzleDb;
    let close: () => void;

    beforeEach(() => {
      ({ db, close } = createTestDb());
    });

    afterEach(() => close());

    async function startState(): Promise<string> {
      const startUrl = await createRomeCloudOAuthStartRedirect(db, "github");
      return new URL(startUrl).searchParams.get("state")!;
    }

    function stubRedeemFetch() {
      const fetchMock = rs.fn(async (_input: unknown, _init?: { body?: string }) => {
        return new Response(
          JSON.stringify({ provider: "github", tokens: { accessToken: "tok" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      rs.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("refuses to redeem when the instance is not enrolled", async () => {
      const state = await startState();
      stubRedeemFetch();
      await expect(redeemRomeCloudOAuthHandoff(db, "handoff-code", state)).rejects.toThrow(
        /not enrolled/i,
      );
    });

    it("surfaces the broker's error_description over the bare OAuth error code", async () => {
      setInstanceTokenInMemory("romeinst_test-token");
      const state = await startState();
      rs.stubGlobal(
        "fetch",
        rs.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "This sign-in link expired before Rome could redeem it.",
              }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            ),
        ),
      );

      await expect(redeemRomeCloudOAuthHandoff(db, "handoff-code", state)).rejects.toThrow(
        /expired before Rome could redeem/i,
      );
    });

    it("falls back to the bare OAuth error code when the broker sends no description", async () => {
      setInstanceTokenInMemory("romeinst_test-token");
      const state = await startState();
      rs.stubGlobal(
        "fetch",
        rs.fn(
          async () =>
            new Response(JSON.stringify({ error: "invalid_grant" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );

      await expect(redeemRomeCloudOAuthHandoff(db, "handoff-code", state)).rejects.toThrow(
        "invalid_grant",
      );
    });

    it("POSTs an RFC 8693 token-exchange to /connections/token with the instance bearer", async () => {
      setInstanceTokenInMemory("romeinst_test-token");
      const state = await startState();
      const fetchMock = stubRedeemFetch();

      await redeemRomeCloudOAuthHandoff(db, "handoff-code", state);

      const [input, init] = fetchMock.mock.calls[0] as [
        URL,
        { headers: Record<string, string>; body: string },
      ];
      expect(String(input)).toBe("https://rome-cloud.example/connections/token");
      expect(init.headers.Authorization).toBe("Bearer romeinst_test-token");

      const body = JSON.parse(init.body);
      expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
      expect(body.subject_token).toBe("handoff-code");
      expect(body.code_verifier).toBeTruthy();
      expect(body).not.toHaveProperty("tenant");
    });
  });
});
