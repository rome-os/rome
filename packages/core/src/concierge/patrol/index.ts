// The Concierge's patrol: every few hours a system routine fires it, code
// checks whether anything new came in, a fresh read-only agent run updates
// what the patrol noticed and picks at most one thing to tell, and the
// Concierge says it in one quiet turn of the guardian's main chat.
// docs/architecture/concierge-patrol.md

import { AsyncLocalStorage } from "node:async_hooks";
import type { Action } from "../../apps/actions/types.js";
import type { AgentDefinition } from "../../agent/index.js";
import type { AgentRunnerInterface } from "../../core/types.js";
import type {
  ConciergeObservationsRepository,
  Observation,
} from "../../db/repositories/concierge-observations.js";
import type { ConciergeToldRepository } from "../../db/repositories/concierge-told.js";
import { type RoutinesRepository, toRoutine } from "../../db/repositories/routines.js";
import type { SettingsRepository } from "../../db/repositories/settings.js";
import { createLogger } from "../../logger.js";
import type { RoutineEngine } from "../../routines/engine.js";
import { textSpans } from "../../webchat/reply-quote.js";
import type { WebChatRepository } from "../../webchat/repository.js";
import { GUARDIAN_OWNER } from "../../webchat/owner.js";
import { guardianNow } from "../alerts.js";
import type { ConciergeService } from "../service.js";
import type { TriageRecordStore } from "../triage.js";
import {
  buildPatrolPrompt,
  NAMED_SOURCES,
  type PatrolCalendarEvent,
  type PatrolInput,
  type PatrolObservationView,
  parsePatrolOutput,
  renderPatrolBrief,
  speechHold,
} from "./brief.js";
import { inWindow, LONG_WAIT_MS, type PatrolSignals, precheck } from "./precheck.js";
import { runPatrolAgent } from "./run.js";
import {
  DAILY_MESSAGE_CAP,
  DAY_MS,
  HOUR_MS,
  holdReason,
  mayRaise,
  nextSpeakingRun,
  settleOutcome,
} from "./volume.js";

const log = createLogger("concierge-patrol");

/** The action the patrol's routines fire. Internal: no agent lists it. */
export const CONCIERGE_PATROL_ACTION = "core:concierge_patrol";
/** What Dream reads of the patrol's observations. Read-only; only Dream lists it. */
export const CONCIERGE_PATROL_OBSERVATIONS_ACTION = "core:concierge_patrol_observations";
/** Routine keys of the patrol: `concierge-patrol:<owner>`, and its own wake-up. */
const PATROL_KEY_PREFIX = "concierge-patrol:";
const PATROL_ROUTINE_KEY = `${PATROL_KEY_PREFIX}${GUARDIAN_OWNER}`;
const RECHECK_ROUTINE_KEY = `${PATROL_KEY_PREFIX}${GUARDIAN_OWNER}:recheck`;
/** The setting that holds the patrol's own state. */
const PATROL_STATE_SETTING_KEY = "conciergePatrol";
/** The minute past the hour the patrol fires, clear of digest times on the hour. */
const PATROL_MINUTE = "00:45";
/** What one run reads of the main chat. */
const CHAT_LOOKBACK_MS = 7 * DAY_MS;
const MAX_CHAT_LINES = 40;
const MAX_CHAT_LINE_CHARS = 500;
/** What one run reads of the ledger, and of ended tasks. */
const TOLD_LOOKBACK_MS = 3 * DAY_MS;
const MAX_TOLD_LINES = 60;
const ENDED_TASK_LOOKBACK_MS = 3 * DAY_MS;
/** What one run reads of the calendar. */
const CALENDAR_AHEAD_MS = 2 * DAY_MS;
const MAX_MEMORY_CHARS = 8_000;
/** Ledger entries and ended observations are kept this long. */
const KEEP_MS = 30 * DAY_MS;

/** What the patrol keeps between runs. */
interface PatrolState {
  /** When a run last went past the pre-check, epoch milliseconds. */
  lastRunAt?: number;
  /** When the pre-check last ran. */
  lastCheckAt?: number;
  /** The patrol's routine was made once, so a missing one was deleted. */
  routineMade?: boolean;
}

