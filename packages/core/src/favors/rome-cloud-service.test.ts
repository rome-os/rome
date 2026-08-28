import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ResolvedApp } from "../apps/state.js";
import { setInstanceTokenInMemory } from "../lib/instance-identity.js";
import { RomeCloudFavorService } from "./rome-cloud-service.js";
import type { FavorActionRequestView } from "./types.js";

const ENV_KEYS = ["PANTHEON_BASE_ORIGIN", "PANTHEON_DOMAIN", "PANTHEON_INSTANCE_ORIGIN"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("RomeCloudFavorService", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setInstanceTokenInMemory(null);
    rs.restoreAllMocks();
  });

  it("forwards the Rome Cloud-issued viewer token when creating a favor action request", async () => {
    process.env.PANTHEON_BASE_ORIGIN = "http://rome-cloud.test";
    setInstanceTokenInMemory("romeinst_test-token");

    let postedBody: Record<string, unknown> | null = null;
    const fetchImpl = rs.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      expect(String(input)).toBe("http://rome-cloud.test/api/favors/action-requests");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer romeinst_test-token");
      return Response.json({
        status: "pending_consent",
        request: favorRequestView(),
      });
    });

    const service = new RomeCloudFavorService(fetchImpl);
    const result = await service.requestAction({
      app: resolvedApp(),
      viewer: {
        accountId: "payer-1",
        email: "payer@example.test",
        favorViewerToken: "favor-viewer-token",
      },
      actionName: "ship",
      args: { packageId: "pkg-1" },
      idempotencyKey: "idem-1",
    });

    expect(result.status).toBe("pending_consent");
    expect(postedBody).toMatchObject({
      requesterAppId: "trusted-app",
      actionName: "ship",
      payerToken: "favor-viewer-token",
      idempotencyKey: "idem-1",
    });
  });

  it("does not create a request when the visitor session lacks a favor viewer token", async () => {
    const fetchImpl = rs.fn<typeof fetch>();
    const service = new RomeCloudFavorService(fetchImpl);

    const result = await service.requestAction({
      app: resolvedApp(),
      viewer: { accountId: "payer-1", email: "payer@example.test" },
      actionName: "ship",
      args: { packageId: "pkg-1" },
      idempotencyKey: "idem-1",
    });

    expect(result).toEqual({ status: "error", error: "visitor_favor_auth_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("payer return_to on the authorization URL", () => {
    function pendingConsentService(): RomeCloudFavorService {
      process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.test";
      process.env.PANTHEON_INSTANCE_ORIGIN = "https://guardian.rome.test";
      setInstanceTokenInMemory("romeinst_test-token");
      return new RomeCloudFavorService(
        rs.fn(async () =>
          Response.json({ status: "pending_consent", request: favorRequestView() }),
        ) as unknown as typeof fetch,
      );
    }

    async function authorizationReturnTo(returnTo?: string): Promise<string | null> {
      const result = await pendingConsentService().requestAction({
        app: resolvedApp(),
        viewer: {
          accountId: "payer-1",
          email: "payer@example.test",
          favorViewerToken: "favor-viewer-token",
        },
        actionName: "ship",
        args: { packageId: "pkg-1" },
        idempotencyKey: "idem-1",
        ...(returnTo === undefined ? {} : { returnTo }),
      });
      expect(result.status).toBe("pending_consent");
      if (result.status !== "pending_consent") throw new Error("unreachable");
      return new URL(result.authorizationUrl).searchParams.get("return_to");
    }

    it("sends app payers back to the app root by default, not the guardian dashboard", async () => {
      expect(await authorizationReturnTo()).toBe("https://guardian.rome.test/apps/trusted-app");
    });

    it("honors an app-suggested page inside the app's own prefix", async () => {
      expect(await authorizationReturnTo("/apps/trusted-app/checkout?step=2")).toBe(
        "https://guardian.rome.test/apps/trusted-app/checkout?step=2",
      );
    });

    it.each([
      ["guardian-only dashboard path", "/dashboard/settings/favors"],
      ["another app's page", "/apps/other-app"],
      ["prefix-lookalike path", "/apps/trusted-app-evil"],
      ["protocol-relative url", "//evil.test/apps/trusted-app"],
      ["absolute url on a foreign origin", "https://evil.test/apps/trusted-app"],
    ])("falls back to the app root for %s", async (_label, returnTo) => {
      expect(await authorizationReturnTo(returnTo)).toBe(
        "https://guardian.rome.test/apps/trusted-app",
      );
    });

    it("keeps the guardian dashboard return_to for dashboard-resolved requests", async () => {
      const service = pendingConsentService();
      const { authorizationUrl } = await service.resolveActionRequest("favor-1", "pay");
      expect(new URL(authorizationUrl).searchParams.get("return_to")).toBe(
        "https://guardian.rome.test/dashboard/settings/favors",
      );
    });
  });
});

function resolvedApp(): ResolvedApp {
  return {
    appId: "trusted-app",
    displayName: "Trusted App",
    source: "local",
    installedHash: "hash-1",
    installedVersion: "1.0.0",
    firstParty: false,
    manifest: {
      id: "trusted.manifest",
      version: "1.0.0",
    },
  } as unknown as ResolvedApp;
}

function favorRequestView(): FavorActionRequestView {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "favor-1",
    payerUserId: "payer-1",
    requestorUserId: "owner-1",
    recipientUserId: "owner-1",
    requesterInstanceId: "instance-1",
    requesterAppId: "trusted-app",
    requesterAppIdentity: {},
    actionName: "ship",
    definitionHash: "definition-hash",
    actionRefHash: "action-ref-hash",
    amount: 5,
    displayPayload: {},
    attribution: {},
    taskRef: null,
    status: "pending",
    dispatchStatus: "blocked",
    dispatchAttemptCount: 0,
    dispatchClaimExpiresAt: null,
    idempotencyKey: "idem-1",
    failureReason: null,
    createdAt: now,
    expiresAt: now,
    decidedAt: null,
    settledAt: null,
    queuedAt: null,
    dispatchedAt: null,
    completedAt: null,
    updatedAt: now,
  };
}
