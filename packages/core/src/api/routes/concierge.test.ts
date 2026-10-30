import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import type { ConciergeService } from "../../concierge/service.js";
import { ConciergeTasks } from "../../concierge/tasks.js";
import { ConciergeTasksRepository } from "../../db/repositories/concierge-tasks.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
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
    return new Hono().route("/", conciergeRoutes({ concierge, webchatRepo }));
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
      conciergeRoutes({ concierge, webchatRepo: new WebChatRepository(testDb.db) }),
    );
  };
  const titles = async (query = "") =>
    (
      (await (await app().request(`/concierge/tasks${query}`)).json()) as {
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
    const body = (await (await app().request("/concierge/tasks")).json()) as {
      tasks: Array<{ id: string; chat: unknown }>;
    };
    expect(body.tasks.find((task) => task.id === row.id)?.chat).toEqual({
      id: "chat-1",
      name: "Renamed",
    });
    await repo.upsertMany([{ id: row.id, archived: true }]);
    expect(await titles()).not.toContain("Linked");
  });

  it("404s while Concierge is off", async () => {
    enabled = false;
    expect((await app().request("/concierge/tasks")).status).toBe(404);
  });
});