export interface ConciergePatrolDeps {
  routines: Pick<RoutinesRepository, "create" | "findByKey" | "findById" | "update" | "findAll">;
  routineEngine: Pick<RoutineEngine, "activate" | "deactivate">;
  actions: { register(action: Action): void };
  settings: Pick<SettingsRepository, "get" | "set">;
  agentRunner: AgentRunnerInterface;
  /** Where patrol runs are recorded, so Sessions shows them. */
  record?: TriageRecordStore;
  told: Pick<ConciergeToldRepository, "since" | "messagesSince" | "record" | "prune">;
  observations: Pick<
    ConciergeObservationsRepository,
    "list" | "upsert" | "recordOutcome" | "expire" | "prune"
  >;
  chats: Pick<WebChatRepository, "getHistoryMessages" | "ownerSpokeAt">;
  /** The guardian's memory notes the patrol reads, and when they last changed. */
  memory(): Promise<{ text: string; changedAt: number | null }>;
  /** The guardian's calendar events in the window, or null when none is synced. */
  calendar?(from: number, to: number, timeZone: string): Promise<PatrolCalendarEvent[] | null>;
  /** The patrol agent's definition, checked to hold nothing before every run. */
  patrolAgent?(): AgentDefinition | undefined;
  /** Hours between patrols. */
  intervalHours: number;
  now?: () => number;
}

/** Whether an agent definition holds no tool, action, subagent or server: nothing it could call. */
function holdsNothing(definition: AgentDefinition): boolean {
  return (
    definition.tools.length === 0 &&
    (definition.actions ?? []).length === 0 &&
    (definition.allowedSubagents ?? []).length === 0 &&
    Object.keys(definition.mcpServers ?? {}).length === 0 &&
    definition.networkDiscovery !== true
  );
}

