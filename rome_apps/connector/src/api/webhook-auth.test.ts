import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AppDbContext, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as composioLoginModule from "./composio-login.js" with { rstest: "importActual" };

rs.mock("./composio-login.js", () => ({
  ...composioLoginModule,
  readSessionApiKey: async () => "uak_webhook_test",
}));

import { EventsRepo } from "./events-repo.js";
import { createApiHandler } from "./index.js";
import { SettingsStore } from "./settings-store.js";

const WEBHOOK_SECRET = "whsec_webhook_auth_test";
const TRIGGER_SLUG = "GMAIL_NEW_GMAIL_MESSAGE";

function signedDelivery(secret = WEBHOOK_SECRET): RomeAppApiRequest {
  const id = "msg_webhook_auth_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    id: "evt_webhook_auth_test",
    type: "composio.trigger.message",
    metadata: { trigger_slug: TRIGGER_SLUG },
    data: { subject: "Fixture message" },
  });
  const signature = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return {
    path: ["webhook"],
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    query: new URLSearchParams(),
    body: new TextEncoder().encode(payload),
  } as RomeAppApiRequest;
}

describe("inbound webhook credential failures", () => {
  let sqlite: Database.Database;
  let ctx: RomeAppContext;
  let events: EventsRepo;
  let runAction: ReturnType<typeof rs.fn>;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    const connection = drizzle(sqlite) as unknown as BetterSQLite3Database<Record<string, never>>;
    migrate(connection, {
      migrationsFolder: fileURLToPath(new URL("../db/migrations", import.meta.url)),
      migrationsTable: "__drizzle_migrations_app_connector",
    });
    const db: AppDbContext = {
      connection,
      tablePrefix: "connector",
      tableName: (name) => `connector__${name}`,
    };
    await new SettingsStore(db).set("webhookSecret", WEBHOOK_SECRET);
    events = new EventsRepo(db);
    runAction = rs.fn().mockResolvedValue({});
    ctx = {
      db,
      runAction,
      log: { warn: rs.fn(), error: rs.fn(), info: rs.fn() },
    } as unknown as RomeAppContext;
  });

  afterEach(() => {
    rs.restoreAllMocks();
    sqlite.close();
  });

  it("keeps a signed delivery retryable after an SDK 401 and persists it once after recovery", async () => {
    const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        {
          error: { slug: "UserApiKey_Unauthorized", message: "Invalid or revoked user API key" },
        },
        { status: 401 },
      ),
    );
    const delivery = signedDelivery();

    const rejected = await createApiHandler(ctx).handle(delivery);

    expect(fetch).toHaveBeenCalledOnce();
    expect(rejected.status).toBe(500);
    await expect(rejected.json()).resolves.toMatchObject({ error: "internal_error" });
    expect(await events.listEvents({ limit: 10 })).toEqual([]);
    expect(runAction).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(Response.json({ slug: TRIGGER_SLUG, toolkit: { slug: "gmail" } }));
    const recovered = await createApiHandler(ctx).handle(delivery);

    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ ok: true, deduped: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await events.listEvents({ limit: 10 })).toHaveLength(1);
    expect(runAction).toHaveBeenCalledExactlyOnceWith("publish_event", {
      name: "provider:event:gmail.gmail_new_gmail_message",
      source: "connector",
      payload: { subject: "Fixture message" },
    });

    const duplicate = await createApiHandler(ctx).handle(delivery);
    await expect(duplicate.json()).resolves.toEqual({ ok: true, deduped: true });
    expect(await events.listEvents({ limit: 10 })).toHaveLength(1);
    expect(runAction).toHaveBeenCalledOnce();
  });

  it("keeps invalid signatures terminal without contacting Composio or persisting an event", async () => {
    const fetch = rs.spyOn(globalThis, "fetch");

    const response = await createApiHandler(ctx).handle(signedDelivery("wrong-secret"));

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(await events.listEvents({ limit: 10 })).toEqual([]);
    expect(runAction).not.toHaveBeenCalled();
  });
});
