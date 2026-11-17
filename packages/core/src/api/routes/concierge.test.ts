import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ConciergeService } from "../../concierge/service.js";
import { ConciergeTasks } from "../../concierge/tasks.js";
import { ConciergeTasksRepository } from "../../db/repositories/concierge-tasks.js";
import { WebChatRepository } from "../../webchat/repository.js";
import { chatMessages } from "../../db/schema.js";
import { ChatsWebChatRepository } from "../../webchat/chats-webchat-repository.js";
import {
  COOKIE_NAME,
  createSession,
  createVisitorSession,
  VISITOR_COOKIE_NAME,
} from "../../access/auth.js";
import { sessionActorMiddleware } from "../../access/session-actor.js";
import type { ApiDeps } from "../deps.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { CONCIERGE_UNREAD_CAP, conciergeRoutes } from "./concierge.js";

const guardian = { headers: { Cookie: `${COOKIE_NAME}=${createSession("guardian-1")}` } };
const visitorCookie = (accountId: string, email: string) => ({
  headers: { Cookie: `${VISITOR_COOKIE_NAME}=${createVisitorSession(accountId, email)}` },
});
/** Ann is on the dashboard allow-list; an app user is not. */
const ann = visitorCookie("acct-ann", "ann@example.com");
const appUser = visitorCookie("acct-app", "app@example.com");
const dashboardAccessState = {
  isCloudEmailAllowed: (email: string) => email === "ann@example.com",
} as unknown as ApiDeps["dashboardAccessState"];

/** The routes behind the actor middleware, as /api mounts them. */
function mount(
  testDb: TestDb,
  concierge: ConciergeService | undefined,
  webchatRepo: ApiDeps["webchatRepo"],
): Hono {
  return new Hono()
    .use("*", sessionActorMiddleware(testDb.db))
    .route("/", conciergeRoutes({ concierge, dashboardAccessState, webchatRepo }));
}

describe("GET /concierge/session", () => {
  let testDb: TestDb;
  let webchatRepo: WebChatRepository;
  // Signed under the fake clock, so the session has not expired by then.
  const asGuardian = () => ({
    headers: { Cookie: `${COOKIE_NAME}=${createSession("guardian-1")}` },
  });
  const asAnn = () => visitorCookie("acct-ann", "ann@example.com");

  const app = () => {
    const concierge = {
      ensureChatId: async (owner: string) => {
        const id = owner === "guardian" ? "concierge" : `concierge-${owner.replace(":", "-")}`;
        if (!(await webchatRepo.getSession(id))) await webchatRepo.createSession(id, "Concierge");
        return id;
      },
    } as unknown as ConciergeService;
    return mount(testDb, concierge, webchatRepo);
  };

  beforeEach(() => {
    testDb = createTestDb();
    // The repository production wires: what Rome says lands in Chats.
    webchatRepo = new ChatsWebChatRepository(testDb.db);
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  it("returns the chat with the agent messages it got since the last read", async () => {
    await expect((await app().request("/concierge/session", asGuardian())).json()).resolves.toEqual(
      {
        id: "concierge",
        unread: 0,
      },
    );

    rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
    await webchatRepo.addBackendMessage("concierge", "turn-1", [{ type: "text", content: "Hi." }]);
    await webchatRepo.addBackendMessage("concierge", "turn-1", [
      { type: "text", content: "Done." },
    ]);
    await expect((await app().request("/concierge/session", asGuardian())).json()).resolves.toEqual(
      {
        id: "concierge",
        unread: 2,
      },
    );

    await webchatRepo.markSessionRead("concierge");
    await expect((await app().request("/concierge/session", asGuardian())).json()).resolves.toEqual(
      {
        id: "concierge",
        unread: 0,
      },
    );
  });

  it("caps the count", async () => {
    await app().request("/concierge/session", asGuardian());
    rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
    for (let index = 0; index <= CONCIERGE_UNREAD_CAP; index += 1) {
      await webchatRepo.addBackendMessage("concierge", "turn-1", [
        { type: "text", content: `${index}` },
      ]);
    }
    const body = (await (await app().request("/concierge/session", asGuardian())).json()) as {
      unread: number;
    };
    expect(body.unread).toBe(CONCIERGE_UNREAD_CAP);
  });

  it("answers a dashboard admin with their own main chat, and nobody else", async () => {
    await expect((await app().request("/concierge/session", asAnn())).json()).resolves.toEqual({
      id: "concierge-visitor-acct-ann",
      unread: 0,
    });
    expect((await app().request("/concierge/session", appUser)).status).toBe(401);
    expect((await app().request("/concierge/session")).status).toBe(401);
  });
});

describe("/concierge/connectors", () => {
  let testDb: TestDb;
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
    const concierge = { following } as unknown as ConciergeService;
    return mount(testDb, concierge, new WebChatRepository(testDb.db));
  };
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers the same structure the Concierge reads, for the guardian only, ", async () => {
    expect((await app().request("/concierge/connectors")).status).toBe(401);
    await expect((await app().request("/concierge/connectors", guardian)).json()).resolves.toEqual(
      listing,
    );
  });
});

