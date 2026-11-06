import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ConciergeService } from "../../concierge/service.js";
import { ConciergeTasks } from "../../concierge/tasks.js";
import { ConciergeTasksRepository } from "../../db/repositories/concierge-tasks.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { chatMessages } from "../../db/schema.js";
import { ChatsWebChatRepository } from "../../webchat/chats-webchat-repository.js";
import { COOKIE_NAME, createSession } from "../../lib/auth.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { CONCIERGE_UNREAD_CAP, conciergeRoutes } from "./concierge.js";

describe("GET /concierge/session", () => {
  let testDb: TestDb;
  let webchatRepo: WebChatRepository;
  let enabled: boolean;

  const app = () => {
    const concierge = {
      isEnabled: async () => enabled,
      ensureChatId: async () => {
        if (!(await webchatRepo.getSession("concierge"))) {
          await webchatRepo.createSession("concierge", "Concierge");
        }
        return "concierge";
      },
    } as unknown as ConciergeService;
    return new Hono().route("/", conciergeRoutes({ concierge, db: testDb.db, webchatRepo }));
  };

  beforeEach(() => {
    testDb = createTestDb();
    // The repository production wires: what Rome says lands in Chats.
    webchatRepo = new ChatsWebChatRepository(testDb.db);
    enabled = true;
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  it("returns the chat with the agent messages it got since the last read", async () => {
    await expect((await app().request("/concierge/session")).json()).resolves.toEqual({
      id: "concierge",
      unread: 0,
    });

    rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
    await webchatRepo.addBackendMessage("concierge", "turn-1", [{ type: "text", content: "Hi." }]);
    await webchatRepo.addBackendMessage("concierge", "turn-1", [
      { type: "text", content: "Done." },
    ]);
    await expect((await app().request("/concierge/session")).json()).resolves.toEqual({
      id: "concierge",
      unread: 2,
    });

    await webchatRepo.markSessionRead("concierge");
    await expect((await app().request("/concierge/session")).json()).resolves.toEqual({
      id: "concierge",
      unread: 0,
    });
  });

  it("caps the count", async () => {
    await app().request("/concierge/session");
    rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
    for (let index = 0; index <= CONCIERGE_UNREAD_CAP; index += 1) {
      await webchatRepo.addBackendMessage("concierge", "turn-1", [
        { type: "text", content: `${index}` },
      ]);
    }
    const body = (await (await app().request("/concierge/session")).json()) as { unread: number };
    expect(body.unread).toBe(CONCIERGE_UNREAD_CAP);
  });

  it("404s while Concierge is off", async () => {
    enabled = false;
    expect((await app().request("/concierge/session")).status).toBe(404);
  });
});

describe("GET /concierge/tasks", () => {
  const DAY = 86_400_000;
  const guardian = { headers: { Cookie: `${COOKIE_NAME}=${createSession("guardian-1")}` } };
  let testDb: TestDb;
  let repo: ConciergeTasksRepository;
  let enabled: boolean;

  const app = () => {
    const concierge = {
      isEnabled: async () => enabled,
      deps: { tasks: new ConciergeTasks(repo) },
    } as unknown as ConciergeService;
    return new Hono().route(
      "/",
      conciergeRoutes({
        concierge,
        db: testDb.db,
        webchatRepo: new ChatsWebChatRepository(testDb.db),
      }),
    );
  };
  const titles = async (query = "") =>
    (
      (await (await app().request(`/concierge/tasks${query}`, guardian)).json()) as {
        tasks: Array<{ title: string }>;
      }
    ).tasks
      .map((task) => task.title)
      .sort();

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new ConciergeTasksRepository(testDb.db);
    enabled = true;
    const old = new Date(Date.now() - 30 * DAY);
    await repo.upsertMany([{ title: "Old needs you", state: "needs_user" }], old);
    await repo.upsertMany([{ title: "Old watching", state: "watching" }], old);
    await repo.upsertMany([{ title: "Old done", state: "done" }], old);
    await repo.upsertMany(
      [{ title: "Fresh dropped", state: "dropped" }],
      new Date(Date.now() - DAY),
    );
  });
  afterEach(() => testDb.close());

  it("returns open rows whatever their age and finished rows from the last 7 days", async () => {
    expect(await titles()).toEqual(["Fresh dropped", "Old needs you", "Old watching"]);
  });

  it("widens the finished window with doneDays", async () => {
    expect(await titles("?doneDays=60")).toEqual([
      "Fresh dropped",
      "Old done",
      "Old needs you",
      "Old watching",
    ]);
    expect(await titles("?doneDays=junk")).toEqual([
      "Fresh dropped",
      "Old needs you",
      "Old watching",
    ]);
  });

  it("carries the linked chat's id and current name, and leaves archived rows out", async () => {
    const chats = new ChatsWebChatRepository(testDb.db);
    await chats.createSession("chat-1", "Chat one");
    const [row] = await repo.upsertMany([{ title: "Linked", state: "doing", sessionId: "chat-1" }]);
    await chats.updateSessionName("chat-1", "Renamed");
    const body = (await (await app().request("/concierge/tasks", guardian)).json()) as {
      tasks: Array<{ id: string; chat: unknown }>;
    };
    expect(body.tasks.find((task) => task.id === row.id)?.chat).toEqual({
      id: "chat-1",
      name: "Renamed",
    });
    await repo.upsertMany([{ id: row.id, archived: true }]);
    expect(await titles()).not.toContain("Linked");
  });

  it("carries the source message's id while the message exists, and null after it is gone", async () => {
    const chats = new ChatsWebChatRepository(testDb.db);
    await chats.createSession("concierge", "Concierge");
    const { id } = await chats.addBackendMessage("concierge", "turn-1", [
      { type: "text", content: "Which account?" },
    ]);
    const [row] = await repo.upsertMany([
      { title: "Pay", state: "needs_user", sourceMessageId: id },
    ]);
    const sourceOf = async () =>
      (
        (await (await app().request("/concierge/tasks", guardian)).json()) as {
          tasks: Array<{ id: string; sourceMessageId: string | null }>;
        }
      ).tasks.find((task) => task.id === row.id)?.sourceMessageId;
    expect(await sourceOf()).toBe(id);
    testDb.db.delete(chatMessages).where(eq(chatMessages.key, id)).run();
    expect(await sourceOf()).toBeNull();
  });

  it("404s while Concierge is off", async () => {
    enabled = false;
    expect((await app().request("/concierge/tasks", guardian)).status).toBe(404);
    expect((await app().request("/concierge/tasks/events", guardian)).status).toBe(404);
  });

  it("answers 401 to a caller that is not the guardian, on the list and on its event stream", async () => {
    for (const path of ["/concierge/tasks", "/concierge/tasks/events"]) {
      const anonymous = await app().request(path);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: "Not authenticated" });
      // A cookie that does not verify is no better than none.
      const forged = await app().request(path, { headers: { Cookie: `${COOKIE_NAME}=forged` } });
      expect(forged.status).toBe(401);
    }
  });

  it("serves the list and opens the event stream for the guardian", async () => {
    expect((await app().request("/concierge/tasks", guardian)).status).toBe(200);
    const stream = await app().request("/concierge/tasks/events", guardian);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });
});

