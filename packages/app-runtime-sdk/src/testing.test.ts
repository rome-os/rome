import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import {
  ActionInvocationError,
  getCurrentActionContext,
  runWithCurrentActionContext,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
  type ChannelsService,
  type ConversationId,
  type RomeAppContext,
} from "./index.js";
import {
  channelMessage,
  createFakeChannels,
  createTestApp,
  withActionContext,
  withChannelContext,
  type TestApp,
} from "./testing.js";

function writeMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "rome-testing-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, version: "6", when: 1, tag: "0000_init", breakpoints: true }],
    }),
  );
  writeFileSync(
    join(dir, "0000_init.sql"),
    "CREATE TABLE `demo__notes` (`id` integer PRIMARY KEY, `text` text NOT NULL, `chat` text);",
  );
  return dir;
}

type DemoDeps = AppActionRuntimeDeps<{ channelsService: ChannelsService }>;

function createNoteAction(config: ActionConfig, deps: DemoDeps): Action {
  return {
    config,
    async execute(args) {
      const chat = getCurrentActionContext()?.channelContext?.threadId ?? null;
      deps.appContext.db.connection.run(
        sql`INSERT INTO demo__notes (text, chat) VALUES (${String(args.text)}, ${chat})`,
      );
      return { status: "ok", data: { chat, at: new Date(0) } };
    },
  };
}

function createRecallAction(config: ActionConfig, deps: DemoDeps): Action {
  return {
    config,
    async execute() {
      const history = await deps.channelsService.query("feishu", { limit: 1 });
      const saved = await deps.appContext.runAction("demo:note", { text: history[0]?.text ?? "" });
      return { status: "ok", data: { saved } };
    },
  };
}

