import { describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { integrationsRoutes } from "./integrations.js";
import type { ApiDeps } from "../deps.js";

const CREDENTIAL = {
  drainUrl: "wss://relay.example/c/mb1",
  drainKey: "secret-key",
  depositUrl: "https://relay.example/h/mb1",
};

/** Minimal deps for the relay status read: settings get, app catalog, live drainer. */
function relayDeps(): ApiDeps {
  return {
    settingsRepo: { get: async () => CREDENTIAL },
    appCatalog: {
      listResolved: () => [{ appId: "connector", api: { relayWebhook: "webhook" } }],
    },
    relayDrainer: {
      getStatus: () => [
        {
          targetAppId: "connector",
          targetPath: ["webhook"],
          connected: true,
          lastTransportError: null,
          connectedSince: 1_000,
          nextReconnectAt: null,
          backlog: 4,
          lastEventAt: 2_000,
          deliveredCount: 3,
          retry: null,
          blocked: null,
          lastDeliveryFailure: { seq: 4, status: 503, error: null },
        },
      ],
    },
  } as unknown as ApiDeps;
}

describe("GET /integrations/relay", () => {
  it("returns the relay health alone, never the drain key", async () => {
    const app = new Hono().route("/", integrationsRoutes(relayDeps()));
    const res = await app.request("/integrations/relay");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      relay: {
        configured: true,
        drainUrl: "wss://relay.example/c/mb1",
        depositUrl: "https://relay.example/h/mb1",
        targetApp: "connector",
        state: "connected",
        backlog: 4,
        nextAttemptAt: null,
        failure: { seq: 4, status: 503, error: null },
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret-key");
  });
});

describe("POST /integrations/relay/resume", () => {
  it("re-arms a blocked delivery behind the same-origin guard", async () => {
    let calls = 0;
    const deps = relayDeps();
    (deps.relayDrainer as unknown as { resumeBlocked: () => boolean }).resumeBlocked = () => {
      calls++;
      return true;
    };
    const app = new Hono().route("/", integrationsRoutes(deps));

    const res = await app.request("/integrations/relay/resume", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    expect((await res.json()).resumed).toBe(true);
  });

  it("rejects cross-site resume attempts", async () => {
    const app = new Hono().route("/", integrationsRoutes(relayDeps()));
    const res = await app.request("/integrations/relay/resume", { method: "POST" });

    expect(res.status).toBe(403);
  });
});

// The legacy `POST /integrations/:provider/reconnect` was removed in #1611 —
// reconnect now re-runs the conferral setup (force-start), so there is
// no bespoke reconnect route to test here anymore.

describe("PUT /integrations/relay", () => {
  it("persists the drain URL with the entire query stripped (no param is assumed non-secret)", async () => {
    const saved: Record<string, unknown> = {};
    const deps = {
      settingsRepo: {
        get: async () => undefined,
        set: async (key: string, value: unknown) => {
          saved[key] = value;
        },
      },
      appCatalog: { listResolved: () => [] },
    } as unknown as ApiDeps;
    const app = new Hono().route("/", integrationsRoutes(deps));

    const res = await app.request("/integrations/relay", {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        drainUrl: "wss://relay.example/c/mb1?region=us&t=pasted-secret",
        drainKey: "secret-key",
      }),
    });

    expect(res.status).toBe(200);
    expect(saved.relay).toMatchObject({
      drainUrl: "wss://relay.example/c/mb1",
      drainKey: "secret-key",
      depositUrl: "https://relay.example/h/mb1",
    });
  });
});
