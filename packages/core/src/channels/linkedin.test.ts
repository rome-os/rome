import { describe, expect, it, rs } from "@rstest/core";
import { sql } from "drizzle-orm";
import {
  LinkedInInboxPoller,
  pollDelayMs,
  threadNeedsSnapshot,
  type LinkedInPollerOptions,
} from "./linkedin.js";
import { OpencliAuthError, type OpencliResult } from "./linkedin-cli.js";
import { createTestDb } from "../test/helpers.js";
import { LinkedInStoreRepository } from "../db/repositories/linkedin-store.js";
import type {
  LinkedInMessageInput,
  LinkedInParticipantInput,
  LinkedInSyncSink,
  LinkedInThreadCursor,
  LinkedInThreadInput,
} from "./linkedin-sync.js";

function ok(payload: unknown): OpencliResult {
  return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
}

function inboxRow(threadId: string, timestamp: string, preview = "hello") {
  return {
    thread_url: `https://www.linkedin.com/messaging/thread/${threadId}/`,
    thread_id: threadId,
    person_name: "Ada",
    last_message_preview: preview,
    unread: false,
    timestamp,
  };
}

function snapshotRow(threadId: string, messageId: string) {
  return {
    thread_id: threadId,
    conversation_name: "Ada",
    conversation_title: "",
    conversation_is_group: false,
    participant_count: 2,
    message_id: messageId,
    sent_at: "2026-08-19T20:00:00.000Z",
    sender_name: "Ada",
    sender_is_self: false,
    text: "hello",
  };
}

class FakeSink implements LinkedInSyncSink {
  threads: LinkedInThreadInput[] = [];
  messages: LinkedInMessageInput[] = [];
  synced: string[] = [];
  syncedMeta = new Map<string, { isGroup?: boolean | null; conversationTitle?: string | null }>();
  cursors = new Map<string, LinkedInThreadCursor>();

  async upsertThreads(threads: LinkedInThreadInput[]): Promise<void> {
    this.threads.push(...threads);
  }
  async upsertMessages(messages: LinkedInMessageInput[]): Promise<void> {
    this.messages.push(...messages);
  }
  async getThreadCursors(threadIds: string[]): Promise<Map<string, LinkedInThreadCursor>> {
    const out = new Map<string, LinkedInThreadCursor>();
    for (const id of threadIds) {
      const cursor = this.cursors.get(id);
      if (cursor) out.set(id, cursor);
    }
    return out;
  }
  async markThreadSynced(
    threadId: string,
    opts: { conversationTitle?: string | null; isGroup?: boolean | null },
  ): Promise<void> {
    this.synced.push(threadId);
    this.syncedMeta.set(threadId, opts);
  }
}

function participantRow(threadId: string, participantId: string, overrides = {}) {
  return {
    thread_url: `https://www.linkedin.com/messaging/thread/${threadId}/`,
    thread_id: threadId,
    participant_index: 1,
    participant_count: 2,
    participant_id: participantId,
    name: "Ada",
    headline: "Engineer",
    type: "member",
    is_self: false,
    profile_url: `https://www.linkedin.com/in/${participantId}/`,
    ...overrides,
  };
}

/** A sink that can hold membership, unlike {@link FakeSink}. */
class ParticipantSink extends FakeSink {
  participantSets = new Map<string, LinkedInParticipantInput[]>();
  participantWrites: string[] = [];
  backfills = 0;

  async upsertThreadParticipants(
    threadId: string,
    participants: LinkedInParticipantInput[],
  ): Promise<void> {
    this.participantWrites.push(threadId);
    this.participantSets.set(threadId, participants);
  }

  async backfillParticipantsFromMessages(): Promise<void> {
    this.backfills++;
  }
}

function makePoller(
  sink: LinkedInSyncSink,
  run: LinkedInPollerOptions["run"],
  overrides: Partial<LinkedInPollerOptions> = {},
) {
  return new LinkedInInboxPoller({
    sink,
    run,
    minIntervalMs: 15 * 60_000,
    maxIntervalMs: 30 * 60_000,
    ...overrides,
  });
}

describe("pollDelayMs", () => {
  it("stays inside [min, max] across the random range", () => {
    expect(pollDelayMs(15, 30, () => 0)).toBe(15);
    expect(pollDelayMs(15, 30, () => 1)).toBe(30);
    expect(pollDelayMs(15, 30, () => 0.5)).toBeGreaterThanOrEqual(15);
    expect(pollDelayMs(15, 30, () => 0.5)).toBeLessThanOrEqual(30);
  });
});

