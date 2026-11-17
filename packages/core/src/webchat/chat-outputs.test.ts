import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { romeAgentTraceBlocks } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import type { WebChatRepository } from "./repository.js";
import { ChatOutputs } from "../chats/outputs/chat-outputs.js";
import { ChatOutputsRepository } from "../chats/outputs/repository.js";

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

describe("ChatOutputs", () => {
  let testDb: TestDb;
  let chats: WebChatRepository;
  let repo: ChatOutputsRepository;
  let outputs: ChatOutputs;
  let root: string;
  let projects: string;
  let assets: string;
  let seq = 0;

  beforeEach(async () => {
    testDb = createTestDb();
    chats = new ChatsWebChatRepository(testDb.db);
    repo = new ChatOutputsRepository(testDb.db);
    root = mkdtempSync(join(tmpdir(), "rome-chat-outputs-test-"));
    projects = join(root, "projects");
    assets = join(root, "assets");
    mkdirSync(join(projects, "demo"), { recursive: true });
    mkdirSync(assets, { recursive: true });
    outputs = new ChatOutputs({
      repo,
      chat: (id) => chats.getSession(id),
      messages: (id) => chats.getMessages(id),
      roots: { projects, assets, showable: [projects, assets] },
    });
    await chats.createSession("chat-1", "Chat");
    seq = 0;
  });

  afterEach(() => {
    testDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** One turn's trace, stored in two stretches as a live turn stores it. */
  async function turn(sessionId: string, turnId: string, use: object, result: object) {
    const messageId = `${turnId}-trace`;
    await chats.appendTraceBlocks({
      messageId,
      sessionId,
      turnId,
      startSeq: 0,
      blocks: [{ type: "turn_start", turnId }, use],
    });
    await chats.appendTraceBlocks({ messageId, sessionId, turnId, startSeq: 2, blocks: [result] });
    seq += 1;
  }

  async function write(sessionId: string, turnId: string, path: string, tool = "Write") {
    const id = `${turnId}-use`;
    await turn(
      sessionId,
      turnId,
      { type: "tool_use", id, tool, input: { file_path: path } },
      { type: "tool_result", toolUseId: id, tool, output: "ok" },
    );
  }

  async function show(sessionId: string, turnId: string, from: string, asset: string) {
    const id = `${turnId}-use`;
    writeFileSync(join(assets, asset), "png");
    await turn(
      sessionId,
      turnId,
      {
        type: "tool_use",
        id,
        tool: "execute_action",
        input: { action_name: "core:show_file", json_args: { path: from } },
      },
      {
        type: "tool_result",
        toolUseId: id,
        tool: "execute_action",
        output: JSON.stringify({ url: `/api/assets/${asset}` }),
      },
    );
  }

  it("records a written file and a shown one with their chat, turn and trace message", async () => {
    const notes = join(projects, "demo", "notes.md");
    writeFileSync(notes, "# Notes");
    await write("chat-1", "t1", notes);
    await show("chat-1", "t2", join(projects, "demo", "chart.png"), `${ID_A}.png`);

    const rows = await repo.listFor(["chat-1"]);
    expect(rows.map((row) => [row.kind, row.turnId, row.messageId, row.name])).toEqual([
      ["shown", "t2", "t2-trace", "chart.png"],
      ["written", "t1", "t1-trace", "notes.md"],
    ]);
  });

  it("records nothing for a failed write", async () => {
    await turn(
      "chat-1",
      "t1",
      { type: "tool_use", id: "u", tool: "Write", input: { file_path: "/x/a.md" } },
      { type: "tool_result", toolUseId: "u", tool: "Write", isError: true, output: "denied" },
    );
    expect(await repo.listFor(["chat-1"])).toEqual([]);
  });

  it("lists one entry per file, newest first, with where to read it", async () => {
    const notes = join(projects, "demo", "notes.md");
    writeFileSync(notes, "# Notes");
    await write("chat-1", "t1", notes);
    await show("chat-1", "t2", join(projects, "demo", "chart.png"), `${ID_A}.png`);
    await write("chat-1", "t3", notes, "Edit");

    const list = await outputs.list("chat-1");
    expect(list.map((output) => [output.name, output.kind, output.turnId])).toEqual([
      ["notes.md", "written", "t3"],
      ["chart.png", "shown", "t2"],
    ]);
    expect(list[0]).toMatchObject({
      link: "/projects/demo/notes.md",
      mimeType: "text/markdown",
      missing: false,
      from: null,
    });
    expect(list[0].contentUrl).toBe(`/api/chat/sessions/chat-1/outputs/${list[0].id}/content`);
    expect(list[1].link).toBe(`/api/assets/${ID_A}.png`);
    expect(await outputs.file("chat-1", list[0].id)).toMatchObject({ name: "notes.md" });
  });

  it("lists a file written and then shown as one output", async () => {
    const chart = join(projects, "demo", "chart.png");
    writeFileSync(chart, "png");
    await write("chat-1", "t1", chart);
    await show("chat-1", "t2", chart, `${ID_A}.png`);
    const list = await outputs.list("chat-1");
    expect(list.map((output) => output.kind)).toEqual(["shown"]);
  });

  it("marks a written file that is gone as missing, and serves nothing for it", async () => {
    await write("chat-1", "t1", join(projects, "demo", "gone.txt"));
    const [gone] = await outputs.list("chat-1");
    expect(gone).toMatchObject({ name: "gone.txt", missing: true, contentUrl: null });
    expect(await outputs.file("chat-1", gone.id)).toBeNull();
  });

  it("serves no file outside the folders chat can show, or a sensitive one", async () => {
    const outside = join(root, "outside.txt");
    const secret = join(projects, "demo", ".env");
    writeFileSync(outside, "x");
    writeFileSync(secret, "KEY=1");
    await write("chat-1", "t1", outside);
    await write("chat-1", "t2", secret);
    const list = await outputs.list("chat-1");
    expect(list.map((output) => [output.name, output.missing, output.contentUrl])).toEqual([
      [".env", false, null],
      ["outside.txt", false, null],
    ]);
  });

  it("lists a Concierge chat's task chats' outputs, each tagged with its task chat", async () => {
    await chats.createSession(
      CONCIERGE_CHAT_ID,
      "Main chat",
      undefined,
      undefined,
      null,
      undefined,
      "core:concierge",
    );
    await chats.createSession("task-1", "Draft the report");
    await chats.createSession("task-2", "Elsewhere");
    await chats.createSession(
      "topic-1",
      "Topic",
      undefined,
      undefined,
      null,
      undefined,
      "core:concierge",
    );
    const tasks = new ConciergeTasksRepository(testDb.db);
    await tasks.upsertMany([
      { title: "Report", state: "doing", sessionId: "task-1" },
      { title: "Other", state: "doing", sessionId: "task-2", chatId: "topic-1" },
    ]);
    const report = join(projects, "demo", "report.md");
    writeFileSync(report, "# Report");
    await write("task-1", "t1", report);
    await write("task-2", "t2", join(projects, "demo", "other.md"));
    await write(CONCIERGE_CHAT_ID, "t3", join(projects, "demo", "own.md"));

    const started = await tasks.taskChatsStartedBy(CONCIERGE_CHAT_ID, "guardian");
    expect(started).toEqual([{ chatId: "task-1", name: "Draft the report" }]);
    const list = await outputs.list(CONCIERGE_CHAT_ID, started);
    expect(list.map((output) => [output.name, output.from])).toEqual([
      ["own.md", null],
      ["report.md", { chatId: "task-1", name: "Draft the report" }],
    ]);
    const fromTask = list[1];
    expect(fromTask.contentUrl).toContain(`/chat/sessions/${CONCIERGE_CHAT_ID}/outputs/`);
    expect(await outputs.file(CONCIERGE_CHAT_ID, fromTask.id, started)).not.toBeNull();
    // Another chat's output is not this list's to serve.
    expect(await outputs.file("chat-1", fromTask.id)).toBeNull();
    expect(await tasks.taskChatsStartedBy("topic-1", "guardian")).toEqual([
      { chatId: "task-2", name: "Elsewhere" },
    ]);
  });

  it("reads back a chat's outputs from before they were recorded, once", async () => {
    const asset = `${ID_A}.png`;
    const attached = `${ID_B}.jpg`;
    writeFileSync(join(assets, asset), "png");
    writeFileSync(join(assets, attached), "jpg");
    const old = join(projects, "demo", "old.md");
    writeFileSync(old, "old");
    // Stored before chat_outputs: a trace's blocks, the guardian's attachment
    // and the agent's reply that links a shown file and echoes the attachment.
    await testDb.db.insert(romeAgentTraceBlocks).values([
      {
        messageId: "old-trace",
        seq: 0,
        sessionId: "chat-1",
        content: JSON.stringify({
          type: "tool_use",
          id: "w",
          tool: "Write",
          input: { file_path: old },
        }),
      },
      {
        messageId: "old-trace",
        seq: 1,
        sessionId: "chat-1",
        content: JSON.stringify({
          type: "tool_result",
          toolUseId: "w",
          tool: "Write",
          output: "ok",
        }),
      },
    ]);
    await chats.addMessage("old-trace", "chat-1", "trace", "[]", "t0");
    await chats.addMessage(
      "prompt",
      "chat-1",
      "user",
      JSON.stringify([{ type: "text", content: `![photo.jpg](/api/assets/${attached})` }]),
      "t0",
    );
    await chats.addMessage(
      "reply",
      "chat-1",
      "assistant",
      JSON.stringify([
        {
          type: "text",
          content: `![plot.png](/api/assets/${asset}) and your [photo.jpg](/api/assets/${attached})`,
        },
      ]),
      "t0",
    );

    const first = await outputs.list("chat-1");
    expect(first.map((output) => [output.name, output.kind, output.messageId]).sort()).toEqual([
      ["old.md", "written", "old-trace"],
      ["plot.png", "shown", "reply"],
    ]);
    // Read again, and with the trace recorded since: still one record each.
    await outputs.list("chat-1");
    expect(await repo.listFor(["chat-1"])).toHaveLength(2);
  });

  it("goes with its chat", async () => {
    await write("chat-1", "t1", join(projects, "demo", "a.md"));
    await chats.deleteSession("chat-1");
    expect(await repo.listFor(["chat-1"])).toEqual([]);
  });
});
