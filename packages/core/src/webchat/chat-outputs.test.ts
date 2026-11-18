import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChatOutputDto } from "@rome/api-types/chat-outputs";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { eq } from "drizzle-orm";
import { romeAgentTraceBlocks, romeSessions } from "../db/schema.js";
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
  let savedProjectsRoot: string | undefined;

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
      chat: async (id) => {
        const chat = await chats.getSession(id);
        return chat
          ? { id: chat.id, projectDir: chat.projectPath ? join(projects, chat.projectPath) : null }
          : null;
      },
      messages: (id) => chats.getMessages(id),
      roots: { projects, assets, showable: [projects, assets] },
    });
    await chats.createSession("chat-1", "Chat");
    savedProjectsRoot = process.env.ROME_PROJECTS_ROOT;
    process.env.ROME_PROJECTS_ROOT = projects;
  });

  afterEach(() => {
    if (savedProjectsRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = savedProjectsRoot;
    testDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** The list once every earlier chat has been read back. */
  async function listed(
    chatId: string,
    taskChats: { chatId: string; name: string }[] = [],
  ): Promise<ChatOutputDto[]> {
    await outputs.list(chatId, taskChats);
    await outputs.backfillsSettled();
    return (await outputs.list(chatId, taskChats)).outputs;
  }

  /** Opens an output's file and reads it, or null when it cannot be opened. */
  async function read(
    chatId: string,
    outputId: string,
    taskChats: { chatId: string; name: string }[] = [],
  ) {
    const file = await outputs.open(chatId, outputId, taskChats);
    if (!file) return null;
    try {
      return { name: file.name, text: (await file.handle.readFile()).toString("utf8") };
    } finally {
      await file.handle.close();
    }
  }

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

  it("records a file a shell command wrote and one the reply links, as Codex makes them", async () => {
    const dir = join(projects, "demo");
    writeFileSync(join(dir, "hello.txt"), "Hello");
    writeFileSync(join(dir, "plan.md"), "# Plan");
    const run = {
      type: "commandExecution",
      id: "c1",
      command: `/usr/bin/bash -lc "printf 'Hello' > hello.txt"`,
      cwd: dir,
    };
    await turn(
      "chat-1",
      "t1",
      { type: "tool_use", id: "c1", tool: "Bash", input: { ...run, exitCode: null } },
      { type: "tool_result", toolUseId: "c1", tool: "Bash", output: { ...run, exitCode: 0 } },
    );
    await chats.appendTraceBlocks({
      messageId: "t1-trace",
      sessionId: "chat-1",
      turnId: "t1",
      startSeq: 3,
      blocks: [
        {
          type: "result",
          content:
            "Made [hello.txt](</projects/demo/hello.txt>) and [plan.md](/projects/demo/plan.md).",
        },
        { type: "turn_end", turnId: "t1" },
      ],
    });

    const list = await listed("chat-1");
    expect(list.map((output) => [output.name, output.kind, output.link])).toEqual([
      ["plan.md", "written", "/projects/demo/plan.md"],
      ["hello.txt", "written", "/projects/demo/hello.txt"],
    ]);
    const hello = list.find((output) => output.name === "hello.txt")!;
    expect(await read("chat-1", hello.id)).toEqual({ name: "hello.txt", text: "Hello" });
  });

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

    const list = await listed("chat-1");
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
    expect(await read("chat-1", list[0].id)).toEqual({ name: "notes.md", text: "# Notes" });
  });

  it("lists a file written and then shown as one output", async () => {
    const chart = join(projects, "demo", "chart.png");
    writeFileSync(chart, "png");
    await write("chat-1", "t1", chart);
    await show("chat-1", "t2", chart, `${ID_A}.png`);
    const list = await listed("chat-1");
    expect(list.map((output) => output.kind)).toEqual(["shown"]);
  });

  it("marks a written file that is gone as missing, and serves nothing for it", async () => {
    await write("chat-1", "t1", join(projects, "demo", "gone.txt"));
    const [gone] = await listed("chat-1");
    expect(gone).toMatchObject({ name: "gone.txt", missing: true, contentUrl: null });
    expect(await read("chat-1", gone.id)).toBeNull();
  });

  it("serves no file outside the folders chat can show, or a sensitive one", async () => {
    const outside = join(root, "outside.txt");
    const secret = join(projects, "demo", ".env");
    writeFileSync(outside, "x");
    writeFileSync(secret, "KEY=1");
    await write("chat-1", "t1", outside);
    await write("chat-1", "t2", secret);
    const list = await listed("chat-1");
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
    const list = await listed(CONCIERGE_CHAT_ID, started);
    expect(list.map((output) => [output.name, output.from])).toEqual([
      ["own.md", null],
      ["report.md", { chatId: "task-1", name: "Draft the report" }],
    ]);
    const fromTask = list[1];
    expect(fromTask.contentUrl).toContain(`/chat/sessions/${CONCIERGE_CHAT_ID}/outputs/`);
    expect(await read(CONCIERGE_CHAT_ID, fromTask.id, started)).not.toBeNull();
    // Another chat's output is not this list's to serve.
    expect(await read("chat-1", fromTask.id)).toBeNull();
    expect(await tasks.taskChatsStartedBy("topic-1", "guardian")).toEqual([
      { chatId: "task-2", name: "Elsewhere" },
    ]);
  });

  it("leaves a task chat's file the task chat's when the Concierge's reply passes it on", async () => {
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
    const tasks = new ConciergeTasksRepository(testDb.db);
    await tasks.upsertMany([{ title: "Report", state: "doing", sessionId: "task-1" }]);
    const report = join(projects, "demo", "report.md");
    writeFileSync(report, "# Report");
    await write("task-1", "t1", report);
    await chats.appendTraceBlocks({
      messageId: "t2-trace",
      sessionId: CONCIERGE_CHAT_ID,
      turnId: "t2",
      startSeq: 0,
      blocks: [
        { type: "turn_start", turnId: "t2" },
        { type: "result", content: "The report is ready: [report.md](/projects/demo/report.md)" },
        { type: "turn_end", turnId: "t2" },
      ],
    });

    const started = await tasks.taskChatsStartedBy(CONCIERGE_CHAT_ID, "guardian");
    const list = await listed(CONCIERGE_CHAT_ID, started);
    expect(list.map((output) => [output.name, output.from])).toEqual([
      ["report.md", { chatId: "task-1", name: "Draft the report" }],
    ]);
  });

  it("marks when recording began with the first trace it records", async () => {
    const before = Date.now();
    await write("chat-1", "t1", join(projects, "demo", "a.md"));
    const since = repo.recordingSince(new Date("2030-01-01T00:00:00Z")).getTime();
    expect(since).toBeGreaterThanOrEqual(before - 1000);
    expect(since).toBeLessThanOrEqual(Date.now());
  });

  it("reads no link back from a message an older chat got since recording began", async () => {
    const asset = `${ID_A}.png`;
    writeFileSync(join(assets, asset), "png");
    repo.recordingSince(new Date("2026-06-01T00:00:00Z"));
    // Another chat's shown file, passed on after recording began.
    await chats.addMessage(
      "reply",
      "chat-1",
      "assistant",
      JSON.stringify([{ type: "text", content: `![plot.png](/api/assets/${asset})` }]),
      "t0",
    );
    await testDb.db
      .update(romeSessions)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(romeSessions.id, "chat-1"));
    expect(await listed("chat-1")).toEqual([]);
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

    // The chat was made before outputs were recorded as they happen.
    await testDb.db
      .update(romeSessions)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(romeSessions.id, "chat-1"));
    // The first list answers at once, says earlier outputs are still being
    // read back, and reads them back after it.
    const pending = await outputs.list("chat-1");
    expect(pending).toEqual({ outputs: [], indexing: true });
    const first = await listed("chat-1");
    expect(first.map((output) => [output.name, output.kind, output.messageId]).sort()).toEqual([
      ["old.md", "written", "old-trace"],
      ["plot.png", "shown", "reply"],
    ]);
    // Read again, and with the trace recorded since: still one record each.
    expect((await outputs.list("chat-1")).indexing).toBe(false);
    expect(await repo.listFor(["chat-1"])).toHaveLength(2);
  });

  it("reads back nothing for a chat made since outputs were recorded as they happen", async () => {
    const asset = `${ID_A}.png`;
    writeFileSync(join(assets, asset), "png");
    // A link the reply holds, with no show call recorded for it.
    await chats.addMessage(
      "reply",
      "chat-1",
      "assistant",
      JSON.stringify([{ type: "text", content: `![plot.png](/api/assets/${asset})` }]),
      "t0",
    );
    expect(await outputs.list("chat-1")).toEqual({ outputs: [], indexing: false });
    await outputs.backfillsSettled();
    expect(await repo.listFor(["chat-1"])).toEqual([]);
  });

  it("keeps when recording began across restarts", () => {
    const first = repo.recordingSince(new Date("2026-11-01T00:00:00Z"));
    expect(repo.recordingSince(new Date("2026-12-01T00:00:00Z"))).toEqual(first);
  });

  it("finds a relative path in the chat's project folder", async () => {
    await chats.createSession("chat-rel", "Relative", undefined, "demo", null, "demo");
    writeFileSync(join(projects, "demo", "report.md"), "# Report");
    await write("chat-rel", "t1", "report.md");
    const [report] = await listed("chat-rel");
    expect(report).toMatchObject({
      name: "report.md",
      missing: false,
      link: "/projects/demo/report.md",
    });
    expect(await read("chat-rel", report.id)).toMatchObject({ text: "# Report" });
  });

  it("serves no file a link has replaced, written or shown", async () => {
    const notes = join(projects, "demo", "notes.md");
    const secret = join(root, "secret.txt");
    writeFileSync(notes, "# Notes");
    writeFileSync(secret, "secret");
    await write("chat-1", "t1", notes);
    await show("chat-1", "t2", join(projects, "demo", "chart.png"), `${ID_A}.png`);
    const list = await listed("chat-1");
    // The files are swapped for links to a file outside the folders chat shows.
    for (const path of [notes, join(assets, `${ID_A}.png`)]) {
      rmSync(path);
      symlinkSync(secret, path);
    }
    for (const output of list) expect(await read("chat-1", output.id)).toBeNull();
  });

  it("matches a result to its call from memory, without reading the trace back", async () => {
    const notes = join(projects, "demo", "notes.md");
    writeFileSync(notes, "# Notes");
    const select = rs.spyOn(testDb.db, "select");
    await write("chat-1", "t1", notes);
    // The result's stretch reads no stored block to find its call.
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
    expect((await repo.listFor(["chat-1"])).map((row) => row.name)).toEqual(["notes.md"]);
  });

  it("goes with its chat", async () => {
    await write("chat-1", "t1", join(projects, "demo", "a.md"));
    await chats.deleteSession("chat-1");
    expect(await repo.listFor(["chat-1"])).toEqual([]);
  });
});
