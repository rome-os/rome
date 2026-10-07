import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { AppDbContext } from "@rome-os/app-runtime";
import type { Logger } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { EventsRepo, MAX_PUBLISH_ATTEMPTS, PUBLISH_CLAIM_LEASE_MS } from "./events-repo.js";
import {
  processGithubWebhook,
  processVerifiedWebhook,
  publishPendingEvents,
  type ResolveToolkitSlug,
  type RunAction,
} from "./process-webhook.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../db/migrations");

function makeCtx(): { repo: EventsRepo; ctx: AppDbContext; close: () => void } {
  const sqlite = new Database(":memory:");
  const conn = drizzle(sqlite) as unknown as BetterSQLite3Database<Record<string, never>>;
  migrate(conn, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: "__drizzle_migrations_app_connector",
  });
  const ctx: AppDbContext = {
    connection: conn,
    tablePrefix: "connector",
    tableName: (name: string) => `connector__${name}`,
  };
  return { repo: new EventsRepo(ctx), ctx, close: () => sqlite.close() };
}

function v3TriggerMessage(opts: {
  eventId: string;
  data: Record<string, unknown>;
  triggerSlug?: string;
}) {
  return {
    id: opts.eventId,
    timestamp: "2026-05-28T00:00:00.000Z",
    type: "composio.trigger.message",
    metadata: { trigger_slug: opts.triggerSlug ?? "GMAIL_NEW_GMAIL_MESSAGE" },
    data: opts.data,
  };
}

// A fixture resolver that maps a few known slugs to toolkits, including a
// multi-word toolkit (`microsoft_teams`) — exactly the case the old
// split-on-underscore heuristic broke on.
const toolkitFromFixture: Record<string, string> = {
  GMAIL_NEW_GMAIL_MESSAGE: "gmail",
  SLACK_RECEIVE_MESSAGE: "slack",
  MICROSOFT_TEAMS_NEW_MESSAGE: "microsoft_teams",
};
const fixtureResolver: ResolveToolkitSlug = async (slug) => toolkitFromFixture[slug] ?? null;

describe("processVerifiedWebhook", () => {
  let harness: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    harness = makeCtx();
  });

  afterEach(() => {
    harness.close();
  });

  it("ignores non-trigger-message events (e.g. trigger.disabled)", async () => {
    const result = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      {
        id: "evt-d",
        type: "composio.trigger.disabled",
        metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
        data: {},
      },
      "msg_d",
      new Date(),
    );
    expect(result.kind).toBe("ignored");
    if (result.kind === "ignored") expect(result.reason).toBe("not_a_trigger_message");
    expect(await harness.repo.listEvents({ limit: 10 })).toHaveLength(0);
  });

  it("ignores payloads missing trigger_slug", async () => {
    const result = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      { id: "evt-x", type: "composio.trigger.message", data: {} },
      "msg_x",
      new Date(),
    );
    expect(result.kind).toBe("ignored");
    if (result.kind === "ignored") expect(result.reason).toBe("missing_trigger_slug");
  });

  it("ignores trigger_slugs the resolver doesn't recognize", async () => {
    const result = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      v3TriggerMessage({ eventId: "evt-bad", data: {}, triggerSlug: "MYSTERY_SLUG" }),
      "msg_bad",
      new Date(),
    );
    expect(result.kind).toBe("ignored");
    if (result.kind === "ignored") expect(result.reason).toBe("unknown_trigger_slug");
  });

  it("derives provider/eventType/topic from resolver + slug and emits", async () => {
    const raw = v3TriggerMessage({ eventId: "evt-gm-1", data: { subject: "Hi" } });
    const result = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      raw,
      "msg_3",
      new Date("2026-05-28T00:00:00Z"),
    );
    expect(result.kind).toBe("emitted");
    if (result.kind === "emitted") {
      expect(result.topic).toBe("provider:event:gmail.gmail_new_gmail_message");
      expect(result.event.provider).toBe("gmail");
      expect(result.event.eventType).toBe("gmail_new_gmail_message");
      expect(result.event.eventId).toBe("evt-gm-1");
      expect(result.event.data).toEqual({ subject: "Hi" });
    }
    expect(await harness.repo.listEvents({ limit: 10 })).toHaveLength(1);
  });

  it("handles multi-word toolkit slugs that the old split-on-underscore heuristic broke", async () => {
    const result = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      v3TriggerMessage({
        eventId: "evt-msteams-1",
        data: {},
        triggerSlug: "MICROSOFT_TEAMS_NEW_MESSAGE",
      }),
      "msg_msteams",
      new Date("2026-05-28T00:00:00Z"),
    );
    expect(result.kind).toBe("emitted");
    if (result.kind === "emitted") {
      expect(result.event.provider).toBe("microsoft_teams");
      expect(result.topic).toBe("provider:event:microsoft_teams.microsoft_teams_new_message");
    }
  });

  it("propagates resolver errors so Composio retries (transient failure)", async () => {
    const failingResolver: ResolveToolkitSlug = async () => {
      throw new Error("upstream 503");
    };
    await expect(
      processVerifiedWebhook(
        harness.repo,
        failingResolver,
        v3TriggerMessage({ eventId: "evt-boom", data: {} }),
        "msg_boom",
        new Date(),
      ),
    ).rejects.toThrow(/upstream 503/);
  });

  it("dedups Composio retries on the same eventId", async () => {
    const raw = v3TriggerMessage({ eventId: "evt-dup", data: { subject: "Once" } });
    const first = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      raw,
      "msg_a",
      new Date(),
    );
    const second = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      raw,
      "msg_b",
      new Date(),
    );
    expect(first.kind).toBe("emitted");
    expect(second.kind).toBe("deduped");
    expect(await harness.repo.listEvents({ limit: 10 })).toHaveLength(1);
  });

  it("filters listEvents by topic", async () => {
    await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      v3TriggerMessage({ eventId: "evt-a", data: {} }),
      "msg_gm",
      new Date("2026-05-28T00:00:00Z"),
    );
    await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      v3TriggerMessage({
        eventId: "evt-b",
        data: {},
        triggerSlug: "SLACK_RECEIVE_MESSAGE",
      }),
      "msg_sl",
      new Date("2026-05-28T00:00:01Z"),
    );
    const gmailOnly = await harness.repo.listEvents({
      topic: "provider:event:gmail.gmail_new_gmail_message",
      limit: 10,
    });
    expect(gmailOnly).toHaveLength(1);
    expect(gmailOnly[0].eventId).toBe("evt-a");
  });
});