describe("createTestApp", () => {
  let app: TestApp;
  let migrations: string;

  beforeEach(async () => {
    migrations = writeMigrations();
    app = await createTestApp({
      appId: "demo",
      migrationsFolder: migrations,
      channelHistory: [
        channelMessage({
          channel: "feishu",
          text: "older",
          timestamp: new Date("2026-01-01T00:00:00Z"),
        }),
        channelMessage({
          channel: "feishu",
          text: "newest",
          timestamp: new Date("2026-01-02T00:00:00Z"),
        }),
      ],
    });
    await app.action("note", createNoteAction);
    await app.action("recall", createRecallAction);
  });

  afterEach(() => {
    app.close();
    rmSync(migrations, { recursive: true, force: true });
  });

  it("runs actions against the app's migrated tables, through a JSON boundary", async () => {
    const result = await app.runAction("note", { text: "hello" });

    expect(result).toEqual({ status: "ok", data: { chat: null, at: "1970-01-01T00:00:00.000Z" } });
    const rows = app.db.connection.all(sql`SELECT text FROM demo__notes`);
    expect(rows).toEqual([{ text: "hello" }]);
  });

  it("gives actions the channel conversation they run in", async () => {
    const result = await app.inChannel({ channel: "feishu", threadId: "oc_1" }, () =>
      app.runAction("note", { text: "in a group" }),
    );

    expect(result).toMatchObject({ status: "ok", data: { chat: "oc_1" } });
    expect(getCurrentActionContext()).toBeUndefined();
  });

  it("reaches fake channel history and nested actions from inside an action", async () => {
    const result = await app.runAction("recall");

    expect(result).toMatchObject({ status: "ok", data: { saved: { status: "ok" } } });
    expect(app.db.connection.all(sql`SELECT text FROM demo__notes`)).toEqual([{ text: "newest" }]);
    expect(app.channels.queries).toEqual([{ channel: "feishu", query: { limit: 1 } }]);
  });

  it("fails an unknown action the way the host does", async () => {
    await expect(app.runAction("missing")).rejects.toBeInstanceOf(ActionInvocationError);
  });

  it("finds an action through appContext only by its app-prefixed name", async () => {
    await expect(app.appContext.runAction("demo:note", { text: "x" })).resolves.toMatchObject({
      status: "ok",
    });
    await expect(app.appContext.runAction("note", { text: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("fails an action whose nested call fails with handler_error, as the host does", async () => {
    await app.action("calls_missing", (config: ActionConfig, deps: DemoDeps) => ({
      config,
      execute: () => deps.appContext.runAction("demo:missing", {}),
    }));

    await expect(app.runAction("calls_missing")).rejects.toMatchObject({
      actionName: "demo:calls_missing",
      code: "handler_error",
    });
  });

  it("rejects what the host would reject: an undefined result and a detached run", async () => {
    await app.action(
      "forgets_to_return",
      async () =>
        ({
          execute: async () => undefined as never,
        }) as unknown as Action,
    );

    await expect(app.runAction("forgets_to_return")).rejects.toMatchObject({
      code: "unserializable",
    });
    await expect(
      app.appContext.runAction("demo:note", { text: "later" }, { detached: true }),
    ).rejects.toThrow(/detached/);
  });

  it("names the agent runner when an action reaches it", () => {
    const deps = app.deps as unknown as { agentRunner: { run(): unknown } };

    expect(() => deps.agentRunner.run()).toThrow(/agentRunner is not available/);
  });

  it("builds the API handler per request, like the host", async () => {
    let built = 0;
    const api = app.api(() => {
      built++;
      return { handle: async () => Response.json({ built }) };
    });

    await api.request("GET", "/");
    const response = await api.request("GET", "/");

    expect(response.body).toEqual({ built: 2 });
  });

  it("serves the API handler with a guardian caller by default", async () => {
    const api = app.api((ctx: RomeAppContext) => ({
      async handle(request) {
        return Response.json({ path: request.path, caller: request.caller.kind, app: ctx.app.id });
      },
    }));

    const response = await api.request("GET", "/notes/1?x=1");

    expect(response).toMatchObject({
      status: 200,
      body: { path: ["notes", "1"], caller: "guardian", app: "demo" },
    });
  });

  it("runs the app-started hook with in-memory settings", async () => {
    await app.start(({ appContext }) => ({
      async onAppStarted(event) {
        await appContext.repositories.settings.set("seededFor", event.appId);
      },
    }));

    expect(app.settings.get("seededFor")).toBe("demo");
  });

  it("awaits an async createHook, as the host does", async () => {
    await app.start(async ({ appContext }) => ({
      async onAppStarted() {
        await appContext.repositories.settings.set("asyncHook", true);
      },
    }));

    expect(app.settings.get("asyncHook")).toBe(true);
  });

  it("hands a fake agentRunner from options.deps to the app-started hook", async () => {
    const agentRunner = { run: async () => ({}), runForked: async () => ({}) };
    const withRunner = await createTestApp({ appId: "demo", deps: { agentRunner } });

    let seen: unknown;
    await withRunner.start((deps) => {
      seen = deps.agentRunner;
      return { async onAppStarted() {} };
    });

    expect(seen).toBe(agentRunner);
  });
});

describe("createFakeChannels", () => {
  it("narrows by conversation and since, newest first, and records sends", async () => {
    const a = "oc_a" as ConversationId;
    const channels = createFakeChannels([
      channelMessage({
        channel: "feishu",
        text: "a1",
        conversationId: a,
        timestamp: new Date(1000),
      }),
      channelMessage({
        channel: "feishu",
        text: "a2",
        conversationId: a,
        timestamp: new Date(3000),
      }),
      channelMessage({ channel: "feishu", text: "b1", timestamp: new Date(2000) }),
    ]);

    const read = await channels.service.query("feishu", {
      conversationId: a,
      since: new Date(500),
    });
    await channels.service.send("feishu", a, { text: "reply" });

    expect(read.map((m) => m.text)).toEqual(["a2", "a1"]);
    expect(channels.sent).toEqual([
      { channel: "feishu", conversationId: a, message: { text: "reply" } },
    ]);
    expect((await channels.service.query("feishu", { limit: 1 }))[0]?.text).toBe("reply");
  });
});

describe("withChannelContext", () => {
  it("keeps concurrent turns apart", async () => {
    const seen = await Promise.all(
      ["one", "two"].map((threadId) =>
        withChannelContext({ channel: "feishu", threadId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, threadId === "one" ? 10 : 0));
          return getCurrentActionContext()?.channelContext?.threadId;
        }),
      ),
    );

    expect(seen).toEqual(["one", "two"]);
  });
});

describe("withActionContext", () => {
  it("merges a nested call into the outer context, as runWithCurrentActionContext does", async () => {
    const seen = await withActionContext({ executionId: "exec_1", sharedContext: { a: 1 } }, () =>
      withChannelContext({ channel: "feishu", threadId: "oc_1" }, () =>
        runWithCurrentActionContext({ sharedContext: { b: 2 } }, async () =>
          getCurrentActionContext(),
        ),
      ),
    );

    expect(seen).toMatchObject({
      executionId: "exec_1",
      channelContext: { threadId: "oc_1" },
      sharedContext: { a: 1, b: 2 },
    });
  });
});
