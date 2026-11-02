import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { WebChatRepository } from "../../../../../packages/core/src/db/repositories/webchat.js";
import type { SessionActor } from "../../../../../packages/core/src/lib/session-actor.js";
import {
  createTestDb,
  testAppRepositories,
  type TestDb,
} from "../../../../../packages/core/src/test/helpers.js";
import { seatFixture } from "../../../../../packages/core/src/test/seats.js";
import { createAction, queryWords } from "./index.js";

const actionConfig = {
  name: "search_chats",
  type: "custom",
  description: "Search the guardian's past requests",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

let testDb: TestDb;
let seededMessages = 0;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.close();
});

/** A dashboard chat, a Telegram group Rome's account is in (`channel`), or
 *  a background session in no chat. */
async function seedSession(
  id: string,
  type = "webchat",
  channel: string | null = null,
  ownerKey: string | null = null,
): Promise<void> {
  const repo = new WebChatRepository(testDb.db);
  if (type === "webchat") {
    await repo.createSession(id, `Chat ${id}`);
    testDb.db.run(
      sql`UPDATE rome_sessions SET owner_key = ${ownerKey}, created_at = 0 WHERE id = ${id}`,
    );
  } else if (channel) {
    const fixture = seatFixture(testDb.db);
    const chat = fixture.chat(channel, `${channel}:${id}`, "group");
    fixture.seat({ id, chat, accountId: `${channel}-bot`, name: `Chat ${id}`, type });
  } else {
    await repo.ensureRomeSession({
      id,
      name: `Chat ${id}`,
      type: type as "action",
      agentName: null,
    });
  }
}

/** A line said in session `sessionId` `daysAgo` days ago: the guardian's
 *  (or `actor`'s) as `user`, Rome's as `assistant`. */
