import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { AppDbContext } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { EventsRepo } from "./events-repo.js";
import {
  processGithubWebhook,
  processVerifiedWebhook,
  publishEmittedEvent,
  type ProcessResult,
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

describe("publishEmittedEvent", () => {
  let harness: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    harness = makeCtx();
  });

  afterEach(() => {
    harness.close();
  });

  it("forwards a freshly emitted event to publish_event with the topic as the bus event name", async () => {
    const result = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      v3TriggerMessage({ eventId: "evt-pub", data: { number: 42 } }),
      "msg_pub",
      new Date("2026-05-28T00:00:00Z"),
    );
    const { calls, run } = recordingRunAction();

    await publishEmittedEvent(run, result);

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

  it("does not republish a deduped event (Composio retry must not re-fire the routine)", async () => {
    const raw = v3TriggerMessage({ eventId: "evt-dup-pub", data: {} });
    await processVerifiedWebhook(harness.repo, fixtureResolver, raw, "msg_1", new Date());
    const second = await processVerifiedWebhook(
      harness.repo,
      fixtureResolver,
      raw,
      "msg_2",
      new Date(),
    );
    expect(second.kind).toBe("deduped");

    const { calls, run } = recordingRunAction();
    await publishEmittedEvent(run, second);

    expect(calls).toHaveLength(0);
  });

  it("does not publish ignored results", async () => {
    const ignored: ProcessResult = { kind: "ignored", reason: "not_a_trigger_message" };
    const { calls, run } = recordingRunAction();

    await publishEmittedEvent(run, ignored);

    expect(calls).toHaveLength(0);
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

  it("forwards an emitted github event to publish_event under its topic", async () => {
    const result = await processGithubWebhook(
      harness.repo,
      { action: "labeled" },
      "issues",
      "delivery-guid-2",
      new Date(),
    );
    const { calls, run } = recordingRunAction();
    await publishEmittedEvent(run, result);
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
