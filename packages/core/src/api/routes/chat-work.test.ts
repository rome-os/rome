import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import type { ChatWorkFollowItem, ChatWorkResponse } from "@rome/api-types/chat-work";
import type { ConciergeService } from "../../concierge/service.js";
import { ConciergeTasks } from "../../concierge/tasks.js";
import { ConciergeTasksRepository } from "../../db/repositories/concierge-tasks.js";
import { RoutineRunsRepository } from "../../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../../db/repositories/routines.js";
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
import { chatWorkRoutes } from "./chat-work.js";

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

/** Each Concierge chat and its owner. */
const OWNERS: Record<string, string> = {
  concierge: "guardian",
  "ann-main": "visitor:acct-ann",
};

const IN_AN_HOUR = Date.now() + 60 * 60 * 1000;

describe("/chats/:chatId/work", () => {
  let testDb: TestDb;
  let tasks: ConciergeTasksRepository;
  let routines: RoutinesRepository;
  let calls: string[];
  let follows: Record<string, ChatWorkFollowItem[]>;
  let checks: Record<string, Array<{ id: string; at: number | null; taskId: string | null }>>;

  const app = () => {
    const concierge = {
      deps: {
        tasks: new ConciergeTasks(tasks),
        checks: {
          inChatForApi: async (chatId: string) =>
            (checks[chatId] ?? []).map((check) => ({
              ...check,
              name: `Check ${check.id}`,
              waitingFor: null,
            })),
        },
      },
      following: {
        followsIn: async (chatId: string) => follows[chatId] ?? [],
        unfollow: async (source: string, target: string, owner: string) => {
          calls.push(`unfollow ${source} ${target} ${owner}`);
          return { removed: true };
        },
      },
      conciergeChat: async (chatId: string) =>
        OWNERS[chatId] ? { id: chatId, name: chatId, main: true } : null,
      ownerOfChat: async (chatId: string) => OWNERS[chatId] ?? null,
      stopTask: async (taskId: string, by: string) => {
        calls.push(`stop ${taskId} ${by}`);
        return 0;
      },
      cancelCheckByOwner: async (chatId: string, checkId: string) => {
        const found = (checks[chatId] ?? []).some((check) => check.id === checkId);
        if (found) calls.push(`cancel ${chatId} ${checkId}`);
        return found;
      },
    } as unknown as ConciergeService;
    const routineEngine = {
      activate: async (routine: { id: string }) => void calls.push(`activate ${routine.id}`),
      deactivate: async (id: string) => void calls.push(`deactivate ${id}`),
      onChange: () => () => {},
    } as unknown as ApiDeps["routineEngine"];
    return new Hono().use("*", sessionActorMiddleware(testDb.db)).route(
      "/",
      chatWorkRoutes({
        concierge,
        dashboardAccessState,
        routinesRepo: routines,
        routineRunsRepo: new RoutineRunsRepository(testDb.db),
        routineEngine,
      }),
    );
  };
  const read = async (chatId: string, as = guardian) =>
    (await (await app().request(`/chats/${chatId}/work`, as)).json()) as ChatWorkResponse;
  const kindsIn = (work: ChatWorkResponse) =>
    Object.fromEntries(
      work.groups.map((group) => [
        group.key,
        group.items.map((item) =>
          item.kind === "task"
            ? `task ${item.task.title}`
            : item.kind === "check"
              ? `check ${item.check.name}`
              : item.kind === "follow"
                ? `follow ${item.target}`
                : `routine ${item.name}`,
        ),
      ]),
    );
  const summary = (chatId: string, name: string) =>
    routines.create({
      name,
      trigger: { type: "schedule", localTime: "09:00", tzid: "UTC", rrule: "FREQ=DAILY" },
      actionName: "send_user_message",
      args: { sessionId: chatId, text: "Summarize my day." },
    });

  beforeEach(async () => {
    testDb = createTestDb();
    tasks = new ConciergeTasksRepository(testDb.db);
    routines = new RoutinesRepository(testDb.db);
    calls = [];
    follows = {};
    checks = {};
    const chats = new ChatsWebChatRepository(testDb.db);
    await chats.createSession(
      "ann-main",
      "Concierge",
      undefined,
      undefined,
      undefined,
      undefined,
      "core:concierge",
      "webchat",
      null,
      { ownerKey: "visitor:acct-ann" },
    );
  });
  afterEach(() => testDb.close());

  it("lists the chat's tasks, checks, follows and routines in their groups", async () => {
    const [flights] = await tasks.upsertMany([{ title: "Flights" }]);
    checks.concierge = [
      { id: "on-flights", at: IN_AN_HOUR, taskId: flights!.id },
      { id: "lone", at: IN_AN_HOUR + 1000, taskId: null },
    ];
    follows.concierge = [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: ["09:00"],
      },
    ];
    await summary("concierge", "Daily summary");

    const work = await read("concierge");
    expect(kindsIn(work)).toEqual({
      later: ["task Flights", "check Check lone"],
      on_its_own: ["follow rome-os/rome", "routine Daily summary"],
    });
    // The task's check shows on its own row, not as a row of its own.
    const [row] = work.groups[0]!.items;
    expect(row).toMatchObject({
      kind: "task",
      check: { id: "on-flights", at: IN_AN_HOUR, recurring: false },
      schedule: null,
    });
  });

  it("shows a guardian and a visitor each only their own chat's work", async () => {
    await tasks.upsertMany([{ title: "The guardian's" }]);
    await tasks.upsertMany([{ title: "Ann's", chatId: "ann-main" }]);
    await summary("concierge", "Guardian summary");
    await summary("ann-main", "Ann summary");

    expect(kindsIn(await read("concierge"))).toEqual({
      later: ["task The guardian's"],
      on_its_own: ["routine Guardian summary"],
    });
    expect(kindsIn(await read("ann-main", ann))).toEqual({
      later: ["task Ann's"],
      on_its_own: ["routine Ann summary"],
    });
    // Another person's chat does not exist to the caller.
    expect((await app().request("/chats/ann-main/work", guardian)).status).toBe(404);
    expect((await app().request("/chats/concierge/work", ann)).status).toBe(404);
    expect((await app().request("/chats/concierge/work", appUser)).status).toBe(401);
    expect((await app().request("/chats/concierge/work")).status).toBe(401);
  });

  it("shows an empty tab with no groups", async () => {
    expect(await read("concierge")).toEqual({ chatId: "concierge", groups: [] });
  });

  it("pauses, resumes and deletes a routine of the chat for its owner only", async () => {
    const id = await summary("concierge", "Daily summary");
    const post = (path: string, as = guardian, method = "POST") =>
      app().request(`/chats/${path}`, { ...as, method });

    // Ann reaches it neither through her chat nor through the guardian's.
    expect((await post(`ann-main/work/routines/${id}/pause`, ann)).status).toBe(404);
    expect((await post(`concierge/work/routines/${id}/pause`, ann)).status).toBe(404);
    expect((await post(`concierge/work/routines/${id}`, ann, "DELETE")).status).toBe(404);
    expect((await routines.findById(id))?.enabled).toBe(true);

    expect((await post(`concierge/work/routines/${id}/pause`)).status).toBe(200);
    expect((await routines.findById(id))?.enabled).toBe(false);
    const paused = (await read("concierge")).groups[0]!.items[0];
    expect(paused).toMatchObject({ kind: "routine", enabled: false, nextRunAt: null });

    expect((await post(`concierge/work/routines/${id}/resume`)).status).toBe(200);
    expect((await routines.findById(id))?.enabled).toBe(true);
    expect(calls).toEqual([`deactivate ${id}`, `deactivate ${id}`, `activate ${id}`]);

    expect((await post(`concierge/work/routines/${id}`, guardian, "DELETE")).status).toBe(200);
    expect(await routines.findById(id)).toBeNull();
    expect(await read("concierge")).toEqual({ chatId: "concierge", groups: [] });
  });

  it("stops a task, cancels a check and unfollows for the chat's owner only", async () => {
    const [flights] = await tasks.upsertMany([{ title: "Flights" }]);
    checks.concierge = [{ id: "lone", at: IN_AN_HOUR, taskId: null }];
    follows.concierge = [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: [],
      },
    ];
    const post = (path: string, as = guardian, init: RequestInit = { method: "POST" }) =>
      app().request(`/chats/${path}`, { ...as, ...init });
    const unfollow = (chatId: string, as = guardian) =>
      post(`${chatId}/work/follows/unfollow`, as, {
        method: "POST",
        body: JSON.stringify({ source: "github", target: "rome-os/rome" }),
        headers: { ...as.headers, "content-type": "application/json" },
      });

    expect((await post(`concierge/work/tasks/${flights!.id}/stop`, ann)).status).toBe(404);
    expect((await post(`ann-main/work/tasks/${flights!.id}/stop`, ann)).status).toBe(404);
    expect((await post("concierge/work/checks/lone", ann, { method: "DELETE" })).status).toBe(404);
    expect((await post("ann-main/work/checks/lone", ann, { method: "DELETE" })).status).toBe(404);
    expect((await unfollow("concierge", ann)).status).toBe(404);
    expect((await unfollow("ann-main", ann)).status).toBe(404);
    expect(calls).toEqual([]);

    expect((await post(`concierge/work/tasks/${flights!.id}/stop`)).status).toBe(200);
    expect((await post("concierge/work/checks/lone", guardian, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await unfollow("concierge")).status).toBe(200);
    expect(calls).toEqual([
      `stop ${flights!.id} guardian`,
      "cancel concierge lone",
      "unfollow github rome-os/rome guardian",
    ]);
  });

  it("opens the change stream for the chat's owner only", async () => {
    expect((await app().request("/chats/concierge/work/events", ann)).status).toBe(404);
    const stream = await app().request("/chats/concierge/work/events", guardian);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });
});
