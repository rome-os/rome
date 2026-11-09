import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { WebSocket } from "ws";
import type { LiveEventsServerMessage } from "@rome/api-types/live-events";
import type { AppCatalog } from "./apps/catalog.js";
import type { CatalogEvent, SubscriberHandler } from "./apps/state.js";
import { subscribeCatalogChanges } from "./api/routes/apps.js";
import { createWebchatRuntime, type WebchatRuntime } from "./api/routes/webchat.js";
import { CONCIERGE_AGENT_ID, canOpenChat } from "./concierge/service.js";
import { ConciergeTasks } from "./concierge/tasks.js";
import { ConciergeTasksRepository } from "./db/repositories/concierge-tasks.js";
import { guardianAuth } from "./db/schema.js";
import { createSession, createVisitorSession } from "./access/auth.js";
import { DashboardAccessState } from "./access/dashboard-access-state.js";
import { PhoneWatching } from "./lib/phone-watching.js";
import { DashboardActivity } from "./lib/dashboard-activity.js";
import {
  attachLiveEventsServer,
  type LiveEventSources,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
} from "./live-events-server.js";
import { buildTestDeps, createTestDb, type TestDb } from "./test/helpers.js";

type ServerMessage = LiveEventsServerMessage;

class TestClient {
  readonly messages: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolves with the first message, received or future, that matches. */
  async next(match: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3_000);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async subscribe(topic: string): Promise<void> {
    this.send({ type: "subscribe", topic });
    await this.next((m) => m.type === "subscribed" && m.topic === topic);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers });
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.on("error", reject);
  });
}

