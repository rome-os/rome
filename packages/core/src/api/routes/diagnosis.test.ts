import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { diagnosisRoutes } from "./diagnosis.js";
import { setInstanceTokenInMemory } from "../../lib/instance-identity.js";

type DiagnosisDeps = Parameters<typeof diagnosisRoutes>[0];

function buildDeps(
  overrides: {
    settingsGet?: () => Promise<unknown>;
    settingsByKey?: (key: string) => Promise<unknown>;
    channels?: string[];
    apps?: Array<{ appId: string; state: string }>;
    bootVersionReport?: { upgradedSinceLastBoot: boolean; previousVersion: string | null };
  } = {},
): DiagnosisDeps {
  return {
    settingsRepo: {
      get: overrides.settingsByKey ?? overrides.settingsGet ?? (async () => null),
    },
    talkRouter: {
      list: () =>
        (overrides.channels ?? []).map((service) => ({
          connectionId: `connection:${service}`,
          service,
        })),
    },
    appCatalog: {
      list: () => overrides.apps ?? [],
    },
    bootVersionReport: overrides.bootVersionReport ?? {
      upgradedSinceLastBoot: false,
      previousVersion: null,
    },
  } as unknown as DiagnosisDeps;
}

function mount(deps: DiagnosisDeps): Hono {
  return new Hono().route("/", diagnosisRoutes(deps));
}

describe("GET /diagnosis", () => {
  const ROME_CLOUD_ENV = ["PANTHEON_BASE_ORIGIN", "PANTHEON_DOMAIN"];
  const savedRomeCloudEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // No instance token cached → proveIdentity short-circuits to "no_token"
    // with no network call, the expected non-error state.
    setInstanceTokenInMemory(null);
    for (const key of ROME_CLOUD_ENV) savedRomeCloudEnv[key] = process.env[key];
  });

  afterEach(() => {
    setInstanceTokenInMemory(null);
    for (const key of ROME_CLOUD_ENV) {
      if (savedRomeCloudEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedRomeCloudEnv[key];
    }
  });

  it("reports status ok for a reachable DB, no enrolled token, and no failed apps", async () => {
    const app = mount(
      buildDeps({
        channels: ["telegram", "webchat"],
        apps: [
          { appId: "system", state: "installed" },
          { appId: "notes", state: "installed" },
        ],
      }),
    );

    const res = await app.request("/diagnosis");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      instance: { auth: "no_token" },
      database: { ok: true },
      relay: { configured: false, depositUrlConfigured: false },
      channels: ["telegram", "webchat"],
      apps: { total: 2, failed: [], broken: [] },
    });
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.checkedAt).toBe("string");
  });

  it("reports whether a configured relay has a deposit URL", async () => {
    const withDeposit = await (
      await mount(
        buildDeps({
          settingsByKey: async (key) =>
            key === "relay"
              ? {
                  drainUrl: "wss://relay.example/c/mailbox",
                  drainKey: "secret",
                  depositUrl: "https://relay.example/h/mailbox",
                }
              : null,
        }),
      ).request("/diagnosis")
    ).json();

    expect(withDeposit.relay).toEqual({ configured: true, depositUrlConfigured: true });

    const withoutDeposit = await (
      await mount(
        buildDeps({
          settingsByKey: async (key) =>
            key === "relay"
              ? {
                  drainUrl: "wss://relay.example/c/mailbox",
                  drainKey: "secret",
                }
              : null,
        }),
      ).request("/diagnosis")
    ).json();

    expect(withoutDeposit.relay).toEqual({ configured: true, depositUrlConfigured: false });
  });

  it("reports auth:unconfigured when a token is present but no Rome Cloud origin is configured", async () => {
    // A source/dev build can carry a token with no Rome Cloud to present it to:
    // proveIdentity returns "unconfigured" (no network call), and the route
    // surfaces that status verbatim.
    setInstanceTokenInMemory("romeinst_devtoken");
    for (const key of ROME_CLOUD_ENV) delete process.env[key];

    const body = await (await mount(buildDeps()).request("/diagnosis")).json();

    expect(body.instance).toMatchObject({ auth: "unconfigured" });
  });

  it("reports degraded and names apps stuck in failed or broken state", async () => {
    const body = await (
      await mount(
        buildDeps({
          apps: [
            { appId: "system", state: "installed" },
            { appId: "calendar", state: "failed" },
            { appId: "weather", state: "broken" },
          ],
        }),
      ).request("/diagnosis")
    ).json();

    expect(body.status).toBe("degraded");
    expect(body.apps).toMatchObject({
      total: 3,
      failed: ["calendar"],
      broken: ["weather"],
    });
  });

  it("reports degraded when the database is unreachable, without leaking the driver error", async () => {
    const body = await (
      await mount(
        buildDeps({
          settingsGet: async () => {
            // A real driver error often embeds the SQLite path or a Postgres
            // connection string — none of it may reach the response body.
            throw new Error("SQLITE_CANTOPEN: /Users/secret/.rome/prod/rome.db");
          },
        }),
      ).request("/diagnosis")
    ).json();

    expect(body.status).toBe("degraded");
    expect(body.database).toEqual({ ok: false });
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
