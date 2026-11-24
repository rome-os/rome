import { afterEach, describe, expect, it } from "@rstest/core";
import type { Action } from "../../apps/actions/types.js";
import type { AgentDefinition } from "../../agent/index.js";
import type { AgentRunnerInterface, RunParams } from "../../core/types.js";
import { ConciergeObservationsRepository } from "../../db/repositories/concierge-observations.js";
import { ConciergeToldRepository } from "../../db/repositories/concierge-told.js";
import type { Routine } from "../../routines/types.js";
import { createTestDb } from "../../test/db.js";
import type { ConciergeService } from "../service.js";
import {
  CONCIERGE_PATROL_ACTION,
  CONCIERGE_PATROL_OBSERVATIONS_ACTION,
  type ConciergePatrolDeps,
  startConciergePatrol,
} from "./index.js";
import { PATROL_SESSION_ID } from "./run.js";

const MAIN = "concierge";
const HOUR = 3_600_000;
/** Mon 23 Nov 2026, 12:45 in Shanghai: outside quiet hours and clear of the digest. */
const NOON = Date.parse("2026-11-23T12:45:00+08:00");

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Options {
  /** What the patrol agent answers each run. */
  answer?: (prompt: string) => unknown;
  /** The guardian's messages in the main chat, epoch milliseconds. */
  ownerMessages?: number[];
  tasks?: { id: string; status: string; updatedAt: number; waitingSince?: number }[];
  /** Messages each Concierge turn says. */
  says?: number;
  definition?: Partial<AgentDefinition>;
}

function setup(options: Options = {}) {
  const testDb = createTestDb();
  opened.push(testDb);
  let clock = NOON;
  const told = new ConciergeToldRepository(testDb.db);
  const observations = new ConciergeObservationsRepository(testDb.db);
  const routines = new Map<string, Routine & { chatId?: string | null }>();
  const settings = new Map<string, unknown>();
  const actions: Action[] = [];
  const runs: RunParams[] = [];
  const turns: { chatId: string; prompt: string; options: unknown }[] = [];
  const ownerMessages = [...(options.ownerMessages ?? [])];
  let nextId = 0;
  const agentRunner: AgentRunnerInterface = {
    run: (params) =>
      (async function* () {
        runs.push(params);
        yield {
          type: "result",
          content: JSON.stringify(
            options.answer?.(params.prompt) ?? {
              observations: [],
              decision: "silent",
              reason: "nothing",
              speak: { topicKey: "", line: "", start: "" },
              recheckAt: "",
            },
          ),
        } as never;
      })(),
  };
  const taskRows = (options.tasks ?? []).map((task) => ({
    row: {
      id: task.id,
      title: `Task ${task.id}`,
      updatedAt: new Date(task.updatedAt),
      endedAt: null,
    },
    conciergeChat: { id: MAIN, name: "Main chat", main: true },
    owner: "guardian",
  }));
  const service = {
    isServed: async () => true,
    findChatId: async () => MAIN,
    listChats: async () => [{ id: MAIN, name: "Main chat", main: true }],
    following: {
      timezone: async () => "Asia/Shanghai",
      rules: async () => ({ digestTimes: ["09:00", "18:00"], quietHours: null }),
    },
    deps: {
      tasks: {
        repo: { listForAgent: async () => taskRows },
        statusOf: async () =>
          new Map(
            (options.tasks ?? []).map((task) => [
              task.id,
              {
                status: task.status,
                waitingSince: task.waitingSince ?? null,
                openWait: null,
                laterAt: null,
                expiredWaitAt: null,
              },
            ]),
          ),
      },
    },
    runCountedTurn: async (chatId: string, prompt: string, turnOptions: unknown) => {
      turns.push({ chatId, prompt, options: turnOptions });
      return { ran: true, said: options.says ?? 1, chatId };
    },
  } as unknown as ConciergeService;
  const deps: ConciergePatrolDeps = {
    routines: {
      create: async (data) => {
        const id = `r${nextId++}`;
        routines.set(id, {
          ...data,
          id,
          enabled: data.enabled ?? true,
          createdAt: new Date(),
        } as Routine);
        return id;
      },
      findByKey: async (key) => [...routines.values()].find((r) => r.key === key) ?? null,
      findById: (async (id: string) => {
        const r = routines.get(id);
        return r ? { ...r, key: r.key ?? null, managedBy: null } : null;
      }) as unknown as ConciergePatrolDeps["routines"]["findById"],
      findAll: (async () =>
        [...routines.values()].map((r) => ({
          ...r,
          chatId: r.chatId ?? null,
          key: r.key ?? null,
        }))) as unknown as ConciergePatrolDeps["routines"]["findAll"],
      update: async (id, data) => {
        const r = routines.get(id);
        if (r) routines.set(id, { ...r, ...data } as Routine);
      },
    },
    routineEngine: { activate: async () => {}, deactivate: async () => {} },
    actions: { register: (action) => void actions.push(action) },
    settings: {
      get: (async (key: string) =>
        settings.get(key) ?? null) as ConciergePatrolDeps["settings"]["get"],
      set: async (key, value) => void settings.set(key, value),
    },
    agentRunner,
    record: { ensureRomeSession: async () => {}, addMessage: async () => {} } as never,
    told,
    observations,
    chats: {
      getHistoryMessages: (async () =>
        ownerMessages.map((at, i) => ({
          id: `m${i}`,
          sessionId: MAIN,
          turnId: null,
          role: "user",
          content: JSON.stringify([{ type: "text", content: `message ${i}` }]),
          createdAt: new Date(at),
        }))) as unknown as ConciergePatrolDeps["chats"]["getHistoryMessages"],
      ownerSpokeAt: async () => ownerMessages.at(-1) ?? null,
    },
    memory: async () => ({ text: "", changedAt: null }),
    patrolAgent: () =>
      ({
        tools: [],
        actions: [],
        systemPromptPrefix: "",
        ...options.definition,
      }) as AgentDefinition,
    intervalHours: 3,
    now: () => clock,
  };
  let patrol = startConciergePatrol(service, deps);
  return {
    get patrol() {
      return patrol;
    },
    /** Starts the patrol again, as at the next boot, on the same storage. */
    restart: () => {
      patrol = startConciergePatrol(service, deps);
    },
    runs,
    turns,
    told,
    observations,
    routines,
    settings,
    actions,
    ownerMessages,
    setClock: (at: number) => {
      clock = at;
    },
  };
}

