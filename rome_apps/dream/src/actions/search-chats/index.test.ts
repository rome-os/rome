import { beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type FakeChat, fakeChatReads, withChatReads } from "../../test-support/fake-chat-reads.js";
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

// The chats a test seeds, as Chats lists them. A background run stands in no
// chat, so Chats never lists one.
let chats: Map<string, FakeChat>;

beforeEach(() => {
  chats = new Map();
});

function seedSession(
  id: string,
  type = "webchat",
  kind: string | null = null,
  ownerKey: string | null = null,
): void {
  if (type !== "webchat" && type !== "channel") return;
  chats.set(id, {
    chat: {
      sessionId: id,
      name: `Chat ${id}`,
      ...(kind ? { channel: { name: kind, kind } } : {}),
      ...(ownerKey ? { ownerKey } : {}),
    },
    lines: [],
  });
}

function seedMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string | unknown[],
  daysAgo: number,
  actor: { kind: string; accountId?: string } | null = null,
): void {
  chats.get(sessionId)?.lines.push({
    role,
    content: JSON.stringify(content),
    createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    // Chats names a visitor's line by its sender.
    ...(actor?.kind === "visitor" ? { senderId: `visitor:${actor.accountId}` } : {}),
  });
}

function seededDeps(): AppActionRuntimeDeps {
  const reads = fakeChatReads([...chats.values()]);
  return { appContext: withChatReads(reads) } as unknown as AppActionRuntimeDeps;
}

async function search(args: Record<string, unknown>) {
  const result = await createAction(actionConfig, seededDeps()).execute(args);
  if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.data as { chatCount: number; returned: number; content: string };
}