describe("threadNeedsSnapshot", () => {
  const row = {
    rank: 1,
    threadId: "t1",
    threadUrl: "https://x/",
    personName: null,
    lastMessagePreview: "hello",
    unread: false,
    counterpartyType: null,
    category: null,
    lastMessageAt: new Date("2026-08-19T20:00:00Z"),
  };
  const cursor = {
    threadId: "t1",
    lastMessageAt: new Date("2026-08-19T20:00:00Z"),
    lastMessagePreview: "hello",
    lastSyncedAt: new Date("2026-08-19T20:01:00Z"),
  };

  it("is stale when never seen or never snapshotted", () => {
    expect(threadNeedsSnapshot(row, undefined)).toBe(true);
    expect(threadNeedsSnapshot(row, { ...cursor, lastSyncedAt: null })).toBe(true);
  });

  it("is fresh when the listing timestamp matches the watermark", () => {
    expect(threadNeedsSnapshot(row, cursor)).toBe(false);
  });

  it("is stale when the listing timestamp moved", () => {
    const moved = { ...row, lastMessageAt: new Date("2026-08-19T21:00:00Z") };
    expect(threadNeedsSnapshot(moved, cursor)).toBe(true);
  });

  it("falls back to the preview when the listing has no timestamp", () => {
    const noTs = { ...row, lastMessageAt: null };
    expect(threadNeedsSnapshot(noTs, cursor)).toBe(false);
    expect(threadNeedsSnapshot({ ...noTs, lastMessagePreview: "new msg" }, cursor)).toBe(true);
  });
});

