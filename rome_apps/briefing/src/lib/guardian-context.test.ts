import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ActionResult, RomeAppContext } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../packages/core/src/test/helpers.js";
import { gatherGuardianContext } from "./guardian-context.js";

const now = Date.UTC(2026, 9, 23, 18, 0, 0);
const sec = (hoursAgo: number) => Math.floor((now - hoursAgo * 3600_000) / 1000);
const text = (value: string) => JSON.stringify([{ type: "text", content: value }]);

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => testDb.close());

function chat(id: string, name: string, extra: { owner?: string; archived?: boolean } = {}) {
  testDb.db.run(sql`
    INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, owner_key, archived_at, created_at, activity_at)
    VALUES (${id}, ${name}, 'channel', 'webchat', ${id}, ${extra.owner ?? null},
      ${extra.archived ? sec(1) : null}, ${sec(100)}, ${sec(1)})
  `);
}

function message(
  id: string,
  session: string,
  role: string,
  content: string,
  hoursAgo: number,
  actor?: object,
) {
  testDb.db.run(sql`
    INSERT INTO rome_agent_messages (id, session_id, role, content, created_at, actor)
    VALUES (${id}, ${session}, ${role}, ${content}, ${sec(hoursAgo)}, ${actor ? JSON.stringify(actor) : null})
  `);
}

function appContext(profile: ActionResult = { status: "error", error: "unavailable" }) {
  return {
    db: { connection: testDb.db },
    runAction: async (name: string) => {
      expect(name).toBe("get_guardian_cloud_profile");
      return profile;
    },
  } as unknown as RomeAppContext;
}

describe("gatherGuardianContext", () => {
  it("reads only the guardian's own recent words in their own chats", async () => {
    const guardian = { kind: "guardian", userId: "g" };
    const visitor = { kind: "visitor", accountId: "v", email: "v@example.com" };
    chat("mine", "Bakery orders");
    chat("visited", "Shared demo");
    chat("theirs", "Visitor chat", { owner: "visitor:v" });
    chat("old", "Archived", { archived: true });
    message("m1", "mine", "user", text("Can you track pickup orders?"), 2, guardian);
    message("m2", "mine", "assistant", text("AGENT REPLY"), 2);
    message("m3", "mine", "user", text("too old"), 60);
    message("m4", "visited", "user", text("guardian start"), 3);
    message("m5", "visited", "user", text("visitor request"), 3, visitor);
    message("m6", "theirs", "user", text("owner request"), 3);
    message("m7", "old", "user", text("archived note"), 3);

    const { chats } = await gatherGuardianContext(appContext(), "UTC", now);

    expect(chats).toContain('Chat "Bakery orders"');
    expect(chats).toContain("Can you track pickup orders?");
    for (const absent of [
      "AGENT REPLY",
      "too old",
      "guardian start",
      "visitor request",
      "owner request",
      "archived note",
    ]) {
      expect(chats).not.toContain(absent);
    }
  });

  it("clips long messages and has no chats when nothing qualifies", async () => {
    chat("mine", "Long");
    message("m1", "mine", "user", text("x".repeat(1000)), 1);
    const { chats } = await gatherGuardianContext(appContext(), "UTC", now);
    expect(chats).toContain(`${"x".repeat(400)}…`);
    expect(chats).not.toContain("x".repeat(401));

    testDb.db.run(sql`DELETE FROM rome_agent_messages`);
    expect((await gatherGuardianContext(appContext(), "UTC", now)).chats).toBeNull();
  });

  it("passes the whole cloud profile and tolerates an unavailable or empty one", async () => {
    const data = {
      displayName: "Ada",
      survey: { professionalBackground: "other", buildGoals: ["Order tracking"] },
      research: { status: "completed", report: { headline: "Owner, Ada's Cakes" } },
    };
    const { profile } = await gatherGuardianContext(appContext({ status: "ok", data }), "UTC", now);
    expect(JSON.parse(profile ?? "")).toEqual(data);
    expect((await gatherGuardianContext(appContext(), "UTC", now)).profile).toBeNull();
    const empty = appContext({ status: "ok", data: {} });
    expect((await gatherGuardianContext(empty, "UTC", now)).profile).toBeNull();
  });
});