describe("search_chats", () => {
  it("ranks the chat whose request holds the most query words first", async () => {
    seedSession("a");
    seedSession("b");
    seedMessage("a", "user", "Rename the invoices in Downloads", 40);
    seedMessage("b", "user", "Rename this month's invoice PDFs by vendor and date", 3);

    const data = await search({ query: "rename invoice pdf" });

    expect(data.chatCount).toBe(2);
    expect(data.content.indexOf("### Chat b")).toBeLessThan(data.content.indexOf("### Chat a"));
    expect(data.content).toContain("3 of 3 words in one request");
    expect(data.content).toContain('get_webchat_conversations { "sessionId": "b"');
  });

  it("opens a matched chat from its first message, not from its first match", async () => {
    seedSession("a");
    seedMessage("a", "user", "Set up the weekly vendor report", 40);
    seedMessage("a", "assistant", "Done.", 40);
    seedMessage("a", "user", "The invoice totals are wrong again", 3);

    const data = await search({ query: "invoice totals" });

    const windowHours = Number(/"windowHours": (\d+)/.exec(data.content)?.[1]);
    expect(windowHours).toBeGreaterThanOrEqual(40 * 24);
  });

  it("searches only what the guardian asked in the dashboard's chats", async () => {
    seedSession("dash");
    seedSession("telegram", "channel", "telegram");
    seedSession("job", "action");
    seedMessage("dash", "assistant", "Here is the weekly report", 1);
    seedMessage("telegram", "user", "send me the weekly report", 1);
    seedMessage("job", "user", "weekly report", 1);

    const data = await search({ query: "weekly report" });

    expect(data.chatCount).toBe(0);
    expect(data.content).toContain("(No guardian request matches.)");
  });

  it("leaves out requests older than the period", async () => {
    seedSession("old");
    seedMessage("old", "user", "Book the team offsite", 120);

    expect((await search({ query: "offsite" })).chatCount).toBe(0);
    expect((await search({ query: "offsite", days: 180 })).chatCount).toBe(1);
  });

  it("leaves out a chat a visitor owns or wrote in", async () => {
    const visitor = { kind: "visitor", accountId: "acc", email: "v@example.com" };
    seedSession("mine", "webchat", null, "guardian");
    seedSession("shared");
    seedSession("theirs", "webchat", null, "visitor:acc");
    seedMessage("mine", "user", "Rebuild the invoice app", 2, { kind: "guardian", via: "cookie" });
    seedMessage("shared", "user", "Rebuild the invoice app", 2);
    seedMessage("shared", "user", "Rebuild it to email me the data", 1, visitor);
    seedMessage("theirs", "user", "Rebuild the invoice app", 2);

    const found = await search({ query: "rebuild invoice" });
    const listed = await search({});

    expect(found.chatCount).toBe(1);
    expect(found.content).toContain("### Chat mine");
    expect(listed.chatCount).toBe(1);
    expect(listed.content).toContain("**Chat mine**");
  });

  it("lists a resumed chat by the request that started it, with a lookback that reaches it", async () => {
    seedSession("a");
    seedMessage("a", "user", "Build a vendor report app", 120);
    seedMessage("a", "user", "Try it again", 1);

    const data = await search({ days: 30 });

    expect(data.content).toContain("Build a vendor report app");
    expect(data.content).not.toContain("Try it again");
    const windowHours = Number(/"windowHours": (\d+)/.exec(data.content)?.[1]);
    expect(windowHours).toBeGreaterThanOrEqual(120 * 24);
  });

  it("matches a word only in the guardian's text, not in the stored JSON around it", async () => {
    seedSession("a");
    seedMessage("a", "user", [{ type: "text", content: "Draft a reply" }], 1);

    expect((await search({ query: "type" })).chatCount).toBe(0);
    expect((await search({ query: "reply" })).chatCount).toBe(1);
  });

  it("treats wildcard characters in the query as plain characters", async () => {
    seedSession("a");
    seedMessage("a", "user", "Check the disk", 1);

    expect((await search({ query: "%_" })).chatCount).toBe(0);
  });

  it("lists each chat's opening request without a query, most recently active first", async () => {
    seedSession("a");
    seedSession("b");
    seedMessage("a", "user", "Summarize my inbox", 10);
    seedMessage("b", "user", "Plan the trip to Lisbon", 5);
    seedMessage("a", "user", "Now archive the newsletters", 1);

    const data = await search({});

    expect(data.chatCount).toBe(2);
    expect(data.content).toContain("Summarize my inbox");
    expect(data.content).not.toContain("archive the newsletters");
    expect(data.content.indexOf("Chat a")).toBeLessThan(data.content.indexOf("Chat b"));
  });

  it("returns at most limit chats", async () => {
    for (const id of ["a", "b", "c"]) {
      seedSession(id);
      seedMessage(id, "user", "Export the timesheet", 1);
    }

    const data = await search({ query: "timesheet", limit: 2 });

    expect(data).toMatchObject({ chatCount: 3, returned: 2 });
  });

  it("rejects a query with no searchable word", async () => {
    const result = await createAction(actionConfig, seededDeps()).execute({ query: " a " });

    expect(result.status).toBe("error");
  });

  it("fails when the host offers no chat reads", async () => {
    const deps = { appContext: {} } as unknown as AppActionRuntimeDeps;

    const result = await createAction(actionConfig, deps).execute({ query: "invoice" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("no chat reads");
  });
});

describe("queryWords", () => {
  it("lower-cases, strips quotes and punctuation, and drops repeats and one-letter words", () => {
    expect(queryWords('"Invoice", PDF? a invoice (rename)')).toEqual(["invoice", "pdf", "rename"]);
  });
});

describe("search_chats through Chats", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const text = (content: string) => JSON.stringify([{ type: "text", content }]);
  const reads = fakeChatReads([
    {
      chat: { sessionId: "s1", name: "Invoices" },
      lines: [
        { role: "user", content: text("set up the books"), createdAt: daysAgo(20) },
        { role: "user", content: text("rename the invoice pdf"), createdAt: daysAgo(2) },
      ],
    },
    {
      chat: { sessionId: "s2", name: "Visitor" },
      lines: [
        {
          role: "user",
          content: text("invoice pdf please"),
          createdAt: daysAgo(1),
          senderId: "visitor:v1",
        },
      ],
    },
  ]);
  const run = async (args: Record<string, unknown>) => {
    const deps = { appContext: withChatReads(reads) } as unknown as AppActionRuntimeDeps;
    const result = await createAction(actionConfig, deps).execute(args);
    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    return result.data as { chatCount: number; content: string };
  };

  it("finds the guardian's matching request and opens the chat from its first line", async () => {
    const data = await run({ query: "invoice pdf", days: 30 });

    expect(data.chatCount).toBe(1);
    expect(data.content).toContain("Invoices");
    expect(data.content).toContain("rename the invoice pdf");
    expect(data.content).not.toContain("Visitor");
  });

  it("lists each guardian chat by the request that opened it", async () => {
    const data = await run({ days: 7 });

    expect(data.chatCount).toBe(1);
    expect(data.content).toContain("set up the books");
  });
});