function recordingRunAction(): {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  run: RunAction;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const run: RunAction = async (name, args) => {
    calls.push({ name, args });
    return { status: "ok" };
  };
  return { calls, run };
}

function silentLog(): Logger & { error: ReturnType<typeof rs.fn>; warn: ReturnType<typeof rs.fn> } {
  return { debug: rs.fn(), info: rs.fn(), warn: rs.fn(), error: rs.fn() };
}

describe("publishPendingEvents", () => {
  let harness: ReturnType<typeof makeCtx>;
  const receivedAt = new Date("2026-05-28T00:00:00Z");

  beforeEach(() => {
    harness = makeCtx();
  });

  afterEach(() => {
    harness.close();
  });

  async function store(eventId: string, at = receivedAt, data: Record<string, unknown> = {}) {
    return processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      v3TriggerMessage({ eventId, data }),
      `msg_${eventId}`,
      at,
    );
  }

  it("publishes a stored event under its topic once", async () => {
    await store("evt-pub", receivedAt, { number: 42 });
    const { calls, run } = recordingRunAction();

    await publishPendingEvents(harness.repo, run, silentLog());
    await publishPendingEvents(harness.repo, run, silentLog());

    expect(calls).toEqual([
      {
        name: "publish_event",
        args: {
          name: "provider:event:gmail.gmail_new_gmail_message",
          source: "connector",
          payload: { number: 42 },
        },
      },
    ]);
  });

  it("does not republish a deduped retry (it must not re-fire the routine)", async () => {
    await store("evt-dup");
    const { calls, run } = recordingRunAction();
    await publishPendingEvents(harness.repo, run, silentLog());

    expect((await store("evt-dup")).kind).toBe("deduped");
    await publishPendingEvents(harness.repo, run, silentLog());

    expect(calls).toHaveLength(1);
  });

  it("publishes the oldest event first", async () => {
    await store("evt-late", new Date("2026-05-28T00:02:00Z"), { order: 2 });
    await store("evt-early", new Date("2026-05-28T00:01:00Z"), { order: 1 });
    const { calls, run } = recordingRunAction();

    await publishPendingEvents(harness.repo, run, silentLog());

    expect(calls.map((call) => call.args.payload)).toEqual([{ order: 1 }, { order: 2 }]);
  });

  it("keeps a failed event owed and publishes it on the next drain", async () => {
    await store("evt-retry");
    const log = silentLog();
    const failing: RunAction = async () => {
      throw new Error("Action worker capacity reached (max 8 live workers)");
    };

    await publishPendingEvents(harness.repo, failing, log);
    expect(log.warn).toHaveBeenCalledWith(
      "event publish failed, will retry on the next webhook",
      expect.objectContaining({ eventId: "evt-retry", attempts: 1 }),
    );

    const { calls, run } = recordingRunAction();
    await publishPendingEvents(harness.repo, run, log);
    expect(calls).toHaveLength(1);
  });

  it("publishes each event once when two drains overlap", async () => {
    await store("evt-a", new Date("2026-05-28T00:01:00Z"));
    await store("evt-b", new Date("2026-05-28T00:02:00Z"));
    const { calls, run } = recordingRunAction();

    await Promise.all([
      publishPendingEvents(harness.repo, run, silentLog()),
      publishPendingEvents(harness.repo, run, silentLog()),
    ]);

    expect(calls).toHaveLength(2);
  });

  it("reclaims an event whose publisher died once the claim lapses", async () => {
    await store("evt-orphan");
    const claimedAt = new Date("2026-05-28T01:00:00Z");
    expect(await harness.repo.claimNextUnpublished(claimedAt)).not.toBeNull();
    const { calls, run } = recordingRunAction();

    await publishPendingEvents(harness.repo, run, silentLog(), () => claimedAt);
    expect(calls).toHaveLength(0);

    const lapsed = new Date(claimedAt.getTime() + PUBLISH_CLAIM_LEASE_MS);
    await publishPendingEvents(harness.repo, run, silentLog(), () => lapsed);
    expect(calls).toHaveLength(1);
  });

  it("gives up on an event after the last attempt so it stops blocking the line", async () => {
    await store("evt-poison", new Date("2026-05-28T00:01:00Z"));
    const log = silentLog();
    const failing: RunAction = async () => {
      throw new Error("invalid payload");
    };
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
      await publishPendingEvents(harness.repo, failing, log);
    }
    expect(log.error).toHaveBeenCalledWith(
      "gave up publishing event to bus",
      expect.objectContaining({ eventId: "evt-poison", attempts: MAX_PUBLISH_ATTEMPTS }),
    );

    await store("evt-next", new Date("2026-05-28T00:02:00Z"));
    const { calls, run } = recordingRunAction();
    await publishPendingEvents(harness.repo, run, log);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.name).toBe("provider:event:gmail.gmail_new_gmail_message");
  });
});