describe("/concierge/connectors", () => {
  const guardian = { headers: { Cookie: `${COOKIE_NAME}=${createSession("guardian-1")}` } };
  let testDb: TestDb;
  let enabled: boolean;
  const listing = {
    connectors: [
      {
        id: "gmail",
        label: "Gmail",
        connection: { status: "connected" },
        act: true,
        watch: {
          status: "ready",
          account: "me@example.com",
          target: null,
          kinds: [{ kind: "new_mail", label: "New mail from people", default: true }],
          options: [],
          follows: [],
        },
      },
      {
        id: "slack",
        label: "Slack",
        connection: {
          status: "not_connected",
          connect: { kind: "rome_oauth", method: "POST", path: "/api/oauth/slack/start" },
        },
        act: false,
        watch: null,
      },
    ],
    rules: { digestTimes: ["09:00", "18:00"], quietHours: null },
  };

  const app = () => {
    const following = {
      list: async () => listing,
    };
    const concierge = { isEnabled: async () => enabled, following } as unknown as ConciergeService;
    return new Hono().route(
      "/",
      conciergeRoutes({ concierge, db: testDb.db, webchatRepo: new WebChatRepository(testDb.db) }),
    );
  };
  beforeEach(() => {
    testDb = createTestDb();
    enabled = true;
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers the same structure the Concierge reads, for the guardian only, while the Concierge is on", async () => {
    expect((await app().request("/concierge/connectors")).status).toBe(401);
    await expect((await app().request("/concierge/connectors", guardian)).json()).resolves.toEqual(
      listing,
    );
    enabled = false;
    expect((await app().request("/concierge/connectors", guardian)).status).toBe(404);
  });
});