describe("live events WebSocket", () => {
  let testDb: TestDb;
  let projectsRoot: string;
  let server: Server;
  let port: number;
  let runtime: WebchatRuntime;
  let deps: Awaited<ReturnType<typeof buildTestDeps>>;
  let live: { close(): void };
  let activeSubscriptions: number;
  let conciergeTasks: ConciergeTasks;
  let dashboardAccess: DashboardAccessState;
  let phoneWatching: PhoneWatching;
  let dashboardActivity: DashboardActivity;
  const catalogHandlers = new Set<SubscriberHandler>();
  const clients: TestClient[] = [];
  const originalProjectsRoot = process.env.ROME_PROJECTS_ROOT;

  const fireCatalog = (event: Pick<CatalogEvent, "appId" | "change">) => {
    for (const handler of catalogHandlers) void handler({ ...event, current: null });
  };

  async function connect(headers: Record<string, string> = {}): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const client = new TestClient(ws);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    projectsRoot = mkdtempSync(join(tmpdir(), "rome-live-events-"));
    process.env.ROME_PROJECTS_ROOT = projectsRoot;
    testDb = createTestDb();
    await testDb.db.insert(guardianAuth).values({
      id: "auth-1",
      userId: "guardian-1",
      passwordHash: "irrelevant",
      createdAt: new Date(),
    });
    deps = await buildTestDeps(testDb.db);
    conciergeTasks = new ConciergeTasks(new ConciergeTasksRepository(testDb.db));
    runtime = createWebchatRuntime(deps).runtime;
    catalogHandlers.clear();
    const catalog = {
      subscribe(handler: SubscriberHandler) {
        catalogHandlers.add(handler);
        return () => catalogHandlers.delete(handler);
      },
    } as unknown as AppCatalog;
    activeSubscriptions = 0;
    const track = (unsubscribe: () => void) => {
      activeSubscriptions++;
      return () => {
        activeSubscriptions--;
        unsubscribe();
      };
    };
    const sources: LiveEventSources = {
      subscribeChatStatus: (emit) => track(runtime.subscribeStatusEvents(emit)),
      hasChatSession: async (sessionId, owner) =>
        (await runtime.hasStoredSession(sessionId)) &&
        (await canOpenChat((id) => deps.webchatRepo.getSession(id), sessionId, owner)),
      subscribeChatSession: (sessionId, emit) =>
        track(runtime.subscribeSessionEvents(sessionId, emit)),
      subscribeAppCatalog: (emit) => track(subscribeCatalogChanges(catalog, emit)),
      subscribeConciergeTasks: (owner, emit) => track(conciergeTasks.subscribe(emit, owner)),
    };
    server = createServer();
    dashboardAccess = new DashboardAccessState();
    dashboardAccess.setCloudEmailAccess(["visitor@example.com"]);
    phoneWatching = new PhoneWatching();
    dashboardActivity = new DashboardActivity();
    live = attachLiveEventsServer(
      server,
      testDb.db,
      dashboardAccess,
      sources,
      phoneWatching,
      dashboardActivity,
    );
    port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    // The server tears down after the client sees the close, so wait for it
    // before the next test resets the counter.
    await rs.waitFor(() => expect(activeSubscriptions).toBe(0));
    live.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    testDb.close();
    rmSync(projectsRoot, { recursive: true, force: true });
    if (originalProjectsRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = originalProjectsRoot;
  });

  it("admits a guardian and refuses anonymous and cross-origin upgrades", async () => {
    const proxied = { "x-forwarded-for": "203.0.113.1" };
    expect(await upgradeStatus(port, proxied)).toBe(401);

    const cookie = `rome_session=${createSession("guardian-1")}`;
    const forwarded = { "x-forwarded-host": "rome.example", "x-forwarded-proto": "http" };
    expect(
      await upgradeStatus(port, {
        ...proxied,
        ...forwarded,
        cookie,
        origin: "http://other.rome.example",
      }),
    ).toBe(403);
    expect(
      await upgradeStatus(port, {
        ...proxied,
        ...forwarded,
        cookie,
        origin: "http://rome.example",
      }),
    ).toBe(101);
  });

  it("refuses a loopback upgrade from another site's page and admits the dashboard's own", async () => {
    // The in-container browser reaches 127.0.0.1 directly with no cookie or
    // X-Forwarded-For, so only Origin tells the dashboard from a page it visited.
    expect(await upgradeStatus(port, { origin: "https://evil.example" })).toBe(403);
    expect(
      await upgradeStatus(port, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
    ).toBe(403);
    expect(await upgradeStatus(port, { origin: `http://127.0.0.1:${port}` })).toBe(101);
    expect(await upgradeStatus(port, {})).toBe(101);
  });

  it("gives an allow-listed dashboard visitor every topic but the app catalog", async () => {
    const proxied = {
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-host": "rome.example",
      "x-forwarded-proto": "http",
    };
    const visitorCookie = (email: string) =>
      `rome_visitor=${createVisitorSession("account-1", email)}`;
    expect(
      await upgradeStatus(port, {
        ...proxied,
        cookie: visitorCookie("stranger@example.com"),
        origin: "http://rome.example",
      }),
    ).toBe(401);
    expect(
      await upgradeStatus(port, {
        ...proxied,
        cookie: visitorCookie("visitor@example.com"),
        origin: "http://other.rome.example",
      }),
    ).toBe(403);

    await deps.webchatRepo.createSession("sess-a", "A");
    const client = await connect({
      ...proxied,
      cookie: visitorCookie("visitor@example.com"),
      origin: "http://rome.example",
    });
    await client.subscribe("chat.status");
    await client.subscribe("chat.session:sess-a");
    client.send({ type: "subscribe", topic: "apps.catalog" });
    expect(await client.next((m) => m.type === "error")).toEqual({
      type: "error",
      topic: "apps.catalog",
      message: "Forbidden",
    });
    expect(activeSubscriptions).toBe(2);
    expect(catalogHandlers.size).toBe(0);
  });

  it("gives a visitor their own Concierge rows and hides the guardian's Concierge chat", async () => {
    const client = await connect({
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-host": "rome.example",
      "x-forwarded-proto": "http",
      cookie: `rome_visitor=${createVisitorSession("account-1", "visitor@example.com")}`,
      origin: "http://rome.example",
    });
    const conciergeChat = (id: string, ownerKey: string | null) =>
      deps.webchatRepo.createSession(
        id,
        "Concierge",
        undefined,
        undefined,
        undefined,
        undefined,
        CONCIERGE_AGENT_ID,
        "webchat",
        null,
        { ownerKey },
      );
    await conciergeChat("concierge", null);
    await conciergeChat("visitor-main", "visitor:account-1");
    client.send({ type: "subscribe", topic: "chat.session:concierge" });
    expect(
      await client.next((m) => m.type === "error" && m.topic === "chat.session:concierge"),
    ).toMatchObject({ message: "Not found" });
    await client.subscribe("chat.session:visitor-main");

    await client.subscribe("concierge.tasks");
    await conciergeTasks.repo.upsertMany([{ title: "The guardian's", state: "next" }]);
    const [mine] = await conciergeTasks.repo.upsertMany([
      { title: "Mine", state: "next", chatId: "visitor-main" },
    ]);
    expect(
      await client.next((m) => m.type === "event" && m.topic === "concierge.tasks"),
    ).toMatchObject({ data: { task: { id: mine.id, title: "Mine" } } });
  });

  it("pushes each write to the Concierge's todo list on concierge.tasks", async () => {
    const client = await connect();
    await client.subscribe("concierge.tasks");
    const [row] = await conciergeTasks.repo.upsertMany([
      { title: "Fix flaky test", state: "doing" },
    ]);
    expect(
      await client.next((m) => m.type === "event" && m.topic === "concierge.tasks"),
    ).toMatchObject({
      event: "task_upsert",
      data: { task: { id: row.id, title: "Fix flaky test", state: "doing", chat: null } },
    });
  });

  it("stops serving a visitor dropped from the allow-list: no new topics, then no socket", async () => {
    rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await deps.webchatRepo.createSession("sess-a", "A");
      const client = await connect({
        "x-forwarded-for": "203.0.113.1",
        "x-forwarded-host": "rome.example",
        "x-forwarded-proto": "http",
        cookie: `rome_visitor=${createVisitorSession("account-1", "visitor@example.com")}`,
        origin: "http://rome.example",
      });
      await client.subscribe("chat.status");

      dashboardAccess.setCloudEmailAccess([]);
      client.send({ type: "subscribe", topic: "chat.session:sess-a" });
      expect(await client.next((m) => m.type === "error")).toEqual({
        type: "error",
        topic: "chat.session:sess-a",
        message: "Forbidden",
      });

      const closed = new Promise<number>((resolve) => client.ws.once("close", resolve));
      rs.advanceTimersByTime(25_000);
      expect(await closed).toBe(1008);
      await rs.waitFor(() => expect(activeSubscriptions).toBe(0));
    } finally {
      rs.useRealTimers();
    }
  });

  it("acknowledges chat.status before replaying the running snapshot, then streams changes", async () => {
    await deps.webchatRepo.createSession("sess-running", "Running");
    const turn = deps.agentTurnStreamRegistry.register({
      sessionId: "sess-running",
      chatId: "sess-running",
      turnId: "turn-1",
    });
    const client = await connect();
    await client.subscribe("chat.status");

    const snapshot = await client.next((m) => m.type === "event");
    expect(client.messages.indexOf(snapshot)).toBeGreaterThan(
      client.messages.findIndex((m) => m.type === "subscribed"),
    );
    expect(snapshot).toEqual({
      type: "event",
      topic: "chat.status",
      event: "session_running",
      data: { sessionId: "sess-running", running: true },
    });

    turn.finish();
    expect(
      await client.next(
        (m) => m.type === "event" && (m.data as { running: boolean }).running === false,
      ),
    ).toMatchObject({ data: { sessionId: "sess-running", running: false } });
  });

  it("counts only the chat the guardian's phone watches, never its data subscriptions", async () => {
    await deps.webchatRepo.createSession("sess-a", "A");
    await deps.webchatRepo.createSession("sess-b", "B");
    const phone = await connect({ "x-rome-client": "phone" });
    // The phone follows B's data (its name, its rows) but shows A.
    await phone.subscribe("chat.session:sess-b");
    await phone.subscribe("chat.watch:sess-a");
    expect(phoneWatching.isWatching("sess-a")).toBe(true);
    expect(phoneWatching.isWatching("sess-b")).toBe(false);

    // The chat on screen moves to B: the watch moves with it.
    phone.send({ type: "unsubscribe", topic: "chat.watch:sess-a" });
    await phone.subscribe("chat.watch:sess-b");
    await rs.waitFor(() => expect(phoneWatching.isWatching("sess-a")).toBe(false));
    expect(phoneWatching.isWatching("sess-b")).toBe(true);

    // The phone's goodbye: closing stops the count at once.
    await phone.close();
    await rs.waitFor(() => expect(phoneWatching.isWatching("sess-b")).toBe(false));
  });

  it("never counts a watch from the dashboard or a visitor", async () => {
    await deps.webchatRepo.createSession("sess-a", "A");
    const web = await connect();
    await web.subscribe("chat.watch:sess-a");
    expect(phoneWatching.isWatching("sess-a")).toBe(false);
    const visitor = await connect({
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-host": "rome.example",
      "x-forwarded-proto": "http",
      cookie: `rome_visitor=${createVisitorSession("account-1", "visitor@example.com")}`,
      origin: "http://rome.example",
      "x-rome-client": "phone",
    });
    visitor.send({ type: "subscribe", topic: "chat.watch:sess-a" });
    await visitor.next((m) => m.topic === "chat.watch:sess-a");
    expect(phoneWatching.isWatching("sess-a")).toBe(false);
  });

  it("counts the guardian's dashboard as active from its signal until it says away", async () => {
    const web = await connect();
    web.send({ type: "activity", state: "active" });
    // Frames run in order, so this ack means the signal before it is counted.
    await web.subscribe("chat.status");
    expect(dashboardActivity.isActive()).toBe(true);
    web.send({ type: "activity", state: "away" });
    await web.subscribe("apps.catalog");
    expect(dashboardActivity.isActive()).toBe(false);
    expect(web.messages.some((m) => m.type === "error")).toBe(false);
  });

  it("stops counting the guardian's dashboard once its socket closes", async () => {
    const web = await connect();
    web.send({ type: "activity", state: "active" });
    await web.subscribe("chat.status");
    expect(dashboardActivity.isActive()).toBe(true);
    await web.close();
    await rs.waitFor(() => expect(dashboardActivity.isActive()).toBe(false));
  });

  it("never counts activity from a visitor's dashboard or the phone", async () => {
    const visitor = await connect({
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-host": "rome.example",
      "x-forwarded-proto": "http",
      cookie: `rome_visitor=${createVisitorSession("account-1", "visitor@example.com")}`,
      origin: "http://rome.example",
    });
    visitor.send({ type: "activity", state: "active" });
    await visitor.subscribe("chat.status");
    const phone = await connect({ "x-rome-client": "phone" });
    phone.send({ type: "activity", state: "active" });
    await phone.subscribe("chat.status");
    expect(dashboardActivity.isActive()).toBe(false);
  });

  it("forwards session events for the subscribed session only, until unsubscribed", async () => {
    await deps.webchatRepo.createSession("sess-a", "A");
    await deps.webchatRepo.createSession("sess-b", "B");
    const client = await connect();
    await client.subscribe("chat.session:sess-a");

    await deps.webchatRepo.addBackendReplyMessage("sess-b", "turn-b", "Not for this view.");
    await deps.webchatRepo.addBackendReplyMessage("sess-a", "turn-a", "Reply for A.");
    const insert = await client.next((m) => m.type === "event" && m.event === "message_insert");
    expect(insert).toMatchObject({ topic: "chat.session:sess-a" });
    expect(JSON.stringify(insert)).toContain("Reply for A.");
    expect(JSON.stringify(client.messages)).not.toContain("Not for this view.");

    await deps.webchatRepo.updateSessionName("sess-a", "Renamed");
    expect(
      await client.next((m) => m.type === "event" && m.event === "session_name"),
    ).toMatchObject({ data: { sessionId: "sess-a", name: "Renamed" } });

    client.send({ type: "unsubscribe", topic: "chat.session:sess-a" });
    await client.subscribe("apps.catalog");
    expect(activeSubscriptions).toBe(1);
    const before = client.messages.length;
    await deps.webchatRepo.updateSessionName("sess-a", "Renamed again");
    fireCatalog({ appId: "notes", change: "changed" });
    expect(await client.next((m) => m.type === "event" && m.topic === "apps.catalog")).toEqual({
      type: "event",
      topic: "apps.catalog",
      event: "catalog-change",
      data: { appId: "notes", change: "changed" },
    });
    expect(client.messages.slice(before).every((m) => m.topic === "apps.catalog")).toBe(true);
  });

  it("rejects unknown topics, malformed ids, missing sessions, and junk frames", async () => {
    const client = await connect();
    client.send({ type: "subscribe", topic: "turn:abc" });
    client.send({ type: "subscribe", topic: "chat.session:../etc" });
    client.send({ type: "subscribe", topic: "chat.session:missing" });
    client.ws.send("not json");

    expect(await client.next((m) => m.type === "error" && m.topic === "turn:abc")).toMatchObject({
      message: "Unknown topic",
    });
    expect(
      await client.next((m) => m.type === "error" && m.topic === "chat.session:../etc"),
    ).toMatchObject({ message: "Unknown topic" });
    expect(
      await client.next((m) => m.type === "error" && m.topic === "chat.session:missing"),
    ).toMatchObject({ message: "Not found" });
    expect(await client.next((m) => m.type === "error" && m.topic === undefined)).toMatchObject({
      message: "Invalid message",
    });
    expect(client.messages.some((m) => m.type === "subscribed")).toBe(false);
    expect(activeSubscriptions).toBe(0);
  });

  it("caps subscriptions per socket", async () => {
    const client = await connect();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_SOCKET; i++) {
      await deps.webchatRepo.createSession(`sess-${i}`, `Chat ${i}`);
      client.send({ type: "subscribe", topic: `chat.session:sess-${i}` });
    }
    client.send({ type: "subscribe", topic: "chat.status" });
    expect(await client.next((m) => m.type === "error")).toEqual({
      type: "error",
      topic: "chat.status",
      message: "Too many subscriptions",
    });
    await client.next((m) => m.type === "subscribed" && m.topic === "chat.session:sess-31");
    expect(activeSubscriptions).toBe(MAX_SUBSCRIPTIONS_PER_SOCKET);
  });

  it("holds the phone's watch past the cap, one per socket", async () => {
    const phone = await connect({ "x-rome-client": "phone" });
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_SOCKET; i++) {
      await deps.webchatRepo.createSession(`sess-${i}`, `Chat ${i}`);
      phone.send({ type: "subscribe", topic: `chat.session:sess-${i}` });
    }
    await phone.next((m) => m.type === "subscribed" && m.topic === "chat.session:sess-31");
    await phone.subscribe("chat.watch:sess-0");
    expect(phoneWatching.isWatching("sess-0")).toBe(true);

    // A second watch replaces the first rather than adding to it.
    await phone.subscribe("chat.watch:sess-1");
    expect(phoneWatching.isWatching("sess-0")).toBe(false);
    expect(phoneWatching.isWatching("sess-1")).toBe(true);
    expect(phone.messages.some((m) => m.type === "error")).toBe(false);
  });

  it("never counts a watch unsubscribed before its check resolves", async () => {
    await deps.webchatRepo.createSession("sess-a", "A");
    const phone = await connect({ "x-rome-client": "phone" });
    phone.send({ type: "subscribe", topic: "chat.watch:sess-a" });
    phone.send({ type: "unsubscribe", topic: "chat.watch:sess-a" });
    // Frames run in order, so this one resolving means the watch's check has too.
    await phone.subscribe("chat.session:sess-a");
    expect(phoneWatching.isWatching("sess-a")).toBe(false);
    expect(phone.messages.some((m) => m.topic === "chat.watch:sess-a")).toBe(false);
  });

  it("releases every source listener when the socket closes", async () => {
    await deps.webchatRepo.createSession("sess-a", "A");
    const client = await connect();
    await client.subscribe("chat.status");
    await client.subscribe("apps.catalog");
    await client.subscribe("chat.session:sess-a");
    expect(activeSubscriptions).toBe(3);
    expect(catalogHandlers.size).toBe(1);

    await client.close();
    await rs.waitFor(() => expect(activeSubscriptions).toBe(0));
    expect(catalogHandlers.size).toBe(0);
  });
});
