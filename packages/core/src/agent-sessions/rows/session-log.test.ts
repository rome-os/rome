import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { romeAgentTraceBlocks } from "../../db/schema.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { createSessionLog, openNamed } from "./session-log.js";

describe("the session log's writer", () => {
  let testDb: TestDb | undefined;
  afterEach(() => testDb?.close());

  it("keeps an event whose write failed, at its place, with the next write", async () => {
    testDb = createTestDb();
    const repo = new WebChatRepository(testDb.db);
    const append = repo.appendTraceBlocks.bind(repo);
    rs.spyOn(repo, "appendTraceBlocks")
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockImplementation(append);
    const entry = createSessionLog(repo).turn?.({
      agentName: "main",
      sessionId: "agent-session",
      caller: "main:adhoc",
      turnId: "turn-1",
      prompt: "hello",
      child: false,
    });

    await entry?.writer?.write({
      type: "turn_start",
      turnId: "turn-1",
      sessionId: "agent-session",
      userPrompt: "hello",
    });
    await entry?.writer?.write({ type: "result", content: "hi" });

    const blocks = testDb.db
      .select({ seq: romeAgentTraceBlocks.seq, content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .orderBy(romeAgentTraceBlocks.seq)
      .all();
    expect(blocks.map((block) => [block.seq, JSON.parse(block.content).type])).toEqual([
      [0, "turn_start"],
      [1, "result"],
    ]);
  });

  it("gives up an event that keeps failing, so the rest of the turn is kept", async () => {
    testDb = createTestDb();
    const repo = new WebChatRepository(testDb.db);
    const append = repo.appendTraceBlocks.bind(repo);
    rs.spyOn(repo, "appendTraceBlocks").mockImplementation((batch) =>
      JSON.stringify(batch.blocks).includes("unwritable")
        ? Promise.reject(new Error("cannot serialize"))
        : append(batch),
    );
    const entry = createSessionLog(repo).turn?.({
      agentName: "main",
      sessionId: "agent-session",
      caller: "main:adhoc",
      turnId: "turn-1",
      prompt: "hello",
      child: false,
    });

    await entry?.writer?.write({ type: "text", content: "unwritable" });
    await entry?.writer?.write({ type: "text", content: "one" });
    await entry?.writer?.write({ type: "text", content: "two" });
    await entry?.writer?.write({ type: "result", content: "done" });

    const kept = testDb.db
      .select({ content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .orderBy(romeAgentTraceBlocks.seq)
      .all()
      .map((block) => JSON.parse(block.content));
    expect(kept.map((event) => event.content)).toEqual(["one", "two", "done"]);
  });

  it("retries a turn's end whose write failed, though nothing follows it", async () => {
    testDb = createTestDb();
    const repo = new WebChatRepository(testDb.db);
    const append = repo.appendTraceBlocks.bind(repo);
    let failed = false;
    rs.spyOn(repo, "appendTraceBlocks").mockImplementation((batch) => {
      if (!failed && JSON.stringify(batch.blocks).includes("turn_end")) {
        failed = true;
        return Promise.reject(new Error("database is locked"));
      }
      return append(batch);
    });
    const entry = createSessionLog(repo).turn?.({
      agentName: "main",
      sessionId: "agent-session",
      caller: "main:adhoc",
      turnId: "turn-1",
      prompt: "hello",
      child: false,
    });

    await entry?.writer?.write({ type: "result", content: "done" });
    await entry?.writer?.write({
      type: "turn_end",
      turnId: "turn-1",
      status: "completed",
      durationMs: 5,
    });

    const kept = testDb.db
      .select({ content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .orderBy(romeAgentTraceBlocks.seq)
      .all()
      .map((block) => JSON.parse(block.content).type);
    expect(kept).toEqual(["result", "turn_end"]);
  });
});

describe("a conversation named for an open", () => {
  it("stays with its own open while another open of the same session overlaps it", async () => {
    const sessionLog = createSessionLog(undefined);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const seen = await Promise.all([
      openNamed("session-1", "chat-a", async () => {
        await tick();
        return sessionLog.conversationOf?.("session-1");
      }),
      openNamed("session-1", "chat-b", async () => {
        await tick();
        return sessionLog.conversationOf?.("session-1");
      }),
    ]);

    expect(seen).toEqual(["chat-a", "chat-b"]);
  });

  it("names nothing for another session opened inside it", async () => {
    const sessionLog = createSessionLog(undefined);

    const seen = await openNamed("session-1", "chat-a", async () =>
      sessionLog.conversationOf?.("session-2"),
    );

    expect(seen).toBeUndefined();
  });
});
