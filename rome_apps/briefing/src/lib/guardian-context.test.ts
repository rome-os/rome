import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ActionResult, RomeAppContext } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../packages/core/src/test/helpers.js";
import { gatherGuardianContext } from "./guardian-context.js";

const now = Date.UTC(2026, 9, 23, 18, 0, 0);
const sec = (hoursAgo: number) => Math.floor((now - hoursAgo * 3600_000) / 1000);
const text = (value: string) => JSON.stringify([{ type: "text", content: value }]);

const cloudProfile = {
  id: "account-ada",
  email: "ada@example.com",
  avatarUrl: "https://example.com/ada.png",
  slug: "ada",
  displayName: "Ada Baker",
  createdAt: "2026-01-01T00:00:00Z",
  signInLinks: [
    { provider: "github", login: "ada", email: "ada@example.com", displayName: "Ada Baker" },
    { provider: "google", login: "ada@example.com", email: null, displayName: "" },
  ],
  survey: null,
  research: {
    status: "completed",
    completedAt: "2026-10-23T12:00:00Z",
    report: {
      identity: { status: "matched", basis: "Linked account" },
      name: "Ada Baker",
      headline: "Owner, Ada's Cakes",
      role: "Founder",
      company: "Ada's Cakes",
      location: "London",
      summary: "Runs a bakery.\nHandles orders by hand.",
      facts: [
        { topic: "Role", text: "Owns the bakery", sourceUrl: "https://example.com/about" },
        { topic: "Orders", text: "Takes custom cake orders", sourceUrl: null },
      ],
      accounts: [{ platform: "github", url: "https://github.com/ada", matchedBy: "signInLink" }],
      surveyFit: "No survey answers",
      limitations: ["Only public sources"],
    },
  },
};

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

  it("renders the whole cloud profile as Markdown without depending on its schema", async () => {
    const { profile } = await gatherGuardianContext(
      appContext({ status: "ok", data: cloudProfile }),
      "UTC",
      now,
    );
    expect(profile).toBe(`- **Id:** account-ada
- **Email:** ada@example.com
- **Avatar Url:** https://example.com/ada.png
- **Slug:** ada
- **Display Name:** Ada Baker
- **Created At:** 2026-01-01T00:00:00Z
- **Sign In Links:**
  -
    - **Provider:** github
    - **Login:** ada
    - **Email:** ada@example.com
    - **Display Name:** Ada Baker
  -
    - **Provider:** google
    - **Login:** ada@example.com
- **Research:**
  - **Status:** completed
  - **Completed At:** 2026-10-23T12:00:00Z
  - **Report:**
    - **Identity:**
      - **Status:** matched
      - **Basis:** Linked account
    - **Name:** Ada Baker
    - **Headline:** Owner, Ada's Cakes
    - **Role:** Founder
    - **Company:** Ada's Cakes
    - **Location:** London
    - **Summary:** Runs a bakery.
      Handles orders by hand.
    - **Facts:**
      -
        - **Topic:** Role
        - **Text:** Owns the bakery
        - **Source Url:** https://example.com/about
      -
        - **Topic:** Orders
        - **Text:** Takes custom cake orders
    - **Accounts:**
      -
        - **Platform:** github
        - **Url:** https://github.com/ada
        - **Matched By:** signInLink
    - **Survey Fit:** No survey answers
    - **Limitations:**
      - Only public sources`);
  });

  it("skips empty values recursively but keeps false, zero, and new fields", async () => {
    const data = {
      survey: { buildGoals: ["Order tracking", null, "", [], {}] },
      futureField: { enabled: false, count: 0 },
      empty: { nested: { missing: undefined, nil: null, blank: "  ", list: [], object: {} } },
    };
    const { profile } = await gatherGuardianContext(appContext({ status: "ok", data }), "UTC", now);
    expect(profile).toBe(`- **Survey:**
  - **Build Goals:**
    - Order tracking
- **Future Field:**
  - **Enabled:** false
  - **Count:** 0`);
  });

  it("returns null for an unavailable, empty, or non-object profile", async () => {
    expect((await gatherGuardianContext(appContext(), "UTC", now)).profile).toBeNull();
    for (const data of [
      undefined,
      null,
      {},
      { survey: null, research: { report: {} } },
      [],
      [1],
      "Ada",
      42,
    ]) {
      const context = appContext({ status: "ok", data });
      expect((await gatherGuardianContext(context, "UTC", now)).profile).toBeNull();
    }
    const context = appContext();
    context.runAction = async () => {
      throw new Error("Cloud unavailable");
    };
    expect((await gatherGuardianContext(context, "UTC", now)).profile).toBeNull();
  });
});
