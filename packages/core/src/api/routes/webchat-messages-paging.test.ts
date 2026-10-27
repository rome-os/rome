import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createWebchatRuntime } from "./webchat.js";
import { romeAgentMessages } from "../../db/schema.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";

interface WireMessage {
  id: string;
  turnId: string | null;
  role: string;
  traceSummary?: unknown;
}

interface WirePage {
  messages: WireMessage[];
  nextCursor: string | null;
}

const SESSION_ID = "paging-session";
// Recent, so the session's traces are not archived by the idle-session cutoff.
const BASE_SECONDS = Math.floor(Date.now() / 1000) - 3600;

describe("GET /chat/sessions/:id/messages paging", () => {
  let testDb: TestDb;
  let deps: TestDeps;

  async function setCreatedAt(id: string, seconds: number) {
    await testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date(seconds * 1000) })
      .where(eq(romeAgentMessages.id, id));
  }

  /** One turn: user, trace (with blocks), assistant, all inside `startSeconds`..+2. */
  async function seedTurn(index: number, startSeconds: number) {
    const turnId = `turn-${index}`;
    await deps.webchatRepo.addMessage(
      `u-${index}`,
      SESSION_ID,
      "user",
      `question ${index}`,
      turnId,
    );
    await deps.webchatRepo.appendTraceBlocks({
      messageId: `t-${index}`,
      sessionId: SESSION_ID,
      turnId,
      startSeq: 0,
      blocks: [
        { type: "tool_use", id: `tool-${index}`, tool: "Read", input: {} },
        { type: "tool_result", toolUseId: `tool-${index}`, tool: "Read", output: "x" },
        { type: "turn_end", turnId, status: "completed", durationMs: 1000 + index },
      ],
    });
    await deps.webchatRepo.addMessage(
      `a-${index}`,
      SESSION_ID,
      "assistant",
      JSON.stringify([{ type: "text", content: `answer ${index}` }]),
      turnId,
    );
    await setCreatedAt(`u-${index}`, startSeconds);
    await setCreatedAt(`t-${index}`, startSeconds + 1);
    await setCreatedAt(`a-${index}`, startSeconds + 2);
  }

  async function getPage(query: string): Promise<WirePage> {
    const app = createWebchatRuntime(deps).routes;
    const res = await app.request(`/chat/sessions/${SESSION_ID}/messages${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as WirePage;
  }

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    await seedBaseline(testDb.db);
    await deps.webchatRepo.createSession(SESSION_ID, "Paging");
  });

  afterEach(() => {
    rs.restoreAllMocks();
    testDb.close();
  });

  it("returns the whole session as a bare array when no paging parameter is given", async () => {
    for (let i = 0; i < 4; i += 1) await seedTurn(i, BASE_SECONDS + i * 10);
    const app = createWebchatRuntime(deps).routes;

    const res = await app.request(`/chat/sessions/${SESSION_ID}/messages`);

    const body = (await res.json()) as WireMessage[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((m) => m.id)).toEqual([
      "u-0",
      "t-0",
      "a-0",
      "u-1",
      "t-1",
      "a-1",
      "u-2",
      "t-2",
      "a-2",
      "u-3",
      "t-3",
      "a-3",
    ]);
  });

  it("returns the newest turns whole and a cursor for the older ones", async () => {
    for (let i = 0; i < 5; i += 1) await seedTurn(i, BASE_SECONDS + i * 10);

    const page = await getPage("?limit=2");

    expect(page.messages.map((m) => m.id)).toEqual(["u-3", "t-3", "a-3", "u-4", "t-4", "a-4"]);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("walks back through every turn exactly once and ends with a null cursor", async () => {
    for (let i = 0; i < 7; i += 1) await seedTurn(i, BASE_SECONDS + i * 10);
    const full = (await (
      await createWebchatRuntime(deps).routes.request(`/chat/sessions/${SESSION_ID}/messages`)
    ).json()) as WireMessage[];

    const pages: WireMessage[][] = [];
    let cursor: string | null = null;
    do {
      const page: WirePage = await getPage(
        `?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
      );
      pages.unshift(page.messages);
      cursor = page.nextCursor;
    } while (cursor);

    expect(pages.map((page) => new Set(page.map((m) => m.turnId)).size)).toEqual([1, 3, 3]);
    expect(pages.flat().map((m) => m.id)).toEqual(full.map((m) => m.id));
  });

  it("keeps a group intact when its rows span several seconds", async () => {
    await seedTurn(0, BASE_SECONDS);
    await seedTurn(1, BASE_SECONDS + 10);
    // The earlier turn's reply lands after the later turn started.
    await setCreatedAt("a-0", BASE_SECONDS + 15);

    const page = await getPage("?limit=1");

    expect(page.messages.map((m) => m.id)).toEqual(["u-1", "t-1", "a-1"]);
    const older = await getPage(`?limit=1&before=${encodeURIComponent(page.nextCursor ?? "")}`);
    expect(older.messages.map((m) => m.id)).toEqual(["u-0", "t-0", "a-0"]);
    expect(older.nextCursor).toBeNull();
  });

  it("counts a row without a turn as its own group", async () => {
    await seedTurn(0, BASE_SECONDS);
    await deps.webchatRepo.addMessage("note-1", SESSION_ID, "assistant", "[]");
    await deps.webchatRepo.addMessage("note-2", SESSION_ID, "assistant", "[]");
    await setCreatedAt("note-1", BASE_SECONDS + 20);
    await setCreatedAt("note-2", BASE_SECONDS + 30);
    await seedTurn(1, BASE_SECONDS + 40);

    const first = await getPage("?limit=2");
    expect(first.messages.map((m) => m.id)).toEqual(["note-2", "u-1", "t-1", "a-1"]);

    const second = await getPage(`?limit=2&before=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.messages.map((m) => m.id)).toEqual(["u-0", "t-0", "a-0", "note-1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("splits turns that start in the same second without repeating or dropping any", async () => {
    for (let i = 0; i < 6; i += 1) await seedTurn(i, BASE_SECONDS);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: WirePage = await getPage(
        `?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...page.messages.filter((m) => m.role === "user").map((m) => m.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect([...seen].sort()).toEqual(["u-0", "u-1", "u-2", "u-3", "u-4", "u-5"]);
  });

  it("builds the same trace summary for a row as the full list does", async () => {
    for (let i = 0; i < 3; i += 1) await seedTurn(i, BASE_SECONDS + i * 10);
    const full = (await (
      await createWebchatRuntime(deps).routes.request(`/chat/sessions/${SESSION_ID}/messages`)
    ).json()) as WireMessage[];

    const page = await getPage("?limit=1");

    const fullSummary = full.find((m) => m.id === "t-2")?.traceSummary;
    expect(fullSummary).toBeDefined();
    expect(page.messages.find((m) => m.id === "t-2")?.traceSummary).toEqual(fullSummary);
  });

  it("reads trace blocks only for the turns in the page", async () => {
    for (let i = 0; i < 6; i += 1) await seedTurn(i, BASE_SECONDS + i * 10);
    const traceReads = rs.spyOn(deps.webchatRepo, "getTraceContents");

    await getPage("?limit=2");

    expect(traceReads).toHaveBeenCalledTimes(1);
    expect(traceReads.mock.calls[0]?.[1]?.messageIds).toEqual(["t-4", "t-5"]);
  });

  it("limits a trace read to the named messages", async () => {
    for (let i = 0; i < 3; i += 1) await seedTurn(i, BASE_SECONDS + i * 10);

    const contents = await deps.webchatRepo.getTraceContents(SESSION_ID, { messageIds: ["t-1"] });

    expect(contents.map((row) => row.id)).toEqual(["t-1"]);
    expect(JSON.parse(contents[0]?.content ?? "[]")).toHaveLength(3);
    expect(await deps.webchatRepo.getTraceContents(SESSION_ID, { messageIds: [] })).toEqual([]);
  });

  it.each([
    "?limit=0",
    "?limit=abc",
    "?limit=1000",
    "?limit=2&before=not-a-cursor",
  ])("rejects %s", async (query) => {
    const app = createWebchatRuntime(deps).routes;

    const res = await app.request(`/chat/sessions/${SESSION_ID}/messages${query}`);

    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown session", async () => {
    const app = createWebchatRuntime(deps).routes;

    const res = await app.request("/chat/sessions/missing/messages?limit=2");

    expect(res.status).toBe(404);
  });
});
