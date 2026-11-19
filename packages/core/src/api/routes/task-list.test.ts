import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import {
  TASK_LIST_ENDED_PAGE,
  type TaskLinksResponse,
  type TaskListFollowItem,
  type TaskListResponse,
} from "@rome/api-types/task-list";
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
import { makeTask } from "../../test/task-chats.js";
import { buildTestDeps } from "../../test/helpers.js";
import type { ActionRegistryImpl } from "../../apps/actions/registry.js";
import { routinesRoutes } from "./routines.js";
import { chatTaskListRoutes } from "./task-list.js";

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

describe("/chats/:chatId/tasks", () => {
  let testDb: TestDb;
  let tasks: ConciergeTasksRepository;
  let routines: RoutinesRepository;
  let calls: string[];
  let follows: Record<string, TaskListFollowItem[]>;
  let checks: Record<string, Array<{ id: string; at: number | null; taskId: string | null }>>;
  let taskSource: ConciergeTasks | null;
  let chats: ChatsWebChatRepository;
  /** Makes a task chat, which is a task, for the guardian unless `ownerKey` says otherwise. */
  const task = (input: Parameters<typeof makeTask>[1]) => makeTask({ chats, repo: tasks }, input);
  /** Who listens for routine changes. */
  const routineChanges = new Set<(routineId: string) => void>();

  const app = () => {
    const concierge = {
      deps: {
        tasks: taskSource ?? new ConciergeTasks(tasks),
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
      },
      conciergeChat: async (chatId: string) =>
        OWNERS[chatId] ? { id: chatId, name: chatId, main: true } : null,
      ownerOfChat: async (chatId: string) => OWNERS[chatId] ?? null,
      stopTask: async (taskId: string, by: string) => {
        calls.push(`stop ${taskId} ${by}`);
        return 0;
      },
    } as unknown as ConciergeService;
    const routineEngine = {
      onChange: (listener: (routineId: string) => void) => {
        routineChanges.add(listener);
        return () => routineChanges.delete(listener);
      },
    } as unknown as ApiDeps["routineEngine"];
    return new Hono().use("*", sessionActorMiddleware(testDb.db)).route(
      "/",
      chatTaskListRoutes({
        concierge,
        dashboardAccessState,
        routinesRepo: routines,
        routineRunsRepo: new RoutineRunsRepository(testDb.db),
        routineEngine,
      }),
    );
  };
  const read = async (chatId: string, as = guardian) =>
    (await (await app().request(`/chats/${chatId}/tasks`, as)).json()) as TaskListResponse;
  const kindsIn = (work: TaskListResponse) =>
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
      trigger: {
        type: "schedule",
        localTime: "09:00",
        tzid: "UTC",
        tzMode: "fixed",
        rrule: "FREQ=DAILY",
      },
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
    taskSource = null;
    chats = new ChatsWebChatRepository(testDb.db);
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

  it("lists the task chats by status on the Tasks tab, and checks, follows and routines on their own", async () => {
    const flights = await task({ title: "Flights" });
    await task({ title: "Hotel" });
    const sources = new ConciergeTasks(tasks);
    sources.attachFacts({
      now: () => Date.now(),
      running: (chatId) => chatId === flights.id,
      openWaits: async () => new Map(),
      reportPending: () => [],
      laterOf: async (ids) =>
        new Map(ids.filter((id) => id === flights.id).map((id) => [id, IN_AN_HOUR])),
    });
    taskSource = sources;
    checks.concierge = [
      { id: "on-flights", at: IN_AN_HOUR, taskId: flights.id },
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
        nextAt: IN_AN_HOUR + 2000,
      },
    ];
    await summary("concierge", "Daily summary");

    const work = await read("concierge");
    // A task chat's check shows on its own row; a check no task chat has runs on its own.
    expect(kindsIn(work)).toEqual({
      active: ["task Flights"],
      ended: ["task Hotel"],
      on_its_own: ["check Check lone", "follow rome-os/rome", "routine Daily summary"],
    });
    const row = work.groups.find((group) => group.key === "active")!.items[0];
    expect(row).toMatchObject({
      kind: "task",
      task: { id: flights.id, title: "Flights", chat: { id: flights.id, name: "Flights" } },
      check: { id: "on-flights", at: IN_AN_HOUR, recurring: false },
      schedule: null,
    });
    expect(row).not.toHaveProperty("cardMessageId");
  });

  it("sorts what runs on its own by when it runs next, the rows with no time last", async () => {
    checks.concierge = [
      { id: "later", at: IN_AN_HOUR + 5_000, taskId: null },
      { id: "no-deadline", at: null, taskId: null },
    ];
    follows.concierge = [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "soon",
        state: "active",
        digestTimes: ["09:00"],
        nextAt: IN_AN_HOUR,
      },
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "never",
        state: "off",
        digestTimes: [],
        nextAt: null,
      },
    ];
    const routine = await summary("concierge", "Daily summary");
    await routines.update(routine, { nextRunAt: new Date(IN_AN_HOUR + 1_000) });

    expect(kindsIn(await read("concierge")).on_its_own).toEqual([
      "follow soon",
      "routine Daily summary",
      "check Check later",
      "check Check no-deadline",
      "follow never",
    ]);
  });

  it("gives a routine's schedule its zone, so the row can name a fixed one", async () => {
    await summary("concierge", "Daily summary");

    const work = await read("concierge");
    const row = work.groups.flatMap((group) => group.items).find((item) => item.kind === "routine");
    expect(row).toMatchObject({
      trigger: { type: "schedule", localTime: "09:00", tzid: "UTC", tzMode: "fixed" },
    });
  });

  it("answers the newest ended rows and their count, and older ones from a cursor", async () => {
    const made = await Promise.all(
      Array.from({ length: TASK_LIST_ENDED_PAGE + 3 }, (_, index) =>
        task({ title: `Old ${index}` }),
      ),
    );
    for (const old of made) await tasks.stop(old.id);

    const first = (await read("concierge")).groups.find((group) => group.key === "ended")!;
    expect(first.items).toHaveLength(TASK_LIST_ENDED_PAGE);
    expect(first.total).toBe(TASK_LIST_ENDED_PAGE + 3);
    expect(first.nextCursor).toBeTruthy();

    const res = await app().request(
      `/chats/concierge/tasks?endedBefore=${encodeURIComponent(first.nextCursor!)}`,
      guardian,
    );
    const next = ((await res.json()) as TaskListResponse).groups;
    expect(next.map((group) => group.key)).toEqual(["ended"]);
    expect(next[0]!.items).toHaveLength(3);
    expect(next[0]!.nextCursor).toBeNull();
    // Every ended row once, across the two pages.
    const ids = [...first.items, ...next[0]!.items].map((item) =>
      item.kind === "task" ? item.task.id : "",
    );
    expect(new Set(ids).size).toBe(TASK_LIST_ENDED_PAGE + 3);
  });

  it("shows a guardian and a visitor each only their own chat's work", async () => {
    const theirs = await task({ title: "The guardian's" });
    const hers = await task({ title: "Ann's", chatId: "ann-main", ownerKey: "visitor:acct-ann" });
    for (const row of [theirs, hers]) await tasks.keepEnded([], [row.id]);
    await summary("concierge", "Guardian summary");
    await summary("ann-main", "Ann summary");

    expect(kindsIn(await read("concierge"))).toEqual({
      ended: ["task The guardian's"],
      on_its_own: ["routine Guardian summary"],
    });
    expect(kindsIn(await read("ann-main", ann))).toEqual({
      ended: ["task Ann's"],
      on_its_own: ["routine Ann summary"],
    });
    // Another person's chat does not exist to the caller.
    expect((await app().request("/chats/ann-main/tasks", guardian)).status).toBe(404);
    expect((await app().request("/chats/concierge/tasks", ann)).status).toBe(404);
    expect((await app().request("/chats/concierge/tasks", appUser)).status).toBe(401);
    expect((await app().request("/chats/concierge/tasks")).status).toBe(401);
  });

  it("shows a routine made in one of the chat's task chats, naming its task, and none of another owner's", async () => {
    // The guardian's task, which set up a routine in its chat and then ended.
    const releases = await task({ id: "rome-releases", title: "Rome releases" });
    // Ann's task, whose chat made a routine of its own.
    await task({
      id: "ann-task",
      title: "Ann's digest",
      chatId: "ann-main",
      ownerKey: "visitor:acct-ann",
    });
    await summary("rome-releases", "Summarize Rome releases");
    await summary("ann-task", "Ann's routine");
    await summary("concierge", "Daily summary");

    const work = await read("concierge");
    expect(kindsIn(work).on_its_own).toEqual([
      "routine Daily summary",
      "routine Summarize Rome releases",
    ]);
    const items = work.groups.find((group) => group.key === "on_its_own")!.items;
    expect(
      items.find((item) => item.kind === "routine" && item.name === "Summarize Rome releases"),
    ).toMatchObject({
      fromTask: { id: releases.id, title: "Rome releases" },
    });
    expect(
      items.find((item) => item.kind === "routine" && item.name === "Daily summary"),
    ).not.toHaveProperty("fromTask");
    // Ann sees her own task chat's routine, and never the guardian's.
    expect(kindsIn(await read("ann-main", ann)).on_its_own).toEqual(["routine Ann's routine"]);
  });

  it("shows an empty tab with no groups", async () => {
    expect(await read("concierge")).toEqual({ chatId: "concierge", groups: [] });
  });

  it("stops a task of the chat for its owner only", async () => {
    const flights = await task({ title: "Flights" });
    const stop = (chatId: string, as = guardian) =>
      app().request(`/chats/${chatId}/tasks/${flights.id}/stop`, { ...as, method: "POST" });

    expect((await stop("concierge", ann)).status).toBe(404);
    expect((await stop("ann-main", ann)).status).toBe(404);
    expect(calls).toEqual([]);
    expect((await stop("concierge")).status).toBe(200);
    expect(calls).toEqual([`stop ${flights.id} guardian`]);
  });

  it("answers a task link only for a task chat of the caller's own Concierge chat", async () => {
    const flights = await task({ title: "Flights" });
    const annsTask = await task({
      title: "Ann's",
      chatId: "ann-main",
      ownerKey: "visitor:acct-ann",
    });
    const links = async (chatId: string, ids: string[], as = guardian) =>
      (await (
        await app().request(`/chats/${chatId}/task-links?ids=${ids.join(",")}`, as)
      ).json()) as TaskLinksResponse;

    // Its live name and status, as the link draws it.
    await chats.updateSessionName(flights.id, "Book direct flights");
    expect(await links("concierge", [flights.id, "no-such-chat", annsTask.id])).toEqual({
      tasks: [{ id: flights.id, name: "Book direct flights", status: "ended", endReason: "done" }],
    });
    // Another owner's task chat reads as none, and so does another Concierge chat's.
    expect(
      (await links("ann-main", [annsTask.id, flights.id], ann)).tasks.map((t) => t.id),
    ).toEqual([annsTask.id]);
    // Another person's chat does not exist to the caller.
    expect((await app().request("/chats/ann-main/task-links?ids=x", guardian)).status).toBe(404);
  });

  it("lists a routine a draft card in the chat turned on", async () => {
    const deps = await buildTestDeps(testDb.db);
    (deps.actionRegistry as ActionRegistryImpl).register({
      config: {
        name: "wake",
        type: "system",
        description: "test stub",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "read-only",
      },
      execute: async () => ({ status: "ok" }),
    });
    const routineEngine = {
      hasProvider: () => true,
      activate: async () => {},
      onChange: () => () => {},
    } as unknown as ApiDeps["routineEngine"];
    const concierge = { ownerOfChat: async (chatId: string) => OWNERS[chatId] ?? null };
    const card = new Hono().use("*", sessionActorMiddleware(testDb.db)).route(
      "/",
      routinesRoutes({
        ...deps,
        routineEngine,
        concierge: concierge as unknown as ConciergeService,
        dashboardAccessState,
      }),
    );
    // The card's "Turn it on" in chat ann-main: a routine whose args name no chat.
    const turnOn = (as: typeof guardian) =>
      card.request("/routines", {
        ...as,
        method: "POST",
        headers: { ...as.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Morning nudge",
          trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "08:00" },
          actionName: "wake",
          args: {},
          chatId: "ann-main",
        }),
      });
    // Only the chat's owner turns it on there.
    expect((await turnOn(guardian)).status).toBe(404);
    expect((await turnOn(ann)).status).toBe(201);
    expect(kindsIn(await read("ann-main", ann))).toEqual({
      on_its_own: ["routine Morning nudge"],
    });
    expect(kindsIn(await read("concierge"))).toEqual({});
  });

  it("tells the chat's list to read again when a routine of one of its task chats changes", async () => {
    await task({ id: "rome-releases", title: "Rome releases" });
    const made = await summary("rome-releases", "Summarize Rome releases");
    const stream = await app().request("/chats/concierge/tasks/events", guardian);
    const reader = stream.body!.getReader();
    for (const listener of routineChanges) listener(made);
    let text = "";
    while (!text.includes("tasks_changed")) {
      text += new TextDecoder().decode((await reader.read()).value);
    }
    expect(text).toContain('"chatId":"concierge"');
    await reader.cancel();
  });

  it("opens the change stream for the chat's owner only", async () => {
    expect((await app().request("/chats/concierge/tasks/events", ann)).status).toBe(404);
    const stream = await app().request("/chats/concierge/tasks/events", guardian);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });
});