describe("/concierge/chats", () => {
  const guardian = { headers: { Cookie: `${COOKIE_NAME}=${createSession("guardian-1")}` } };
  let testDb: TestDb;
  let webchatRepo: WebChatRepository;
  let enabled: boolean;
  const started: Array<string | undefined> = [];

  const app = () => {
    const concierge = {
      isEnabled: async () => enabled,
      listChats: async () => [
        { id: "concierge", name: "Concierge", main: true },
        { id: "topic-1", name: "Calendar", main: false },
      ],
      startTopicChat: async (name?: string) => {
        started.push(name);
        return { id: "topic-2", name: name?.trim() ?? "", main: false };
      },
    } as unknown as ConciergeService;
    return new Hono().route("/", conciergeRoutes({ concierge, db: testDb.db, webchatRepo }));
  };

  beforeEach(() => {
    testDb = createTestDb();
    webchatRepo = new ChatsWebChatRepository(testDb.db);
    enabled = true;
    started.length = 0;
  });
  afterEach(() => testDb.close());

  it("lists the Concierge chats, each with its unread count", async () => {
    await webchatRepo.createSession("concierge", "Concierge");
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
    await webchatRepo.createSession("topic-1", "Calendar");
    rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
    await webchatRepo.addBackendMessage("topic-1", "turn-1", [{ type: "text", content: "Hi." }]);
    rs.useRealTimers();
    await expect((await app().request("/concierge/chats", guardian)).json()).resolves.toEqual({
      chats: [
        { id: "concierge", name: "Concierge", main: true, unread: 0 },
        { id: "topic-1", name: "Calendar", main: false, unread: 1 },
      ],
    });
  });

  it("starts a topic chat by name, and refuses one with no name", async () => {
    const post = (body: unknown) =>
      app().request("/concierge/chats", {
        method: "POST",
        headers: { ...guardian.headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const made = await post({ name: " Trips " });
    expect(made.status).toBe(201);
    await expect(made.json()).resolves.toEqual({
      id: "topic-2",
      name: "Trips",
      main: false,
      unread: 0,
    });
    expect((await post({ name: "  " })).status).toBe(400);
    // No name: an untitled chat, which its first message names.
    expect((await post({})).status).toBe(201);
    expect(started).toEqual([" Trips ", undefined]);
  });

  it("answers only the guardian, and 404s while Concierge is off", async () => {
    expect((await app().request("/concierge/chats")).status).toBe(401);
    expect((await app().request("/concierge/chats", { method: "POST", body: "{}" })).status).toBe(
      401,
    );
    enabled = false;
    expect((await app().request("/concierge/chats", guardian)).status).toBe(404);
  });
});