const speakAbout = (topicKey: string, line = "Task task-1 has waited on you for 3 days.") => ({
  observations: [
    {
      topicKey,
      kind: "state_change",
      source: "tasks",
      basis: "observed",
      confidence: 0.9,
      status: "open",
      summary: "Task waits on the guardian",
      taskId: "task-1",
      due: "",
      expires: "",
    },
  ],
  decision: "speak",
  reason: "a task waits",
  speak: { topicKey, line, start: "" },
  recheckAt: "",
});

const waitingTask = {
  id: "task-1",
  status: "needs_you",
  updatedAt: NOON - 72 * HOUR,
  waitingSince: NOON - 72 * HOUR,
};

describe("the patrol routine", () => {
  it("is one visible routine every three hours that fires the internal action", async () => {
    const s = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [routine] = [...s.routines.values()];
    expect(routine).toMatchObject({
      name: "Concierge patrol",
      key: "concierge-patrol:guardian",
      actionName: CONCIERGE_PATROL_ACTION,
      enabled: true,
      trigger: { type: "schedule", rrule: "FREQ=HOURLY;INTERVAL=3", tzMode: "floating" },
    });
    expect(s.actions.map((a) => a.config.name)).toEqual([
      CONCIERGE_PATROL_ACTION,
      CONCIERGE_PATROL_OBSERVATIONS_ACTION,
    ]);
    for (const action of s.actions) expect(action.config.visibility).toBe("explicit");
    expect(s.actions[1]?.config.sideEffects).toBe("read-only");
  });

  it("keeps a pause, and brings back a deleted routine paused", async () => {
    const s = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [id] = [...s.routines.keys()];
    s.routines.set(id!, { ...s.routines.get(id!)!, enabled: false });
    expect(await s.patrol.run()).toEqual({ status: "skipped", reason: "paused" });
    // The next boot keeps the pause.
    s.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.routines.get(id!)?.enabled).toBe(false);
    // A routine the guardian deleted comes back paused, never on again by itself.
    s.routines.delete(id!);
    s.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const back = [...s.routines.values()];
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ key: "concierge-patrol:guardian", enabled: false });
  });
});