/** What a patrol run ended with, for the log and for tests. */
export type PatrolOutcome =
  | { status: "skipped"; reason: string }
  | { status: "held"; reason: string }
  | { status: "quiet"; reasons: string[] }
  | { status: "silent"; reason: string; hold?: string }
  | { status: "spoke"; topicKey: string; said: number }
  | { status: "failed"; error: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `at` in `timeZone` as `YYYY-MM-DD` and `HH:mm`. */
function localParts(at: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

const iso = (at: number | Date | null | undefined) =>
  at === null || at === undefined ? undefined : new Date(at).toISOString();

/** A routine's schedule, in a few words for the patrol. */
function whenOf(trigger: unknown): string {
  const t = (trigger ?? {}) as {
    type?: string;
    rrule?: string;
    date?: string;
    localTime?: string;
    eventName?: string;
  };
  if (t.type === "schedule") return [t.rrule ?? t.date, t.localTime].filter(Boolean).join(" at ");
  if (t.type === "event-bus") return `on ${t.eventName ?? "an event"}`;
  return t.type ?? "unknown";
}

/**
 * Starts the patrol: its routine, made once and kept in step with the
 * interval, and the action the routine fires. Answers the stop.
 */
export function startConciergePatrol(
  service: ConciergeService,
  deps: ConciergePatrolDeps,
): { stop(): void; run(args?: { recheck?: boolean }): Promise<PatrolOutcome> } {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.intervalHours * HOUR_MS;
  // The action runs inside its execution's context, which may not run agents
  // or Concierge turns. The patrol runs in the context of boot instead.
  const outsideAction = AsyncLocalStorage.snapshot();

  const readState = async (): Promise<PatrolState> => {
    const value = await deps.settings.get(PATROL_STATE_SETTING_KEY);
    return value && typeof value === "object" ? (value as PatrolState) : {};
  };
  const writeState = async (change: Partial<PatrolState>) =>
    deps.settings.set(PATROL_STATE_SETTING_KEY, { ...(await readState()), ...change });

  const timezone = async () => service.following.timezone(GUARDIAN_OWNER);
  const rules = async () => service.following.rules(GUARDIAN_OWNER);

  const reactivate = async (id: string) => {
    await deps.routineEngine.deactivate(id);
    const row = await deps.routines.findById(id);
    if (row?.enabled) await deps.routineEngine.activate(toRoutine(row));
  };

  /**
   * One patrol routine for the guardian, visible in the routine list. Its
   * trigger follows the interval. Its pause is the guardian's and is never
   * undone here. A routine the guardian deleted comes back paused.
   */
  const syncRoutine = async () => {
    const trigger = {
      type: "schedule" as const,
      tzid: await timezone().catch(() => "UTC"),
      // Like the digest, it follows the guardian's zone.
      tzMode: "floating" as const,
      localTime: PATROL_MINUTE,
      rrule: `FREQ=HOURLY;INTERVAL=${deps.intervalHours}`,
    };
    const existing = await deps.routines.findByKey(PATROL_ROUTINE_KEY);
    if (existing) {
      await deps.routines.update(existing.id, { trigger, args: {} });
      await reactivate(existing.id);
      return;
    }
    const state = await readState();
    const id = await deps.routines.create({
      name: "Concierge patrol",
      key: PATROL_ROUTINE_KEY,
      chatId: null,
      trigger,
      actionName: CONCIERGE_PATROL_ACTION,
      args: {},
      enabled: !state.routineMade,
      createdBy: { owner: GUARDIAN_OWNER },
    });
    await writeState({ routineMade: true });
    await reactivate(id);
  };

  /** Wakes the patrol once at `at`, in place of any wake-up it set before. */
  const scheduleRecheck = async (at: number) => {
    const zone = await timezone().catch(() => "UTC");
    const { date, time } = localParts(at, zone);
    const trigger = {
      type: "schedule" as const,
      tzid: zone,
      tzMode: "fixed" as const,
      localTime: time,
      date,
    };
    const existing = await deps.routines.findByKey(RECHECK_ROUTINE_KEY);
    const id = existing
      ? existing.id
      : await deps.routines.create({
          name: "Concierge patrol check",
          key: RECHECK_ROUTINE_KEY,
          chatId: null,
          trigger,
          actionName: CONCIERGE_PATROL_ACTION,
          args: { recheck: true },
          createdBy: { owner: GUARDIAN_OWNER },
        });
    if (existing)
      await deps.routines.update(id, { trigger, enabled: true, args: { recheck: true } });
    await reactivate(id);
  };

  /** The guardian paused the patrol: its own wake-ups hold too. */
  const paused = async () => {
    const routine = await deps.routines.findByKey(PATROL_ROUTINE_KEY);
    return routine !== null && !routine.enabled;
  };

  /** The guardian's main-chat messages since `since`, as the patrol reads them. */
  const mainChatLines = async (mainChat: string, since: number) =>
    (await deps.chats.getHistoryMessages(mainChat, new Date(since))).flatMap((row) => {
      const text = textSpans(row.content)
        .filter((span) => !span.commentary)
        .map((span) => span.text)
        .join("\n")
        .trim();
      if (!text) return [];
      return [
        {
          at: new Date(row.createdAt).getTime(),
          from: row.role === "user" ? ("guardian" as const) : ("concierge" as const),
          text:
            text.length > MAX_CHAT_LINE_CHARS ? `${text.slice(0, MAX_CHAT_LINE_CHARS - 1)}…` : text,
        },
      ];
    });

  /** The guardian's tasks with their status, open ones and those that ended lately. */
  const guardianTasks = async (at: number) => {
    const { tasks } = service.deps;
    const rows = (await tasks.repo.listForAgent(true)).filter(
      (task) => task.owner === GUARDIAN_OWNER,
    );
    const status = await tasks.statusOf(rows.map((task) => task.row));
    return rows.flatMap((task) => {
      const of = status.get(task.row.id);
      if (!of) return [];
      const ended = task.row.endedAt?.getTime() ?? null;
      if (of.status === "ended" && (ended === null || at - ended > ENDED_TASK_LOOKBACK_MS)) {
        return [];
      }
      return [{ task, status: of }];
    });
  };

  const run = async (args: { recheck?: boolean } = {}): Promise<PatrolOutcome> => {
    const at = now();
    if (!(await service.isServed(GUARDIAN_OWNER)))
      return { status: "skipped", reason: "not_served" };
    if (await paused()) return { status: "skipped", reason: "paused" };
    const definition = deps.patrolAgent?.();
    if (definition && !holdsNothing(definition)) {
      // Read-only is the tool set's to keep. One that holds anything never runs.
      log.error("the patrol agent holds tools or actions; the patrol does not run");
      return { status: "skipped", reason: "agent_holds_tools" };
    }
    const mainChat = await service.findChatId(GUARDIAN_OWNER);
    if (!mainChat) return { status: "skipped", reason: "no_main_chat" };
    const zone = await timezone();
    const { quietHours, digestTimes } = await rules();
    const state = await readState();
    const lastRunAt = state.lastRunAt ?? null;
    const toldToday = await deps.told.messagesSince(new Date(at - DAY_MS));
    const hold = holdReason({
      now: at,
      timeZone: zone,
      quietHours,
      digestTimes,
      toldToday,
      lastRunAt,
      lastOwnerMessageAt: await deps.chats.ownerSpokeAt(mainChat),
      intervalMs,
      recheck: args.recheck === true,
    });
    if (hold) {
      log.info("patrol held", { reason: hold });
      return { status: "held", reason: hold };
    }

    // What came of earlier tells, and what no longer matters.
    const recent = await mainChatLines(mainChat, at - CHAT_LOOKBACK_MS);
    const ownerTimes = recent.filter((line) => line.from === "guardian").map((line) => line.at);
    for (const observation of await deps.observations.list()) {
      const outcome = settleOutcome(observation, ownerTimes, at);
      if (outcome) await deps.observations.recordOutcome(observation.topicKey, { outcome, at });
    }
    await deps.observations.expire(new Date(at));

    const tasks = await guardianTasks(at);
    const memory = await deps.memory();
    const calendar =
      (await deps.calendar?.(at, at + CALENDAR_AHEAD_MS, zone).catch((error: unknown) => {
        log.warn("patrol could not read the calendar", { error: messageOf(error) });
        return null;
      })) ?? null;
    const observations = await deps.observations.list();
    const since = lastRunAt;
    const signals: PatrolSignals = {
      firstRun: since === null,
      recheck: args.recheck === true,
      ownerMessages: ownerTimes.filter((time) => inWindow(time, since, at)).length,
      tasksChanged: tasks.filter(({ task }) =>
        inWindow(
          Math.max(task.row.updatedAt.getTime(), task.row.endedAt?.getTime() ?? 0),
          since,
          at,
        ),
      ).length,
      tasksWaitingLong: tasks.filter(
        ({ status }) =>
          status.status === "needs_you" &&
          status.waitingSince !== null &&
          inWindow(status.waitingSince + LONG_WAIT_MS, since, at),
      ).length,
      memoryChanged: memory.changedAt !== null && inWindow(memory.changedAt, since, at),
      calendarSoon: (calendar ?? []).filter((event) => {
        const start = Date.parse(event.start);
        return Number.isFinite(start) && start > at && inWindow(start - DAY_MS, since, at);
      }).length,
      observationsDue: observations.filter((o) => {
        const due = o.dueAt?.getTime() ?? null;
        return o.status === "open" && due !== null && due > at && inWindow(due - DAY_MS, since, at);
      }).length,
    };
    const checked = precheck(signals);
    await writeState({ lastCheckAt: at });
    if (!checked.run) {
      log.info("patrol pre-check: nothing new");
      return { status: "quiet", reasons: [] };
    }

    const taskUpdated = new Map(
      tasks.map(({ task }) => [task.row.id, task.row.updatedAt.getTime()] as const),
    );
    const taskUpdatedAt = (id: string) => taskUpdated.get(id) ?? null;
    const messagesLeftToday = Math.max(0, DAILY_MESSAGE_CAP - toldToday);
    const guardianChats = new Set([
      mainChat,
      ...(await service.listChats(GUARDIAN_OWNER).catch(() => [])).map((chat) => chat.id),
    ]);
    const taskIds = new Set(tasks.map(({ task }) => task.row.id));
    const schedules = (await deps.routines.findAll()).flatMap((row) =>
      row.enabled &&
      row.chatId !== null &&
      (guardianChats.has(row.chatId) || taskIds.has(row.chatId)) &&
      !row.key?.startsWith("concierge-")
        ? [{ name: row.name, when: whenOf(row.trigger) }]
        : [],
    );
    const told = await deps.told.since(new Date(at - TOLD_LOOKBACK_MS));
    const input: PatrolInput = {
      now: guardianNow(at, zone),
      nextRun: ((next) => (next === null ? null : guardianNow(next, zone)))(
        nextSpeakingRun(at, intervalMs, quietHours, digestTimes, zone),
      ),
      memory: memory.text.slice(0, MAX_MEMORY_CHARS),
      mainChat: recent.slice(-MAX_CHAT_LINES).map((line) => ({
        at: new Date(line.at).toISOString(),
        from: line.from,
        text: line.text,
      })),
      tasks: tasks.map(({ task, status }) => ({
        id: task.row.id,
        title: task.row.title,
        status: status.status,
        ...(status.endReason ? { endReason: status.endReason } : {}),
        ...(status.status === "needs_you" && status.waitingSince !== null
          ? { waitingDays: Math.floor((at - status.waitingSince) / DAY_MS) }
          : {}),
        updated: task.row.updatedAt.toISOString(),
        ...(task.conciergeChat.main ? {} : { fromTopicChat: true as const }),
      })),
      schedules,
      calendar,
      observations: observations
        .filter((o) => o.status === "open")
        .map((o) => viewOf(o, at, taskUpdatedAt)),
      alreadyTold: told
        .flatMap((entry) =>
          entry.items.map((item) => ({
            kind: entry.kind,
            at: entry.toldAt.toISOString(),
            topic: item.topic,
            line: item.line,
          })),
        )
        .slice(0, MAX_TOLD_LINES),
      messagesLeftToday,
    };

    let raw: unknown;
    try {
      raw = await runPatrolAgent(deps.agentRunner, buildPatrolPrompt(input), {
        ...(deps.record ? { record: deps.record } : {}),
      });
    } catch (error) {
      log.warn("patrol run failed; it stays silent", { error: messageOf(error) });
      return { status: "failed", error: messageOf(error) };
    }
    await writeState({ lastRunAt: at });
    const output = parsePatrolOutput(raw, { now: at, taskIds, calendar: calendar ?? [] });
    for (const draft of output.observations) await deps.observations.upsert(draft, new Date(at));
    if (output.recheckAt !== null) {
      await scheduleRecheck(output.recheckAt).catch((error: unknown) =>
        log.warn("patrol could not set its check", { error: messageOf(error) }),
      );
    }
    await deps.told.prune(new Date(at - KEEP_MS));
    await deps.observations.prune(new Date(at - KEEP_MS));
    log.info("patrol ran", {
      signals: checked.reasons,
      observations: output.observations.length,
      decision: output.decision,
      reason: output.reason,
    });
    if (!output.speak) return { status: "silent", reason: output.reason };

    const current = await deps.observations.list();
    const held = speechHold(output.speak, current, { now: at, messagesLeftToday, taskUpdatedAt });
    if (held) {
      log.info("patrol kept silent", { hold: held, topic: output.speak.topicKey });
      return { status: "silent", reason: output.reason, hold: held };
    }
    const observation = current.find((o) => o.topicKey === output.speak?.topicKey);
    if (!observation) return { status: "silent", reason: output.reason, hold: "no_observation" };
    const brief = renderPatrolBrief(
      { ...observation, line: output.speak.line },
      output.speak.start,
      guardianNow(at, zone),
    );
    const turn = await service.runCountedTurn(mainChat, brief, {
      quiet: true,
      // Its input stays in the turn's trace. The patrol is the Concierge's
      // own, so its messages carry no source label.
      inputLabel: "Concierge patrol",
      pushLevel: "active",
    });
    if (turn.said > 0) {
      await deps.told.record({
        kind: "patrol",
        chatId: turn.chatId,
        messages: turn.said,
        items: [{ topic: observation.topicKey, line: output.speak.line }],
        at: new Date(now()),
      });
      await deps.observations.recordOutcome(observation.topicKey, { outcome: "told", at: now() });
    }
    log.info("patrol spoke", { ran: turn.ran, said: turn.said, kind: observation.kind });
    return { status: "spoke", topicKey: observation.topicKey, said: turn.said };
  };

  // One patrol at a time: a fire while one runs waits for it and runs after.
  let running: Promise<PatrolOutcome> = Promise.resolve({ status: "skipped", reason: "none" });
  const runOnce = (args: { recheck?: boolean } = {}) => {
    const next = running.then(() => outsideAction(() => run(args)));
    running = next.catch((error: unknown) => ({ status: "failed", error: messageOf(error) }));
    return next;
  };

  deps.actions.register({
    config: {
      name: CONCIERGE_PATROL_ACTION,
      type: "system" as const,
      description:
        "Internal: runs the Concierge's patrol, which may tell the guardian one thing. Fired by its routines; not agent-callable.",
      // Explicit: only an agent whose allow-list names it may call it, and none does.
      visibility: "explicit" as const,
      complexity: "simple" as const,
      speed: "slow" as const,
      reliability: "high" as const,
      sideEffects: "write" as const,
    },
    execute: async (args) => {
      try {
        const outcome = await runOnce({ recheck: args.recheck === true });
        return { status: "ok", data: outcome };
      } catch (error) {
        log.warn("patrol threw", { error: messageOf(error) });
        return { status: "error", error: messageOf(error) };
      }
    },
  });

  deps.actions.register({
    config: {
      name: CONCIERGE_PATROL_OBSERVATIONS_ACTION,
      type: "system" as const,
      description:
        "Lists what the Concierge's patrol observed about the guardian, for Dream to keep stable patterns in memory. Calendar observations and guesses are left out: they never go to memory.",
      visibility: "explicit" as const,
      complexity: "simple" as const,
      speed: "fast" as const,
      reliability: "high" as const,
      sideEffects: "read-only" as const,
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      try {
        return { status: "ok", data: { observations: forMemory(await deps.observations.list()) } };
      } catch (error) {
        return { status: "error", error: messageOf(error) };
      }
    },
  });

  void syncRoutine().catch((error: unknown) =>
    log.warn("patrol routine not synced", { error: messageOf(error) }),
  );

  return { stop: () => {}, run: runOnce };
}

/**
 * The observations Dream may keep in memory: observed ones, from no
 * personal-data source, with how often each was told and what came of it.
 */
function forMemory(observations: readonly Observation[]) {
  return observations
    .filter(
      (o) => o.basis === "observed" && !NAMED_SOURCES.includes(o.source) && o.status !== "expired",
    )
    .map((o) => ({
      topic: o.topicKey,
      kind: o.kind,
      source: o.source,
      status: o.status,
      summary: o.summary,
      confidence: o.confidence,
      told: o.toldCount,
      adopted: o.outcomes.filter((outcome) => outcome.outcome === "adopted").length,
      ignored: o.ignoredCount,
      since: o.createdAt.toISOString(),
    }));
}

/** An observation as the patrol reads it, with whether code would let it be told now. */
function viewOf(
  o: Observation,
  at: number,
  taskUpdatedAt: (id: string) => number | null,
): PatrolObservationView {
  const verdict = mayRaise(o, at, o.taskId ? taskUpdatedAt(o.taskId) : null);
  return {
    topicKey: o.topicKey,
    kind: o.kind,
    source: o.source,
    basis: o.basis,
    confidence: o.confidence,
    status: o.status,
    summary: o.summary,
    ...(o.taskId ? { taskId: o.taskId } : {}),
    ...(o.dueAt ? { due: iso(o.dueAt) } : {}),
    toldCount: o.toldCount,
    ...(o.lastToldAt ? { lastTold: iso(o.lastToldAt) } : {}),
    held: verdict.ok ? null : verdict.reason,
  };
}
