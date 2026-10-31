import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ConciergeService } from "../../concierge/service.js";
import { ConciergeTasks } from "../../concierge/tasks.js";
import { ConciergeTasksRepository } from "../../db/repositories/concierge-tasks.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { romeAgentMessages } from "../../db/schema.js";
import { COOKIE_NAME, createSession } from "../../lib/auth.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
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
    webchatRepo = new WebChatRepository(testDb.db);
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
        webchatRepo: new WebChatRepository(testDb.db),
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
    const chats = new WebChatRepository(testDb.db);
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
    const chats = new WebChatRepository(testDb.db);
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
    testDb.db.delete(romeAgentMessages).where(eq(romeAgentMessages.id, id)).run();
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