describe("LinkedInInboxPoller.pollOnce", () => {
  it("snapshots a new thread and records its messages", async () => {
    const sink = new FakeSink();
    const run = rs.fn(async (args: string[]) => {
      if (args[1] === "inbox") return ok([inboxRow("t1", "2026-08-19T20:00:00.000Z")]);
      return ok([snapshotRow("t1", "m1"), snapshotRow("t1", "m2")]);
    });
    const poller = makePoller(sink, run);

    await poller.pollOnce();

    expect(sink.threads.map((t) => t.threadId)).toEqual(["t1"]);
    expect(sink.messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(sink.synced).toEqual(["t1"]);
    // The snapshot's group verdict reaches the watermark write: a 1:1 thread
    // records isGroup false, and its display-ladder conversation_name (the
    // counterparty's name) never lands as a title. Its participant count does
    // not: the count is derived from the membership the participant read
    // stores, so a scalar copied from here could only disagree with it.
    expect(sink.syncedMeta.get("t1")).toEqual({
      conversationTitle: null,
      isGroup: false,
    });
  });

  it("skips threads whose watermark has not moved", async () => {
    const sink = new FakeSink();
    sink.cursors.set("t1", {
      threadId: "t1",
      lastMessageAt: new Date("2026-08-19T20:00:00.000Z"),
      lastMessagePreview: "hello",
      lastSyncedAt: new Date(),
    });
    const run = rs.fn(async (args: string[]) => {
      if (args[1] === "inbox") return ok([inboxRow("t1", "2026-08-19T20:00:00.000Z")]);
      throw new Error("thread-snapshot must not run for a fresh thread");
    });
    const poller = makePoller(sink, run);

    await poller.pollOnce();

    expect(sink.synced).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caps snapshots per tick, most recent threads first", async () => {
    const sink = new FakeSink();
    const snapshotted: string[] = [];
    const run = rs.fn(async (args: string[]) => {
      if (args[1] === "inbox") {
        return ok([
          { ...inboxRow("t1", "2026-08-19T20:00:00.000Z"), rank: 1 },
          { ...inboxRow("t2", "2026-08-19T19:00:00.000Z"), rank: 2 },
          { ...inboxRow("t3", "2026-08-19T18:00:00.000Z"), rank: 3 },
        ]);
      }
      const threadUrl = args[args.indexOf("--thread-url") + 1];
      const threadId = threadUrl.split("/thread/")[1].replace("/", "");
      snapshotted.push(threadId);
      return ok([snapshotRow(threadId, `${threadId}-m1`)]);
    });
    const poller = makePoller(sink, run, { maxSnapshotsPerTick: 2 });

    await poller.pollOnce();

    expect(snapshotted).toEqual(["t1", "t2"]);
    expect(sink.synced).toEqual(["t1", "t2"]);
  });
});

describe("LinkedInInboxPoller participant sync", () => {
  /** inbox → snapshot → thread-participants, with the participant payload swappable. */
  function participantRun(payloads: () => unknown[]) {
    return rs.fn(async (args: string[]) => {
      if (args[1] === "inbox") return ok([inboxRow("t1", "2026-08-19T20:00:00.000Z")]);
      if (args[1] === "thread-participants") return ok(payloads());
      return ok([snapshotRow("t1", "m1")]);
    });
  }

  it("stores a polled thread's participants, readable after the tick", async () => {
    const sink = new ParticipantSink();
    const run = participantRun(() => [
      participantRow("t1", "ACoAAAda0001"),
      participantRow("t1", "ACoAASelf0003", {
        participant_index: 2,
        name: "Jane Doe",
        is_self: true,
      }),
    ]);

    await makePoller(sink, run).pollOnce();

    expect(run).toHaveBeenCalledWith(
      ["linkedin", "thread-participants", "--thread-url", inboxRow("t1", "").thread_url],
      expect.anything(),
    );
    expect(sink.participantSets.get("t1")).toEqual([
      {
        participantId: "ACoAAAda0001",
        name: "Ada",
        headline: "Engineer",
        type: "member",
        isSelf: false,
      },
      {
        participantId: "ACoAASelf0003",
        name: "Jane Doe",
        headline: "Engineer",
        type: "member",
        isSelf: true,
      },
    ]);
  });

  it("stores a participant who has sent no message in the thread", async () => {
    const sink = new ParticipantSink();
    // The snapshot only proves m1's sender; the participant read names a
    // second member who has never posted.
    const run = participantRun(() => [
      participantRow("t1", "ACoAAAda0001"),
      participantRow("t1", "ACoAALurk0002", { participant_index: 2, name: "Quiet One" }),
    ]);

    await makePoller(sink, run).pollOnce();

    expect(sink.messages.map((m) => m.messageId)).toEqual(["m1"]);
    expect(sink.participantSets.get("t1")?.map((p) => p.participantId)).toEqual([
      "ACoAAAda0001",
      "ACoAALurk0002",
    ]);
  });

  it("a re-poll of a thread whose membership changed stores the latest read", async () => {
    const sink = new ParticipantSink();
    let members = [
      participantRow("t1", "ACoAAAda0001"),
      participantRow("t1", "ACoAAGrace002", { participant_index: 2 }),
    ];
    const run = participantRun(() => members);
    const poller = makePoller(sink, run);

    await poller.pollOnce();
    // Grace left, someone new joined; the thread is stale again next tick.
    members = [
      participantRow("t1", "ACoAAAda0001"),
      participantRow("t1", "ACoAANew00004", { participant_index: 2 }),
    ];
    await poller.pollOnce();

    expect(sink.participantWrites).toEqual(["t1", "t1"]);
    expect(sink.participantSets.get("t1")?.map((p) => p.participantId)).toEqual([
      "ACoAAAda0001",
      "ACoAANew00004",
    ]);
  });

  it("does not crawl participants a sink cannot store", async () => {
    const sink = new FakeSink();
    const run = participantRun(() => [participantRow("t1", "ACoAAAda0001")]);

    await makePoller(sink, run).pollOnce();

    expect(run.mock.calls.map((c) => c[0][1])).toEqual(["inbox", "thread-snapshot"]);
  });

  it("a failed participant read leaves the message snapshot standing", async () => {
    const sink = new ParticipantSink();
    const run = rs.fn(async (args: string[]): Promise<OpencliResult> => {
      if (args[1] === "inbox") return ok([inboxRow("t1", "2026-08-19T20:00:00.000Z")]);
      if (args[1] === "thread-participants") {
        return { code: 1, stdout: "", stderr: "LinkedIn returned no participant data" };
      }
      return ok([snapshotRow("t1", "m1")]);
    });

    // Membership is a cache: a read that failed simply is not recorded, and it
    // must not cost the tick the messages it already mirrored.
    await expect(makePoller(sink, run).pollOnce()).resolves.toBeUndefined();

    expect(sink.messages.map((m) => m.messageId)).toEqual(["m1"]);
    expect(sink.synced).toEqual(["t1"]);
    expect(sink.participantWrites).toEqual([]);
  });

  it("an auth wall during the participant read still fails the tick", async () => {
    const sink = new ParticipantSink();
    const run = rs.fn(async (args: string[]): Promise<OpencliResult> => {
      if (args[1] === "inbox") return ok([inboxRow("t1", "2026-08-19T20:00:00.000Z")]);
      if (args[1] === "thread-participants") {
        return { code: 69, stdout: "ok: false\nerror:\n  code: AUTH_REQUIRED", stderr: "" };
      }
      return ok([snapshotRow("t1", "m1")]);
    });

    // A signed-out session is not a per-thread hiccup — the grant owner has to
    // hear about it.
    await expect(makePoller(sink, run).pollOnce()).rejects.toBeInstanceOf(OpencliAuthError);
  });

  it("seeds participants from stored messages once, without calling opencli", async () => {
    const sink = new ParticipantSink();
    const run = participantRun(() => [participantRow("t1", "ACoAAAda0001")]);
    const poller = makePoller(sink, run);

    await poller.pollOnce();
    await poller.pollOnce();

    expect(sink.backfills).toBe(1);
    // The seed reads rows already on disk; every opencli call in the tick
    // belongs to the normal poll path.
    expect(new Set(run.mock.calls.map((c) => c[0][1]))).toEqual(
      new Set(["inbox", "thread-snapshot", "thread-participants"]),
    );
  });
});

describe("LinkedInInboxPoller fault handling", () => {
  it("routes an auth failure to onAuthRejected", async () => {
    const sink = new FakeSink();
    const run = rs.fn(
      async (): Promise<OpencliResult> => ({
        code: 69,
        stdout: "ok: false\nerror:\n  code: AUTH_REQUIRED",
        stderr: "",
      }),
    );
    const poller = makePoller(sink, run);
    const onAuthRejected = rs.fn();

    poller.start({ onAuthRejected });
    await rs.waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    poller.stop();
    expect(poller.getRuntimeDegradation()).toBeNull();
  });

  it("reports a runtime degradation after two consecutive transient failures, and clears it on success", async () => {
    const sink = new FakeSink();
    let failing = true;
    const run = rs.fn(async (args: string[]): Promise<OpencliResult> => {
      if (failing) return { code: 1, stdout: "", stderr: "cdp unreachable" };
      if (args[1] === "inbox") return ok([]);
      return ok([]);
    });
    const poller = makePoller(sink, run, { minIntervalMs: 1, maxIntervalMs: 2 });
    const onAuthRejected = rs.fn();

    poller.start({ onAuthRejected });
    await rs.waitFor(() => expect(poller.getRuntimeDegradation()).not.toBeNull());
    expect(poller.getRuntimeDegradation()?.reason).toContain("failed");
    expect(onAuthRejected).not.toHaveBeenCalled();

    failing = false;
    await rs.waitFor(() => expect(poller.getRuntimeDegradation()).toBeNull());
    poller.stop();
  });
});

/**
 * Promotion is a guardian action, never a consequence of syncing. A LinkedIn
 * inbox holds many accounts — recruiters, newsletters, strangers — that must
 * not walk into the curated person graph on their own.
 *
 * The sink contract is the guarantee: it exposes no way to write `persons`. This
 * runs the poller against the real store to show that holds end to end, not just
 * against a fake that could not have promoted anyone anyway.
 */
describe("LinkedInInboxPoller and the person graph", () => {
  it("mirrors a thread's participants without promoting any of them", async () => {
    const testDb = createTestDb();
    try {
      const store = new LinkedInStoreRepository(testDb.db);
      const run = rs.fn(async (args: string[]) => {
        if (args[1] === "inbox") return ok([inboxRow("t1", "2026-08-19T20:00:00.000Z")]);
        if (args[1] === "thread-participants") return ok([participantRow("t1", "ACoAAAda0001")]);
        return ok([snapshotRow("t1", "m1")]);
      });

      await makePoller(store, run).pollOnce();

      // The mirror did its job...
      expect((await store.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
        "ACoAAAda0001",
      ]);
      // ...and left the person graph alone.
      expect(await store.listParticipants()).toEqual([
        expect.objectContaining({ participantId: "ACoAAAda0001", linkedPersonId: null }),
      ]);
      expect(testDb.db.all(sql`SELECT id FROM persons`)).toEqual([]);
      expect(testDb.db.all(sql`SELECT id FROM channel_mappings`)).toEqual([]);
    } finally {
      testDb.close();
    }
  });
});
