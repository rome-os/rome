import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { romeAgentTraceBlocks } from "../../db/schema.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { createSessionLog } from "./session-log.js";

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
});