async function seedMessage(
  sessionId: string,
  role: string,
  content: string | unknown[],
  daysAgo: number,
  actor: SessionActor | null = null,
): Promise<void> {
  const id = `m${++seededMessages}`;
  const createdAt = Math.floor((Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000);
  const body = JSON.stringify(content);
  const repo = new WebChatRepository(testDb.db);
  const seat = testDb.db.get<{ chat_id: string | null; account_id: string | null }>(
    sql`SELECT chat_id, account_id FROM rome_sessions WHERE id = ${sessionId}`,
  );
  const chat = seat?.chat_id
    ? testDb.db.get<{ platform: string }>(
        sql`SELECT platform FROM chats WHERE id = ${seat.chat_id}`,
      )
    : undefined;
  if (chat && chat.platform !== "webchat") {
    seatFixture(testDb.db).say({
      id,
      chat: { platform: chat.platform, id: seat!.chat_id! },
      from: role === "assistant" ? seat!.account_id : "person",
      agent: role === "assistant" ? "main" : null,
      parts: typeof content === "string" ? [{ type: "text", content }] : content,
      text: typeof content === "string" ? content : "",
      at: new Date(createdAt * 1000),
    });
    return;
  }
  if (role === "user" && chat) await repo.recordUserInput(id, sessionId, body, actor ?? undefined);
  else await repo.addMessage(id, sessionId, role, body, `turn-${id}`);
  testDb.db.run(sql`UPDATE chat_messages SET said_at = ${createdAt} WHERE key = ${id}`);
  testDb.db.run(sql`UPDATE rome_agent_messages SET created_at = ${createdAt} WHERE id = ${id}`);
}

async function search(args: Record<string, unknown>) {
  const deps = {
    appContext: { db: { connection: testDb.db }, repositories: testAppRepositories(testDb.db) },
  } as unknown as AppActionRuntimeDeps;
  const result = await createAction(actionConfig, deps).execute(args);
  if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.data as { chatCount: number; returned: number; content: string };
}

describe("search_chats", () => {
  it("ranks the chat whose request holds the most query words first", async () => {
    await seedSession("a");
    await seedSession("b");
    await seedMessage("a", "user", "Rename the invoices in Downloads", 40);
    await seedMessage("b", "user", "Rename this month's invoice PDFs by vendor and date", 3);

    const data = await search({ query: "rename invoice pdf" });

    expect(data.chatCount).toBe(2);
    expect(data.content.indexOf("### Chat b")).toBeLessThan(data.content.indexOf("### Chat a"));
    expect(data.content).toContain("3 of 3 words in one request");
    expect(data.content).toContain('get_webchat_conversations { "sessionId": "b"');
  });

  it("opens a matched chat from its first message, not from its first match", async () => {
    await seedSession("a");
    await seedMessage("a", "user", "Set up the weekly vendor report", 40);
    await seedMessage("a", "assistant", "Done.", 40);
    await seedMessage("a", "user", "The invoice totals are wrong again", 3);

    const data = await search({ query: "invoice totals" });

    const windowHours = Number(/"windowHours": (\d+)/.exec(data.content)?.[1]);
    expect(windowHours).toBeGreaterThanOrEqual(40 * 24);
  });

  it("searches only what the guardian asked in the dashboard's chats", async () => {
    await seedSession("dash");
    await seedSession("telegram", "channel", "telegram");
    await seedSession("job", "action");
    await seedMessage("dash", "assistant", "Here is the weekly report", 1);
    await seedMessage("telegram", "user", "send me the weekly report", 1);
    await seedMessage("job", "user", "weekly report", 1);

    const data = await search({ query: "weekly report" });

    expect(data.chatCount).toBe(0);
    expect(data.content).toContain("(No guardian request matches.)");
  });

  it("leaves out requests older than the period", async () => {
    await seedSession("old");
    await seedMessage("old", "user", "Book the team offsite", 120);

    expect((await search({ query: "offsite" })).chatCount).toBe(0);
    expect((await search({ query: "offsite", days: 180 })).chatCount).toBe(1);
  });

  it("leaves out a chat a visitor owns or wrote in", async () => {
    const visitor: SessionActor = { kind: "visitor", accountId: "acc", email: "v@example.com" };
    await seedSession("mine", "webchat", null, "guardian");
    await seedSession("shared");
    await seedSession("theirs", "webchat", null, "visitor:acc");
    await seedMessage("mine", "user", "Rebuild the invoice app", 2, {
      kind: "guardian",
      userId: "g",
      via: "cookie",
    });
    await seedMessage("shared", "user", "Rebuild the invoice app", 2);
    await seedMessage("shared", "user", "Rebuild it to email me the data", 1, visitor);
    await seedMessage("theirs", "user", "Rebuild the invoice app", 2);

    const found = await search({ query: "rebuild invoice" });
    const listed = await search({});

    expect(found.chatCount).toBe(1);
    expect(found.content).toContain("### Chat mine");
    expect(listed.chatCount).toBe(1);
    expect(listed.content).toContain("**Chat mine**");
  });

  it("lists a resumed chat by the request that started it, with a lookback that reaches it", async () => {
    await seedSession("a");
    await seedMessage("a", "user", "Build a vendor report app", 120);
    await seedMessage("a", "user", "Try it again", 1);

    const data = await search({ days: 30 });

    expect(data.content).toContain("Build a vendor report app");
    expect(data.content).not.toContain("Try it again");
    const windowHours = Number(/"windowHours": (\d+)/.exec(data.content)?.[1]);
    expect(windowHours).toBeGreaterThanOrEqual(120 * 24);
  });

  it("matches a word only in the guardian's text, not in the stored JSON around it", async () => {
    await seedSession("a");
    await seedMessage("a", "user", [{ type: "text", content: "Draft a reply" }], 1);

    expect((await search({ query: "type" })).chatCount).toBe(0);
    expect((await search({ query: "reply" })).chatCount).toBe(1);
  });

  it("treats LIKE wildcards in the query as plain characters", async () => {
    await seedSession("a");
    await seedMessage("a", "user", "Check the disk", 1);

    expect((await search({ query: "%_" })).chatCount).toBe(0);
  });

  it("lists each chat's opening request without a query, most recently active first", async () => {
    await seedSession("a");
    await seedSession("b");
    await seedMessage("a", "user", "Summarize my inbox", 10);
    await seedMessage("b", "user", "Plan the trip to Lisbon", 5);
    await seedMessage("a", "user", "Now archive the newsletters", 1);

    const data = await search({});

    expect(data.chatCount).toBe(2);
    expect(data.content).toContain("Summarize my inbox");
    expect(data.content).not.toContain("archive the newsletters");
    expect(data.content.indexOf("Chat a")).toBeLessThan(data.content.indexOf("Chat b"));
  });

  it("returns at most limit chats", async () => {
    for (const id of ["a", "b", "c"]) {
      await seedSession(id);
      await seedMessage(id, "user", "Export the timesheet", 1);
    }

    const data = await search({ query: "timesheet", limit: 2 });

    expect(data).toMatchObject({ chatCount: 3, returned: 2 });
  });

  it("rejects a query with no searchable word", async () => {
    const deps = {
      appContext: { db: { connection: testDb.db }, repositories: testAppRepositories(testDb.db) },
    } as unknown as AppActionRuntimeDeps;

    const result = await createAction(actionConfig, deps).execute({ query: " a " });

    expect(result.status).toBe("error");
  });
});

describe("queryWords", () => {
  it("lower-cases, strips quotes and punctuation, and drops repeats and one-letter words", () => {
    expect(queryWords('"Invoice", PDF? a invoice (rename)')).toEqual(["invoice", "pdf", "rename"]);
  });
});
