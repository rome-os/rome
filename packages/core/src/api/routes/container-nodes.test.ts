import { loginDeviceCode } from "@rome-os/node-core/host";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import {
  COOKIE_NAME,
  createSession,
  createVisitorSession,
  VISITOR_COOKIE_NAME,
} from "../../access/auth.js";
import { createCloudGuardian } from "../../access/guardian-auth-state.js";
import { guardianAuth } from "../../db/schema.js";
import { createTestDb } from "../../test/db.js";
import { containerNodesRoutes } from "./container-nodes.js";

const path = "/api/devices/container-nodes";
const owner = "cloud-owner";
const origin = "https://cloud.example";
const deviceId = "28f6417c-1167-4f52-9d25-e28d07804a78";
const deviceToken = `romedev_${"A".repeat(43)}`;
const deviceCode = "private-device-code";
const image = `ghcr.io/rome-os/rome-node@sha256:${"a".repeat(64)}`;
const guardianCookie = (userId = owner) => `${COOKIE_NAME}=${createSession(userId)}`;

describe("container node device authorization", () => {
  let db: ReturnType<typeof createTestDb>;
  let app: Hono;
  let createApp: (image?: string) => Hono;
  let cloudAccount: string;
  let authorized: boolean;
  let approved: boolean;
  let listAvailable: boolean;
  let tokenRequests: number;
  let authorizationSignal: AbortSignal | undefined;

  beforeEach(async () => {
    db = createTestDb();
    await createCloudGuardian(db.db, owner);
    cloudAccount = owner;
    authorized = true;
    approved = true;
    listAvailable = true;
    tokenRequests = 0;
    authorizationSignal = undefined;
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.origin).toBe(origin);
      switch (url.pathname) {
        case "/oauth2/device_authorization": {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("rome-computer");
          expect(body.get("display_name")).toBe("NAS");
          return Response.json({
            device_code: deviceCode,
            user_code: "ABCD-EFGH",
            verification_uri: `${origin}/activate`,
            verification_uri_complete: `${origin}/activate?user_code=ABCD-EFGH`,
            expires_in: 5,
            interval: 1,
          });
        }
        case "/oauth2/token": {
          tokenRequests++;
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("device_code")).toBe(deviceCode);
          expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
          return approved
            ? Response.json({
                device_id: deviceId,
                access_token: deviceToken,
                token_type: "Bearer",
              })
            : Response.json({ error: "access_denied" }, { status: 400 });
        }
        default:
          throw new Error("Unexpected Cloud path");
      }
    });
    const nodeDevices = {
      listDevices: async () =>
        listAvailable
          ? { devices: authorized ? [{ id: deviceId, name: "NAS", platform: "linux" }] : [] }
          : null,
    };
    createApp = (image) =>
      new Hono().route(
        path,
        containerNodesRoutes({ db: db.db, nodeDevices }, image, {
          origin: () => origin,
          prove: async () => ({
            status: "ok",
            identity: { instanceId: "test-instance", accountId: cloudAccount },
          }),
          login(origin, name, signal, onPrompt) {
            authorizationSignal = signal;
            return loginDeviceCode(origin, name, signal, onPrompt);
          },
        }),
      );
    app = createApp(image);
  });

  afterEach(() => {
    db.close();
    rs.restoreAllMocks();
  });

  const post = (cookie = guardianCookie(), requestOrigin = "http://localhost") =>
    app.request(path, {
      method: "POST",
      headers: { Cookie: cookie, Origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ name: " NAS " }),
    });

  it("requires the guardian cookie, same origin and the authenticated Cloud account", async () => {
    expect((await post("")).status).toBe(403);
    expect((await post(guardianCookie("former-owner"))).status).toBe(403);
    const visitor = `${VISITOR_COOKIE_NAME}=${createVisitorSession(owner, "owner@example.com")}`;
    expect((await post(visitor)).status).toBe(403);
    expect((await post(guardianCookie(), "https://another.example")).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();

    cloudAccount = "different-account";
    expect((await post()).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps setup disabled until an image is configured", async () => {
    app = createApp();
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an unlinked owner as not configured", async () => {
    await db.db.update(guardianAuth).set({ accountId: null });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not start approval when the Cloud device list is unavailable", async () => {
    listAvailable = false;
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("streams the approval link and then the account device token without caching either", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    const prompt = new TextDecoder().decode((await reader.read()).value);
    expect(prompt).toContain("event: authorization");
    expect(prompt).toContain("ABCD-EFGH");
    expect(prompt).not.toContain(deviceCode);
    expect(prompt).not.toContain(deviceToken);
    const result = new TextDecoder().decode((await reader.read()).value);
    expect(result).toContain("event: credential");
    expect(JSON.parse(result.split("data: ")[1])).toEqual({ deviceId, deviceToken, origin });
    expect((await reader.read()).done).toBe(true);
  });

  it.each([
    { authorized: false, approved: true, code: "approval_account_mismatch" },
    { authorized: true, approved: false, code: "authorization_failed" },
  ])("keeps the token out of failure responses for $code", async (scenario) => {
    ({ authorized, approved } = scenario);
    const response = await post();
    const body = await response.text();
    expect(body).toContain("event: authorization_error");
    expect(body).toContain(scenario.code);
    expect(body).not.toContain(deviceToken);
  });

  it("cancels polling when the browser closes the stream", async () => {
    const response = await post();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(authorizationSignal?.aborted).toBe(true);
    expect(tokenRequests).toBe(0);
  });
});
