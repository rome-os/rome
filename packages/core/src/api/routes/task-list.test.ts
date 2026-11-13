import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import {
  TASK_LIST_ENDED_PAGE,
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
  let cardMessages: Record<string, Array<{ id: string; content: string; createdAt: Date }>>;
  let taskSource: ConciergeTasks | null;
  /** The `since` each read of the chat's task chat parts asked from. */
  let asked: Array<number | undefined>;
  /** Who listens for messages said in a chat. */
  const inserted = new Set<
    (message: { sessionId: string; role: string; content: string }) => void
  >();

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
    const routineEngine = { onChange: () => () => {} } as unknown as ApiDeps["routineEngine"];
    return new Hono().use("*", sessionActorMiddleware(testDb.db)).route(
      "/",
      chatTaskListRoutes({
        concierge,
        dashboardAccessState,
        routinesRepo: routines,
        routineRunsRepo: new RoutineRunsRepository(testDb.db),
        routineEngine,
        webchatRepo: {
          taskChatPartMessages: async (chatId: string, from?: Date) => {
            asked.push(from?.getTime());
            return cardMessages[chatId] ?? [];
          },
          onMessageInserted: (
            listener: (message: { sessionId: string; role: string; content: string }) => void,
          ) => {
            inserted.add(listener);
            return () => inserted.delete(listener);
          },
        } as unknown as ApiDeps["webchatRepo"],
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
    cardMessages = {};
    asked = [];
    taskSource = null;
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

  it("gives a routine's schedule its zone, so the row can name a fixed one", async () => {
    await summary("concierge", "Daily summary");

    const work = await read("concierge");
    const row = work.groups.flatMap((group) => group.items).find((item) => item.kind === "routine");
    expect(row).toMatchObject({
      trigger: { type: "schedule", localTime: "09:00", tzid: "UTC", tzMode: "fixed" },
    });
  });

  it("answers the newest ended rows and their count, and older ones from a cursor", async () => {
    const made = await tasks.upsertMany(
      Array.from({ length: TASK_LIST_ENDED_PAGE + 3 }, (_, index) => ({ title: `Old ${index}` })),
    );
    for (const task of made) await tasks.stop(task.id, "guardian");

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
    expect((await app().request("/chats/ann-main/tasks", guardian)).status).toBe(404);
    expect((await app().request("/chats/concierge/tasks", ann)).status).toBe(404);
    expect((await app().request("/chats/concierge/tasks", appUser)).status).toBe(401);
    expect((await app().request("/chats/concierge/tasks")).status).toBe(401);
  });

  it("shows an empty tab with no groups", async () => {
    expect(await read("concierge")).toEqual({ chatId: "concierge", groups: [] });
    // Nothing needs its owner: the chat's cards are not read at all.
    expect(asked).toEqual([]);
  });

  it("stops a task of the chat for its owner only", async () => {
    const [flights] = await tasks.upsertMany([{ title: "Flights" }]);
    const stop = (chatId: string, as = guardian) =>
      app().request(`/chats/${chatId}/tasks/${flights!.id}/stop`, { ...as, method: "POST" });

    expect((await stop("concierge", ann)).status).toBe(404);
    expect((await stop("ann-main", ann)).status).toBe(404);
    expect(calls).toEqual([]);
    expect((await stop("concierge")).status).toBe(200);
    expect(calls).toEqual([`stop ${flights!.id} guardian`]);
  });

  it("points a task that needs its owner at the message that shows the card it waits on", async () => {
    await new ChatsWebChatRepository(testDb.db).createSession("task-chat", "Flights");
    await tasks.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    const part = (show?: string) =>
      JSON.stringify([{ type: "task_chat", chatId: "task-chat", title: "Flights", show }]);
    // The task chat waits on its owner: an approval opened a minute ago.
    const since = Date.now() - 60_000;
    const said = (id: string, at: number, show?: string) => ({
      id,
      content: part(show),
      createdAt: new Date(at),
    });
    const tasksWith = new ConciergeTasks(tasks);
    tasksWith.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async () =>
        new Map([["task-chat", [{ kind: "approval" as const, id: "a1", since }]]]),
      reportPending: () => [],
    });
    taskSource = tasksWith;
    const respondTo = async () => {
      const [item] = (await read("concierge")).groups[0]!.items;
      return item?.kind === "task" ? item.cardMessageId : undefined;
    };

    // An ask said before the wait shows an earlier question, and a task card shows none.
    cardMessages.concierge = [
      said("old-ask", since - 10 * 60_000),
      said("task-card", since + 1_000, "task"),
    ];
    expect(await respondTo()).toBeNull();

    // Stored times are whole seconds: an ask said in the wait's own second shows it.
    cardMessages.concierge = [said("same-second-ask", Math.floor(since / 1_000) * 1_000, "ask")];
    expect(await respondTo()).toBe("same-second-ask");

    // The newest ask said since shows it.
    cardMessages.concierge = [
      said("old-ask", since - 10 * 60_000),
      said("same-second-ask", Math.floor(since / 1_000) * 1_000, "ask"),
      said("new-ask", since + 2_000),
    ];
    expect(await respondTo()).toBe("new-ask");

    // A task card said after it is the chat's newest card, so the ask is not answerable there.
    cardMessages.concierge.push(said("later-task-card", since + 3_000, "task"));
    expect(await respondTo()).toBeNull();

    // A card that names what it shows counts by that alone, whenever it was said.
    const naming = (id: string, at: number, approval: string) => ({
      id,
      content: JSON.stringify([
        {
          type: "task_chat",
          chatId: "task-chat",
          title: "Flights",
          show: "ask",
          waitedOn: { kind: "approval", id: approval },
        },
      ]),
      createdAt: new Date(at),
    });
    cardMessages.concierge = [
      naming("names-another", since + 1_000, "a0"),
      naming("names-it", since + 2_000, "a1"),
    ];
    expect(await respondTo()).toBe("names-it");
    // Newest naming another item: the transcript draws none answerable.
    cardMessages.concierge.reverse();
    expect(await respondTo()).toBeNull();
    // It reads from a second before the wait began, not the whole chat.
    expect(asked.at(-1)).toBe(since - 1_000);
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

  it("moves a waiting task's Respond to a new ask card said with no change to the task", async () => {
    await new ChatsWebChatRepository(testDb.db).createSession("task-chat", "Flights");
    await tasks.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    const since = Date.now() - 60_000;
    const ask = (id: string, at: number) => ({
      id,
      content: JSON.stringify([
        { type: "task_chat", chatId: "task-chat", title: "Flights", show: "ask" },
      ]),
      createdAt: new Date(at),
    });
    const tasksWith = new ConciergeTasks(tasks);
    tasksWith.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async () =>
        new Map([["task-chat", [{ kind: "approval" as const, id: "a1", since }]]]),
      reportPending: () => [],
    });
    taskSource = tasksWith;
    const respondTo = async () => {
      const [item] = (await read("concierge")).groups[0]!.items;
      return item?.kind === "task" ? item.cardMessageId : undefined;
    };
    cardMessages.concierge = [ask("first-ask", since + 1_000)];
    expect(await respondTo()).toBe("first-ask");

    const stream = await app().request("/chats/concierge/tasks/events", guardian);
    const reader = stream.body!.getReader();
    // The Concierge asks again: a new card, and no task row changes.
    cardMessages.concierge.push(ask("second-ask", since + 2_000));
    for (const listener of inserted) {
      listener({ sessionId: "concierge", role: "assistant", content: ask("", 0).content });
    }
    let text = "";
    while (!text.includes("tasks_changed")) {
      text += new TextDecoder().decode((await reader.read()).value);
    }
    await reader.cancel();
    // The list the change tells it to read points at the new card.
    expect(await respondTo()).toBe("second-ask");
  });

  it("tells the chat's list to read again when a task card is said in it", async () => {
    const stream = await app().request("/chats/concierge/tasks/events", guardian);
    const reader = stream.body!.getReader();
    const say = (sessionId: string, content: string) => {
      for (const listener of inserted) listener({ sessionId, role: "assistant", content });
    };
    say("ann-main", '[{"type":"task_chat","chatId":"c1"}]');
    say("concierge", '[{"type":"text","content":"hi"}]');
    say("concierge", '[{"type":"task_chat","chatId":"c1"}]');
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