describe("outbox migration", () => {
  it("marks events stored before the outbox as published, so the first drain re-fires none", async () => {
    // Apply the migrations that predate the outbox, store an event, then
    // apply the rest.
    const preOutbox = mkdtempSync(join(tmpdir(), "connector-migrations-"));
    try {
      cpSync(MIGRATIONS_DIR, preOutbox, { recursive: true });
      const journalPath = join(preOutbox, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, 2);
      writeFileSync(journalPath, JSON.stringify(journal));

      const sqlite = new Database(":memory:");
      const conn = drizzle(sqlite) as unknown as BetterSQLite3Database<Record<string, never>>;
      const migrationsTable = "__drizzle_migrations_app_connector";
      migrate(conn, { migrationsFolder: preOutbox, migrationsTable });
      sqlite
        .prepare(
          "INSERT INTO connector__emitted_events (event_id, topic, provider, event_type, received_at, payload_json) VALUES ('evt-old', 't', 'github', 'push', 1779926976, '{}')",
        )
        .run();
      migrate(conn, { migrationsFolder: MIGRATIONS_DIR, migrationsTable });

      const repo = new EventsRepo({
        connection: conn,
        tablePrefix: "connector",
        tableName: (name: string) => `connector__${name}`,
      });
      const { calls, run } = recordingRunAction();
      await publishPendingEvents(repo, run, silentLog());
      expect(calls).toHaveLength(0);
      sqlite.close();
    } finally {
      rmSync(preOutbox, { recursive: true, force: true });
    }
  });
});

describe("processGithubWebhook", () => {
  let harness: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    harness = makeCtx();
  });

  afterEach(() => {
    harness.close();
  });

  it("emits github.<event> with provider github, the delivery GUID as id, and the body as data", async () => {
    const result = await processGithubWebhook(
      harness.repo,
      { action: "opened", number: 12 },
      "pull_request",
      "delivery-guid-1",
      new Date("2026-06-26T00:00:00Z"),
    );
    expect(result.kind).toBe("emitted");
    if (result.kind === "emitted") {
      expect(result.topic).toBe("provider:event:github.pull_request");
      expect(result.event.provider).toBe("github");
      expect(result.event.eventType).toBe("pull_request");
      expect(result.event.eventId).toBe("delivery-guid-1");
      expect(result.event.data).toEqual({ action: "opened", number: 12 });
    }
    expect(await harness.repo.listEvents({ limit: 10 })).toHaveLength(1);
  });

  it("dedups GitHub redeliveries on the same X-GitHub-Delivery GUID", async () => {
    const first = await processGithubWebhook(
      harness.repo,
      { ref: "refs/heads/main" },
      "push",
      "delivery-guid-dup",
      new Date(),
    );
    const second = await processGithubWebhook(
      harness.repo,
      { ref: "refs/heads/main" },
      "push",
      "delivery-guid-dup",
      new Date(),
    );
    expect(first.kind).toBe("emitted");
    expect(second.kind).toBe("deduped");
    expect(await harness.repo.listEvents({ limit: 10 })).toHaveLength(1);
  });

  it("publishes an emitted github event to publish_event under its topic", async () => {
    await processGithubWebhook(
      harness.repo,
      { action: "labeled" },
      "issues",
      "delivery-guid-2",
      new Date(),
    );
    const { calls, run } = recordingRunAction();
    await publishPendingEvents(harness.repo, run, silentLog());
    expect(calls).toEqual([
      {
        name: "publish_event",
        args: {
          name: "provider:event:github.issues",
          source: "connector",
          payload: { action: "labeled" },
        },
      },
    ]);
  });
});