describe("/concierge/chats", () => {
  let testDb: TestDb;
  let webchatRepo: WebChatRepository;
  const started: Array<string | undefined> = [];

  const app = () => {
    const concierge = {
      listChats: async () => [
        { id: "concierge", name: "Concierge", main: true },
        { id: "topic-1", name: "Calendar", main: false },
      ],
      startTopicChat: async (_owner: string, name?: string) => {
        started.push(name);
        return { id: "topic-2", name: name?.trim() ?? "", main: false };
      },
    } as unknown as ConciergeService;
    return mount(testDb, concierge, webchatRepo);
  };

  beforeEach(() => {
    testDb = createTestDb();
    webchatRepo = new ChatsWebChatRepository(testDb.db);
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

  it("answers only the guardian", async () => {
    expect((await app().request("/concierge/chats")).status).toBe(401);
    expect((await app().request("/concierge/chats", { method: "POST", body: "{}" })).status).toBe(
      401,
    );
  });
});

describe("GET /concierge/chats/:chatId/follows-and-tasks", () => {
  let testDb: TestDb;
  const asked: [string, string][] = [];
  const chats = new Map([
    ["concierge", { id: "concierge", name: "Concierge", main: true }],
    ["topic-1", { id: "topic-1", name: "Calendar", main: false }],
    ["ann-topic", { id: "ann-topic", name: "Trips", main: false }],
  ]);
  const owners = new Map([
    ["concierge", "guardian"],
    ["topic-1", "guardian"],
    ["ann-topic", "visitor:acct-ann"],
  ]);
  const app = () =>
    mount(
      testDb,
      {
        conciergeChat: async (id: string) => chats.get(id) ?? null,
        ownerOfChat: async (id: string) => owners.get(id) ?? null,
        followsAndTasksOf: async (id: string, owner: string) => {
          asked.push([id, owner]);
          return {
            follows: [{ source: "github", label: "GitHub", target: "acme/widgets" }],
            openTasks: [{ id: "t-1", title: "Fix login", sessionId: "task-1" }],
            movedFollows: [{ source: "gmail", label: "Gmail", target: "me@example.com" }],
          };
        },
      } as unknown as ConciergeService,
      new ChatsWebChatRepository(testDb.db),
    );
  beforeEach(() => {
    testDb = createTestDb();
    asked.length = 0;
  });
  afterEach(() => testDb.close());

  it("answers the caller's own topic chat's follows, open tasks and moved follows, without the task chat", async () => {
    const res = await app().request("/concierge/chats/topic-1/follows-and-tasks", guardian);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      follows: [{ source: "github", label: "GitHub", target: "acme/widgets" }],
      openTasks: [{ id: "t-1", title: "Fix login" }],
      movedFollows: [{ source: "gmail", label: "Gmail", target: "me@example.com" }],
    });
    expect(asked).toEqual([["topic-1", "guardian"]]);
  });

  it("answers 404 for the main chat, another person's topic chat and a chat that is not there", async () => {
    const get = (id: string, who: object = guardian) =>
      app().request(`/concierge/chats/${id}/follows-and-tasks`, who);
    expect((await get("concierge")).status).toBe(404);
    // Ann's chat is not the guardian's, and the guardian's is not Ann's.
    expect((await get("ann-topic")).status).toBe(404);
    expect((await get("topic-1", ann)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
    expect(asked).toEqual([]);
    expect((await get("ann-topic", ann)).status).toBe(200);
    expect((await get("topic-1", { headers: {} })).status).toBe(401);
  });
});

describe("without the Concierge service", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  it("404s every route", async () => {
    const app = mount(testDb, undefined, new ChatsWebChatRepository(testDb.db));
    for (const path of ["/concierge/session", "/concierge/chats", "/concierge/connectors"]) {
      expect((await app.request(path, guardian)).status, path).toBe(404);
    }
    const post = await app.request("/concierge/chats", { method: "POST", body: "{}", ...guardian });
    expect(post.status).toBe(404);
  });
});

describe("POST /concierge/chats/:chatId/service-connected", () => {
  let testDb: TestDb;
  const serviceConnected = rs.fn();
  const chatOwners: Record<string, string> = { concierge: "guardian", "topic-1": "guardian" };

  const app = () => {
    const concierge = {
      following: {
        list: async () => ({
          connectors: [
            { service: "mail", state: "working" },
            { service: "code", state: null },
            { service: "chat", state: "broken" },
          ],
          rules: {},
        }),
      },
      conciergeChat: async (id: string) =>
        id in chatOwners ? { id, name: id, main: false } : null,
      ownerOfChat: async (id: string) => chatOwners[id] ?? null,
      serviceConnected,
    } as unknown as ConciergeService;
    return mount(testDb, concierge, {} as ApiDeps["webchatRepo"]);
  };

  const post = (chatId: string, body: unknown, who: object = guardian) =>
    app().request(`/concierge/chats/${chatId}/service-connected`, {
      method: "POST",
      headers: { ...(who as { headers: object }).headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    testDb = createTestDb();
    serviceConnected.mockClear();
  });

  afterEach(() => testDb.close());

  it("tells the Concierge in that chat of a service that works now", async () => {
    const res = await post("topic-1", { service: "mail" });

    expect(res.status).toBe(202);
    expect(serviceConnected).toHaveBeenCalledWith("topic-1", "mail");
  });

  it.each(["code", "chat", "fax", ""])("refuses %j, which is not working", async (service) => {
    const res = await post("concierge", { service });

    expect(res.status).toBe(409);
    expect(serviceConnected).not.toHaveBeenCalled();
  });

  it("refuses a body that names no service", async () => {
    expect((await post("concierge", {})).status).toBe(409);
    expect(serviceConnected).not.toHaveBeenCalled();
  });

  it("404s a chat that is not a Concierge chat of the caller", async () => {
    expect((await post("gone", { service: "mail" })).status).toBe(404);
    // Ann's own Concierge is not the guardian's chat.
    expect((await post("concierge", { service: "mail" }, ann)).status).toBe(404);
    expect(serviceConnected).not.toHaveBeenCalled();
  });

  it("answers 401 to a caller with no Concierge", async () => {
    expect((await post("concierge", { service: "mail" }, appUser)).status).toBe(401);
    expect(serviceConnected).not.toHaveBeenCalled();
  });
});