describe("a patrol run", () => {
  it("stops at the pre-check when nothing came in, and runs no agent", async () => {
    const s = setup({ ownerMessages: [NOON - HOUR] });
    // The first run reads everything once.
    await s.patrol.run();
    expect(s.runs).toHaveLength(1);
    s.setClock(NOON + 3 * HOUR);
    expect(await s.patrol.run()).toEqual({ status: "quiet", reasons: [] });
    expect(s.runs).toHaveLength(1);
  });

  it("runs fresh, recorded in the one patrol session, when something came in", async () => {
    const s = setup({ ownerMessages: [NOON - HOUR] });
    await s.patrol.run();
    s.ownerMessages.push(NOON + HOUR);
    s.setClock(NOON + 3 * HOUR);
    await s.patrol.run();
    expect(s.runs).toHaveLength(2);
    for (const run of s.runs) {
      expect(run.romeSessionId).toBe(PATROL_SESSION_ID);
      expect(run.channelThreadKey).toBeUndefined();
      expect(run.agentName).toBe("core:concierge-patrol");
    }
  });

  it("speaks one fenced brief in the main chat, and writes the tell to the ledger and the observation", async () => {
    const s = setup({ tasks: [waitingTask], answer: () => speakAbout("task:task-1:waiting") });
    expect(await s.patrol.run()).toEqual({
      status: "spoke",
      topicKey: "task:task-1:waiting",
      said: 1,
    });
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.chatId).toBe(MAIN);
    expect(s.turns[0]?.prompt).toMatch(/^<patrol_brief untrusted="true"/);
    expect(s.turns[0]?.options).toMatchObject({ quiet: true, pushLevel: "active" });
    expect(s.turns[0]?.options).not.toHaveProperty("inputSource");
    const [entry] = await s.told.since(new Date(0));
    expect(entry).toMatchObject({ kind: "patrol", messages: 1, chatId: MAIN });
    const observation = (await s.observations.list())[0];
    expect(observation?.toldCount).toBe(1);
    expect(observation?.outcomes.map((o) => o.outcome)).toEqual(["told"]);
  });

  it("does not repeat a topic it told, and marks it ignored when no reply came", async () => {
    const s = setup({ tasks: [waitingTask], answer: () => speakAbout("task:task-1:waiting") });
    await s.patrol.run();
    s.ownerMessages.push(NOON + 2 * HOUR - 1);
    s.setClock(NOON + 9 * HOUR);
    // Its owner wrote within six hours: adopted, and still not raised again.
    const second = await s.patrol.run();
    expect(second).toMatchObject({ status: "silent", hold: "cooldown" });
    expect(s.turns).toHaveLength(1);
    const observation = (await s.observations.list())[0];
    expect(observation?.outcomes.map((o) => o.outcome)).toEqual(["told", "adopted"]);
  });

  it("counts an ignored tell, and raises the topic again only after three days", async () => {
    const s = setup({
      ownerMessages: [NOON - HOUR],
      tasks: [waitingTask],
      answer: () => speakAbout("task:task-1:waiting"),
    });
    await s.patrol.run();
    // Nine hours later with no word from its owner: ignored, and nothing new to read.
    s.setClock(NOON + 9 * HOUR);
    expect(await s.patrol.run()).toEqual({ status: "quiet", reasons: [] });
    expect((await s.observations.list())[0]?.ignoredCount).toBe(1);
    // Two days later the agent picks it again: still in its cooldown.
    s.ownerMessages.push(NOON + 47 * HOUR);
    s.setClock(NOON + 48 * HOUR);
    expect(await s.patrol.run()).toMatchObject({ status: "silent", hold: "cooldown" });
    // Past three days it may be told once more.
    s.ownerMessages.push(NOON + 74 * HOUR);
    s.setClock(NOON + 75 * HOUR);
    expect(await s.patrol.run()).toMatchObject({ status: "spoke" });
    expect(s.turns).toHaveLength(2);
  });

  it("holds at the daily cap that alerts and digests count toward, before reading anything", async () => {
    const s = setup({ tasks: [waitingTask], answer: () => speakAbout("task:task-1:waiting") });
    for (const kind of ["alert", "digest", "alert"] as const) {
      await s.told.record({
        kind,
        chatId: MAIN,
        messages: 1,
        items: [],
        at: new Date(NOON - HOUR),
      });
    }
    expect(await s.patrol.run()).toEqual({ status: "held", reason: "daily_cap" });
    expect(s.runs).toHaveLength(0);
    expect(s.turns).toHaveLength(0);
  });

  it("stays silent on what an alert or digest already told when the agent says so", async () => {
    const s = setup({
      tasks: [waitingTask],
      answer: (prompt) => {
        expect(prompt).toContain('"line": "PR #123 waits for your review"');
        return { ...speakAbout("task:task-1:waiting"), decision: "silent" };
      },
    });
    await s.told.record({
      kind: "alert",
      chatId: MAIN,
      messages: 1,
      items: [{ topic: "follow:github:acme/widgets", line: "PR #123 waits for your review" }],
      at: new Date(NOON - HOUR),
    });
    expect(await s.patrol.run()).toMatchObject({ status: "silent" });
    expect(s.turns).toHaveLength(0);
  });

  it("never tells an inferred observation, whatever the agent decided", async () => {
    const answer = speakAbout("loop:guess");
    answer.observations[0]!.basis = "inferred";
    const s = setup({ answer: () => answer });
    expect(await s.patrol.run()).toMatchObject({ status: "silent", hold: "inferred" });
    expect(s.turns).toHaveLength(0);
  });

  it("holds through quiet hours, even its own night when the guardian set none", async () => {
    const s = setup({ answer: () => speakAbout("task:task-1:waiting") });
    s.setClock(Date.parse("2026-11-23T23:45:00+08:00"));
    expect(await s.patrol.run()).toEqual({ status: "held", reason: "quiet_hours" });
    expect(s.runs).toHaveLength(0);
  });

  it("does not run when the patrol agent was given any tool or action", async () => {
    for (const definition of [{ tools: ["Read"] }, { actions: ["core:show_file"] }]) {
      const s = setup({ definition, answer: () => speakAbout("task:task-1:waiting") });
      expect(await s.patrol.run()).toEqual({ status: "skipped", reason: "agent_holds_tools" });
      expect(s.runs).toHaveLength(0);
    }
  });

  it("sets its own wake-up for a time-critical item, which no rest holds back", async () => {
    const recheckAt = new Date(NOON + 2 * HOUR).toISOString();
    const s = setup({
      answer: () => ({ ...speakAbout("x"), decision: "silent", recheckAt }),
    });
    await s.patrol.run();
    const recheck = [...s.routines.values()].find(
      (r) => r.key === "concierge-patrol:guardian:recheck",
    );
    expect(recheck).toMatchObject({
      args: { recheck: true },
      trigger: { type: "schedule", date: "2026-11-23", localTime: "14:45", tzMode: "fixed" },
      enabled: true,
    });
    // It fires once: running it turns it off, so a restart never fires it again.
    s.setClock(NOON + 2 * HOUR);
    await s.patrol.run({ recheck: true });
    const fired = [...s.routines.values()].find(
      (r) => r.key === "concierge-patrol:guardian:recheck",
    );
    expect(fired?.enabled).toBe(false);
  });
});

describe("what Dream may keep in memory", () => {
  it("lists observed topics with their outcomes, and never a calendar one or a guess", async () => {
    const s = setup();
    const base = speakAbout("x").observations[0]!;
    const write = (change: Record<string, unknown>) =>
      s.observations.upsert(
        {
          ...base,
          taskId: null,
          dueAt: null,
          expiresAt: new Date(NOON + 72 * HOUR),
          ...change,
        } as never,
        new Date(NOON),
      );
    await write({ topicKey: "pattern:weekly-report", kind: "pattern", source: "main_chat" });
    await write({ topicKey: "calendar:prep", kind: "anticipated_need", source: "calendar" });
    await write({ topicKey: "loop:guess", kind: "open_loop", source: "memory", basis: "inferred" });
    const action = s.actions.find((a) => a.config.name === CONCIERGE_PATROL_OBSERVATIONS_ACTION)!;
    const result = (await action.execute({}, {} as never)) as {
      data: { observations: { topic: string }[] };
    };
    expect(result.data.observations.map((o) => o.topic)).toEqual(["pattern:weekly-report"]);
  });
});
