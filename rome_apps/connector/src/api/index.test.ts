import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sign } from "@octokit/webhooks-methods";
import type { AppDbContext, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as composioClientModule from "./composio-client.js" with { rstest: "importActual" };
import * as composioLoginModule from "./composio-login.js" with { rstest: "importActual" };
import * as composioWebhookModule from "./composio-webhook.js" with { rstest: "importActual" };

const mocks = rs.hoisted(() => ({
  ensureWebhookRegistered: rs.fn(),
  readSessionApiKey: rs.fn(),
  completeCliLogin: rs.fn(),
  settings: { get: rs.fn(), set: rs.fn(), delete: rs.fn() },
  client: {
    ensureAuthConfig: rs.fn(),
    ensureConnection: rs.fn(),
    listConnectedAccounts: rs.fn(),
    ping: rs.fn(),
    webhookSubscriptionExists: rs.fn(),
  },
}));

rs.mock("./composio-login.js", () => ({
  ...composioLoginModule,
  readSessionApiKey: mocks.readSessionApiKey,
  completeCliLogin: mocks.completeCliLogin,
}));

rs.mock("./settings-store.js", () => ({
  SettingsStore: class {
    constructor() {
      return mocks.settings;
    }
  },
}));

rs.mock("./composio-webhook.js", () => ({
  ...composioWebhookModule,
  ensureComposioWebhookRegistered: mocks.ensureWebhookRegistered,
}));

rs.mock("./composio-client.js", () => {
  return {
    ...composioClientModule,
    ComposioClient: class {
      constructor() {
        return mocks.client;
      }
    },
  };
});

import { createApiHandler } from "./index.js";

function context(): RomeAppContext {
  return {
    app: { version: "1.0.0" },
    db: {},
    repositories: {
      settings: { get: async () => ({ depositUrl: "https://relay.example/h/mailbox" }) },
    },
    log: { warn: rs.fn(), error: rs.fn(), info: rs.fn() },
  } as unknown as RomeAppContext;
}

function request(path: string, method = "GET", body?: object): RomeAppApiRequest {
  return {
    path: path.split("/"),
    method,
    headers: { host: "rome.test" },
    body: body ? new TextEncoder().encode(JSON.stringify(body)) : undefined,
  } as unknown as RomeAppApiRequest;
}

function rejectedCredential(): Error {
  return Object.assign(new Error("Invalid or revoked user API key"), { status: 401 });
}

describe("connector authentication recovery", () => {
  beforeEach(() => {
    rs.resetAllMocks();
    mocks.readSessionApiKey.mockResolvedValue("uak_test");
    mocks.completeCliLogin.mockResolvedValue("uak_new");
    mocks.settings.get.mockResolvedValue(null);
    mocks.client.ping.mockResolvedValue({ ok: true });
  });

  it("keeps status local and treats hasKey only as credential presence", async () => {
    const response = await createApiHandler(context()).handle(request("status"));

    await expect(response.json()).resolves.toMatchObject({
      hasKey: true,
      webhookRegistered: false,
    });
    expect(mocks.client.ping).not.toHaveBeenCalled();
    expect(mocks.client.listConnectedAccounts).not.toHaveBeenCalled();
  });

  it("returns a reauthorization error when the SDK rejects the saved key while listing connectors", async () => {
    mocks.client.listConnectedAccounts.mockRejectedValue(rejectedCredential());

    const response = await createApiHandler(context()).handle(request("connectors"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "composio_unauthenticated",
      message: "Composio authorization is no longer valid. Sign in again.",
    });
    expect(mocks.settings.delete).not.toHaveBeenCalled();
  });

  it.each([
    "webhook/register",
    "feeds",
    "connectors",
  ])("returns reauthorization from %s when webhook recovery rejects the key", async (path) => {
    mocks.ensureWebhookRegistered.mockRejectedValue(rejectedCredential());

    const response = await createApiHandler(context()).handle(
      request(path, "POST", {
        provider: "notion",
        triggerSlug: "NOTION_NEW_PAGE",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "composio_unauthenticated" });
    expect(mocks.client.ensureAuthConfig).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500])("does not require a new login for webhook HTTP %i", async (status) => {
    mocks.ensureWebhookRegistered.mockRejectedValue(
      Object.assign(new Error("Try again"), { status }),
    );

    const response = await createApiHandler(context()).handle(request("webhook/register", "POST"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: "webhook_registration_failed" });
  });

  it("does not report successful login when the issued key fails validation", async () => {
    mocks.client.ping.mockResolvedValue({ ok: false, status: 401, message: "upstream JSON" });

    const response = await createApiHandler(context()).handle(
      request("login/complete", "POST", { cliKey: "cli_test_session" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "composio_unauthenticated" });
    expect(mocks.ensureWebhookRegistered).not.toHaveBeenCalled();
  });

  it("does not swallow credential rejection during login's webhook registration", async () => {
    mocks.ensureWebhookRegistered.mockRejectedValue(rejectedCredential());

    const response = await createApiHandler(context()).handle(
      request("login/complete", "POST", { cliKey: "cli_test_session" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "composio_unauthenticated" });
  });

  it("keeps a validated login successful when only the relay is unavailable", async () => {
    mocks.ensureWebhookRegistered.mockRejectedValue(new Error("relay unavailable"));

    const response = await createApiHandler(context()).handle(
      request("login/complete", "POST", { cliKey: "cli_test_session" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("connector API webhook self-healing", () => {
  beforeEach(() => {
    rs.resetAllMocks();
    mocks.readSessionApiKey.mockResolvedValue("test-api-key");
    mocks.ensureWebhookRegistered.mockRejectedValue(new Error("relay unavailable"));
    mocks.client.ensureAuthConfig.mockResolvedValue("auth-config-1");
    mocks.client.ensureConnection.mockResolvedValue({
      kind: "redirect",
      url: "https://platform.composio.dev/connect",
    });
  });

  it("continues the OAuth connection when webhook self-healing fails", async () => {
    const warn = rs.fn();
    const ctx = {
      db: {},
      repositories: { settings: {} },
      log: { warn, error: rs.fn(), info: rs.fn() },
    } as unknown as RomeAppContext;
    const request = {
      method: "POST",
      path: ["connectors"],
      headers: { host: "rome.test" },
      body: new TextEncoder().encode(JSON.stringify({ provider: "notion" })),
    } as unknown as RomeAppApiRequest;

    const response = await createApiHandler(ctx).handle(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "notion",
      authorizationUrl: "https://platform.composio.dev/connect",
    });
    expect(mocks.ensureWebhookRegistered).toHaveBeenCalledOnce();
    expect(mocks.client.ensureAuthConfig).toHaveBeenCalledWith("notion");
    expect(warn).toHaveBeenCalledWith(
      "connectors.start: webhook registration failed; continuing OAuth",
      expect.objectContaining({ provider: "notion", error: "relay unavailable" }),
    );
  });
});

describe("connector API GitHub webhook outbox", () => {
  const secret = "github-hook-secret";

  function migratedDb(): { db: AppDbContext; sqlite: Database.Database } {
    const sqlite = new Database(":memory:");
    const connection = drizzle(sqlite) as unknown as BetterSQLite3Database<Record<string, never>>;
    migrate(connection, {
      migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations"),
      migrationsTable: "__drizzle_migrations_app_connector",
    });
    const db: AppDbContext = {
      connection,
      tablePrefix: "connector",
      tableName: (name: string) => `connector__${name}`,
    };
    return { db, sqlite };
  }

  async function githubDelivery(deliveryId: string): Promise<RomeAppApiRequest> {
    const body = JSON.stringify({ action: "created", issue: { number: 7 } });
    return {
      path: ["webhook"],
      method: "POST",
      headers: {
        host: "rome.test",
        "x-github-event": "issue_comment",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": await sign(secret, body),
      },
      body: new TextEncoder().encode(body),
    } as unknown as RomeAppApiRequest;
  }

  beforeEach(() => {
    rs.resetAllMocks();
    mocks.settings.get.mockImplementation(async (key: string) =>
      key === "githubWebhookSecret" ? secret : undefined,
    );
  });

  it("acks a delivery while its publish still waits for a worker, then publishes it", async () => {
    const { db, sqlite } = migratedDb();
    let finishPublish!: () => void;
    const runAction = rs.fn(
      () =>
        new Promise((resolvePublish) => {
          finishPublish = () => resolvePublish({ status: "ok" });
        }),
    );
    const ctx = {
      db,
      repositories: { settings: {} },
      runAction,
      log: { debug: rs.fn(), warn: rs.fn(), error: rs.fn(), info: rs.fn() },
    } as unknown as RomeAppContext;

    const response = await createApiHandler(ctx).handle(await githubDelivery("delivery-1"));

    expect(response.status).toBe(200);
    await rs.waitFor(() => expect(runAction).toHaveBeenCalledOnce());
    expect(runAction).toHaveBeenCalledWith("publish_event", {
      name: "provider:event:github.issue_comment",
      source: "connector",
      payload: { action: "created", issue: { number: 7 } },
    });

    finishPublish();
    await rs.waitFor(() =>
      expect(
        sqlite.prepare("SELECT published_at FROM connector__emitted_events").get(),
      ).toMatchObject({ published_at: expect.any(Number) }),
    );
    sqlite.close();
  });

  it("retries an event left unpublished when the next delivery arrives", async () => {
    const { db, sqlite } = migratedDb();
    const runAction = rs
      .fn()
      .mockRejectedValueOnce(new Error("Action worker capacity reached (max 8 live workers)"))
      .mockResolvedValue({ status: "ok" });
    const log = { debug: rs.fn(), warn: rs.fn(), error: rs.fn(), info: rs.fn() };
    const ctx = {
      db,
      repositories: { settings: {} },
      runAction,
      log,
    } as unknown as RomeAppContext;

    await createApiHandler(ctx).handle(await githubDelivery("delivery-1"));
    // The failure is logged after its claim is released.
    await rs.waitFor(() => expect(log.warn).toHaveBeenCalledOnce());
    await createApiHandler(ctx).handle(await githubDelivery("delivery-2"));

    await rs.waitFor(() => expect(runAction).toHaveBeenCalledTimes(3));
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM connector__emitted_events WHERE published_at IS NULL")
        .get(),
    ).toEqual({ n: 0 });
    sqlite.close();
  });
});
