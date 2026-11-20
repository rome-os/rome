import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import {
  TASK_LIST_ENDED_PAGE,
  type TaskListTaskItem,
  groupTaskPanel,
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
import { approvalWaits } from "../../test/open-waits.js";
import { CONCIERGE_DIGEST_ACTION, CONCIERGE_FOLLOW_ACTION } from "../../concierge/following.js";
import { CONCIERGE_TASK_RUN_ACTION } from "../../concierge/task-schedule.js";
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
  let checks: Record<
    string,
    Array<{ id: string; at: number | null; taskId: string | null; recurring?: boolean }>
  >;
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
        unfollow: async (source: string, target: string, owner: string) => {
          calls.push(`unfollow ${source} ${target} ${owner}`);
          return { removed: true };
        },
      },
      cancelCheckByOwner: async (chatId: string, checkId: string) => {
        calls.push(`cancel ${chatId} ${checkId}`);
        return true;
      },
      conciergeChat: async (chatId: string) =>
        OWNERS[chatId] ? { id: chatId, name: chatId, main: true } : null,
      ownerOfChat: async (chatId: string) => OWNERS[chatId] ?? null,
      stopTask: async (taskId: string, by: string) => {
        calls.push(`stop ${taskId} ${by}`);
        return 0;
      },
      markTaskDone: async (taskId: string) => {
        calls.push(`done ${taskId}`);
        return true;
      },
    } as unknown as ConciergeService;
    const routineEngine = {
      onChange: (listener: (routineId: string) => void) => {
        routineChanges.add(listener);
        return () => routineChanges.delete(listener);
      },
      activate: async (routine: { id: string }) => {
        calls.push(`activate ${routine.id}`);
      },
      deactivate: async (id: string) => {
        calls.push(`deactivate ${id}`);
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
  /** The chat's list in the one panel's groups. */
  const readPanel = async (chatId: string, as = guardian) =>
    (await (
      await app().request(`/chats/${chatId}/tasks?grouping=panel`, as)
    ).json()) as TaskListResponse;
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

  it("answers a task link for a task chat of any of the caller's own Concierge chats", async () => {
    const flights = await task({ title: "Flights" });
    await chats.createSession(
      "calendar",
      "Calendar",
      undefined,
      undefined,
      undefined,
      undefined,
      "core:concierge",
      "webchat",
      null,
    );
    const agenda = await task({ title: "Agenda", chatId: "calendar" });
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
      tasks: [
        {
          id: flights.id,
          name: "Book direct flights",
          status: "ended",
          endReason: "done",
        },
      ],
    });
    // A task of another of the owner's Concierge chats draws too.
    expect((await links("concierge", [agenda.id])).tasks).toMatchObject([
      { id: agenda.id, name: "Agenda" },
    ]);
    // Another owner's task chat reads as none.
    expect(
      (await links("ann-main", [annsTask.id, flights.id, agenda.id], ann)).tasks.map((t) => t.id),
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

  describe("in the one panel's groups", () => {
    const github = (target: string): TaskListFollowItem => ({
      kind: "follow",
      source: "github",
      label: "GitHub",
      target,
      state: "active",
      digestTimes: ["09:00", "18:00"],
      nextAt: IN_AN_HOUR + 3_000,
    });
    /** A one-off routine of chat `chatId`, due on a date far ahead. */
    const oneOff = (chatId: string, name: string) =>
      routines.create({
        name,
        trigger: {
          type: "schedule",
          localTime: "09:00",
          tzid: "UTC",
          tzMode: "fixed",
          date: "2099-01-01",
        },
        actionName: "send_user_message",
        args: { sessionId: chatId, text: name },
        nextRunAt: new Date(IN_AN_HOUR + 1_000),
      });

    it("puts each kind in its group: one-offs Later, recurring ones Scheduled", async () => {
      const visa = await task({ title: "Visa" });
      await task({ title: "Hotel" });
      const sources = new ConciergeTasks(tasks);
      sources.attachFacts({
        now: () => Date.now(),
        running: () => false,
        openWaits: async () => new Map(),
        reportPending: () => [],
        laterOf: async (ids) =>
          new Map(ids.filter((id) => id === visa.id).map((id) => [id, IN_AN_HOUR])),
      });
      taskSource = sources;
      checks.concierge = [
        { id: "on-visa", at: IN_AN_HOUR, taskId: visa.id },
        { id: "lone", at: IN_AN_HOUR + 2_000, taskId: null },
      ];
      follows.concierge = [github("rome-os/rome"), github("rome-os/gizmos")];
      await oneOff("concierge", "Water the plants");
      await summary("concierge", "Daily summary");
      await routines.create({
        name: "On new mail",
        trigger: { type: "event-bus", eventName: "mail.received" },
        actionName: "send_user_message",
        args: { sessionId: "concierge", text: "Tell me." },
      });

      expect(kindsIn(await readPanel("concierge"))).toEqual({
        later: ["task Visa", "routine Water the plants", "check Check lone"],
        // One row per follow; a row with no next time last.
        scheduled: [
          "follow rome-os/gizmos",
          "follow rome-os/rome",
          "routine Daily summary",
          "routine On new mail",
        ],
        ended: ["task Hotel"],
      });
      // The two-view grouping, which older iOS builds read, is as it was.
      expect(kindsIn(await read("concierge"))).toEqual({
        later: ["task Visa"],
        on_its_own: [
          "routine Water the plants",
          "check Check lone",
          "follow rome-os/gizmos",
          "follow rome-os/rome",
          "routine Daily summary",
          "routine On new mail",
        ],
        ended: ["task Hotel"],
      });
    });

    it("moves a scheduled task from Active to Needs you to Scheduled across a run", async () => {
      const brief = await task({ title: "Morning brief" });
      const run = await routines.create({
        name: "Morning brief",
        trigger: {
          type: "schedule",
          localTime: "08:00",
          tzid: "UTC",
          tzMode: "fixed",
          rrule: "FREQ=DAILY",
        },
        actionName: CONCIERGE_TASK_RUN_ACTION,
        args: { chatId: brief.id, brief: "Brief me." },
      });
      let phase: "running" | "waiting" | "between" = "running";
      const sources = new ConciergeTasks(tasks);
      sources.attachFacts({
        now: () => Date.now(),
        running: () => phase === "running",
        openWaits: async (ids) =>
          approvalWaits(
            new Map(phase === "waiting" && ids.includes(brief.id) ? [[brief.id, Date.now()]] : []),
          ),
        reportPending: () => [],
        laterOf: async (ids) =>
          new Map(ids.filter((id) => id === brief.id).map((id) => [id, IN_AN_HOUR])),
        recurringOf: async (ids) => new Set(ids.filter((id) => id === brief.id)),
      });
      taskSource = sources;
      checks.concierge = [{ id: run, at: IN_AN_HOUR, taskId: brief.id, recurring: true }];

      expect(kindsIn(await readPanel("concierge"))).toEqual({ active: ["task Morning brief"] });
      phase = "waiting";
      expect(kindsIn(await readPanel("concierge"))).toEqual({
        needs_you: ["task Morning brief"],
      });
      phase = "between";
      const between = await readPanel("concierge");
      expect(kindsIn(between)).toEqual({ scheduled: ["task Morning brief"] });
      expect(between.groups[0]!.items[0]).toMatchObject({
        schedule: { at: "08:00", days: null },
        check: { id: run, at: IN_AN_HOUR, recurring: true },
      });
    });

    it("leaves out a follow's watcher and digest, a routine of no chat, a spent one-off and an archived task", async () => {
      const shown = await summary("concierge", "Daily summary");
      await routines.create({
        name: "Watch rome-os/rome",
        trigger: { type: "event-bus", eventName: "github.push" },
        actionName: CONCIERGE_FOLLOW_ACTION,
        args: { source: "github" },
        chatId: "concierge",
      });
      await routines.create({
        name: "Digest",
        trigger: {
          type: "schedule",
          localTime: "18:00",
          tzid: "UTC",
          tzMode: "fixed",
          rrule: "FREQ=DAILY",
        },
        actionName: CONCIERGE_DIGEST_ACTION,
        args: {},
        chatId: "concierge",
      });
      await routines.create({
        name: "Nobody's",
        trigger: {
          type: "schedule",
          localTime: "07:00",
          tzid: "UTC",
          tzMode: "fixed",
          rrule: "FREQ=DAILY",
        },
        actionName: "send_user_message",
        args: { text: "Hello" },
        chatId: null,
      });
      const spent = await oneOff("concierge", "Spent");
      await routines.update(spent, { nextRunAt: null });
      await routines.updateLastFired(spent, new Date());

      const work = await readPanel("concierge");
      expect(kindsIn(work)).toEqual({ scheduled: ["routine Daily summary"] });
      expect(work.groups[0]!.items[0]).toMatchObject({ id: shown });

      // An archived task chat is in no group.
      const archived = {
        kind: "task",
        task: { ...(await sampleTask()), archivedAt: Date.now() },
        schedule: null,
        check: null,
      } as TaskListTaskItem;
      expect(groupTaskPanel({ tasks: [archived], checks: [], follows: [], routines: [] })).toEqual(
        [],
      );
    });

    /** A task row as the list reads it. */
    const sampleTask = async () => {
      await task({ title: "Archived" });
      const row = (await read("concierge")).groups
        .flatMap((group) => group.items)
        .find((item) => item.kind === "task");
      if (row?.kind !== "task") throw new Error("expected a task row");
      return row.task;
    };
  });

  describe("row actions", () => {
    it("marks a one-off task of the chat done for its owner only, and no scheduled or ended one", async () => {
      const flights = await task({ title: "Flights" });
      const brief = await task({ title: "Morning brief" });
      const ended = await task({ title: "Hotel" });
      await routines.create({
        name: "Morning brief",
        trigger: {
          type: "schedule",
          localTime: "08:00",
          tzid: "UTC",
          tzMode: "fixed",
          rrule: "FREQ=DAILY",
        },
        actionName: CONCIERGE_TASK_RUN_ACTION,
        args: { chatId: brief.id, brief: "Brief me." },
      });
      const sources = new ConciergeTasks(tasks);
      sources.attachFacts({
        now: () => Date.now(),
        running: (chatId) => chatId !== ended.id,
        openWaits: async () => new Map(),
        reportPending: () => [],
      });
      taskSource = sources;
      const done = (chatId: string, id: string, as = guardian) =>
        app().request(`/chats/${chatId}/tasks/${id}/done`, { ...as, method: "POST" });

      expect((await done("concierge", flights.id, ann)).status).toBe(404);
      expect((await done("ann-main", flights.id, ann)).status).toBe(404);
      expect((await done("concierge", brief.id)).status).toBe(409);
      expect((await done("concierge", ended.id)).status).toBe(409);
      expect(calls).toEqual([]);
      expect((await done("concierge", flights.id)).status).toBe(200);
      expect(calls).toEqual([`done ${flights.id}`]);
    });

    it("cancels a reminder no task has, for the chat's owner only", async () => {
      const visa = await task({ title: "Visa" });
      checks.concierge = [
        { id: "lone", at: IN_AN_HOUR, taskId: null },
        { id: "on-visa", at: IN_AN_HOUR, taskId: visa.id },
      ];
      const cancel = (chatId: string, id: string, as = guardian) =>
        app().request(`/chats/${chatId}/tasks/checks/${id}/cancel`, { ...as, method: "POST" });

      expect((await cancel("concierge", "lone", ann)).status).toBe(404);
      expect((await cancel("ann-main", "lone", ann)).status).toBe(404);
      // A task's check is on the task's row, which has no Cancel.
      expect((await cancel("concierge", "on-visa")).status).toBe(404);
      expect(calls).toEqual([]);
      expect((await cancel("concierge", "lone")).status).toBe(200);
      expect(calls).toEqual(["cancel concierge lone"]);
    });

    it("unfollows a follow of the chat, for the chat's owner only", async () => {
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
      const unfollow = (chatId: string, body: unknown, as = guardian) =>
        app().request(`/chats/${chatId}/tasks/follows/unfollow`, {
          method: "POST",
          headers: { ...as.headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const rome = { source: "github", target: "rome-os/rome" };
      expect((await unfollow("concierge", rome, ann)).status).toBe(404);
      expect((await unfollow("ann-main", rome, ann)).status).toBe(404);
      expect((await unfollow("concierge", { source: "github", target: "other" })).status).toBe(404);
      expect((await unfollow("concierge", { source: "github" })).status).toBe(400);
      expect(calls).toEqual([]);
      expect((await unfollow("concierge", rome)).status).toBe(200);
      expect(calls).toEqual(["unfollow github rome-os/rome guardian"]);
    });

    it("pauses, resumes and deletes a routine of the chat, for the chat's owner only", async () => {
      const mine = await summary("concierge", "Daily summary");
      const hers = await summary("ann-main", "Ann summary");
      const act = (chatId: string, id: string, what: string, as = guardian) =>
        app().request(
          what === "delete"
            ? `/chats/${chatId}/tasks/routines/${id}`
            : `/chats/${chatId}/tasks/routines/${id}/${what}`,
          { ...as, method: what === "delete" ? "DELETE" : "POST" },
        );

      expect((await act("concierge", mine, "pause", ann)).status).toBe(404);
      expect((await act("concierge", hers, "pause")).status).toBe(404);
      expect((await act("ann-main", mine, "delete", ann)).status).toBe(404);
      expect(calls).toEqual([]);

      expect((await act("concierge", mine, "pause")).status).toBe(200);
      expect((await routines.findById(mine))?.enabled).toBe(false);
      expect((await act("concierge", mine, "resume")).status).toBe(200);
      expect((await routines.findById(mine))?.enabled).toBe(true);
      expect(calls).toEqual([`deactivate ${mine}`, `deactivate ${mine}`, `activate ${mine}`]);

      expect((await act("concierge", mine, "delete")).status).toBe(200);
      expect(await routines.findById(mine)).toBeNull();
      expect(await routines.findById(hers)).not.toBeNull();
    });

    it("acts on no routine the list leaves out, such as a follow's watcher", async () => {
      const watcher = await routines.create({
        name: "Watch",
        trigger: { type: "event-bus", eventName: "github.push" },
        actionName: CONCIERGE_FOLLOW_ACTION,
        args: {},
        chatId: "concierge",
      });
      const res = await app().request(`/chats/concierge/tasks/routines/${watcher}`, {
        ...guardian,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(await routines.findById(watcher)).not.toBeNull();
    });
  });
});
