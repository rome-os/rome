import { http, HttpResponse } from "msw";
import type { ActionNode } from "@/components/agent-trace/ActionExecutionTree";
import type { RoutineRunTrace, RunNowResult } from "@/hooks/use-routines";
import type { Routine, RoutineRun } from "@/lib/routine-language";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fixture clock. `nextRunAt` is compared against the browser's real clock, so
 *  a literal date decays into the past and the card silently drops its "next
 *  run" text — the schedule then reads as one that already missed its slot. */
const fromNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

// Routines fixtures. The page derives every guardian-facing sentence from the
// trigger alone, so the set below is chosen to exercise that derivation rather
// than to look plausible: a daily schedule, a weekday rrule, a monthly one, a
// schedule pinned to a non-local timezone, an event-bus subscription, and a
// manual routine that only ever runs on demand.

const routines: Routine[] = [
  {
    id: "routine-brief",
    name: "Morning brief",
    enabled: true,
    trigger: {
      type: "schedule",
      tzid: "America/Los_Angeles",
      tzMode: "floating",
      localTime: "07:00",
      rrule: "FREQ=DAILY",
    },
    actionName: "daily_summary",
    args: { sections: ["inbox", "weather"] },
    createdAt: fromNow(-60 * DAY),
    lastFiredAt: fromNow(-19 * HOUR),
    nextRunAt: fromNow(5 * HOUR),
    lastRun: { status: "success", firedAt: fromNow(-19 * HOUR) },
  },
  {
    id: "routine-standup",
    name: "Weekday inbox sweep",
    enabled: true,
    trigger: {
      type: "schedule",
      tzid: "America/Los_Angeles",
      tzMode: "floating",
      localTime: "17:30",
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    },
    actionName: "inbox_scan",
    args: {},
    createdAt: fromNow(-42 * DAY),
    lastFiredAt: fromNow(-2 * DAY),
    nextRunAt: fromNow(9 * HOUR),
    lastRun: { status: "success", firedAt: fromNow(-2 * DAY) },
  },
  {
    // A schedule pinned to a zone the browser is unlikely to be in, so the
    // sentence appends its tzid rather than showing a local-looking time that
    // is actually anchored elsewhere.
    id: "routine-rent",
    name: "Rent reminder",
    enabled: true,
    trigger: {
      type: "schedule",
      tzid: "Europe/Berlin",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=28",
    },
    actionName: "send_message",
    args: { person: "Ray", text: "Rent is due on the 1st." },
    createdAt: fromNow(-84 * DAY),
    lastFiredAt: fromNow(-14 * DAY),
    nextRunAt: fromNow(16 * DAY),
    lastRun: { status: "success", firedAt: fromNow(-14 * DAY) },
  },
  {
    // Failing routine: the card's Failed badge and the run history's error
    // detail both read off this one.
    id: "routine-ledger",
    name: "Ledger sync",
    enabled: true,
    trigger: { type: "event-bus", eventName: "expense.logged", sourcePattern: "expense-tracker" },
    actionName: "ledger_push",
    args: { spreadsheetId: "1a2b3c" },
    createdAt: fromNow(-25 * DAY),
    lastFiredAt: fromNow(-3 * HOUR),
    nextRunAt: null,
    lastRun: { status: "error", firedAt: fromNow(-3 * HOUR) },
  },
  {
    // Mid-run, so the Running badge and the Stop control have a target. A
    // running routine has no `nextRunAt` to show yet.
    id: "routine-digest",
    name: "Weekly digest",
    enabled: true,
    trigger: {
      type: "schedule",
      tzid: "America/Los_Angeles",
      tzMode: "floating",
      localTime: "18:00",
      rrule: "FREQ=WEEKLY;BYDAY=SU",
    },
    actionName: "daily_summary",
    args: { window: "7d" },
    createdAt: fromNow(-43 * DAY),
    lastFiredAt: fromNow(-4 * MINUTE),
    nextRunAt: null,
    lastRun: { status: "running", firedAt: fromNow(-4 * MINUTE) },
  },
  {
    // Disabled and manual-only: never scheduled, never fired. Its card is the
    // one with no next run and no history at all.
    id: "routine-archive",
    name: "Archive old notes",
    enabled: false,
    trigger: { type: "manual" },
    actionName: "note_search",
    args: { olderThanDays: 180 },
    createdAt: fromNow(-11 * DAY),
    lastFiredAt: null,
    nextRunAt: null,
    lastRun: null,
  },
];

/** Run history per routine, newest first — the order the endpoint promises and
 *  the card's mini-history renders without re-sorting. */
const runs: Record<string, RoutineRun[]> = {
  "routine-brief": [
    {
      id: "run-brief-5",
      status: "success",
      firedAt: fromNow(-19 * HOUR),
      durationMs: 11_400,
    },
    {
      id: "run-brief-4",
      status: "success",
      firedAt: fromNow(-43 * HOUR),
      durationMs: 9_800,
    },
    {
      id: "run-brief-3",
      status: "error",
      firedAt: fromNow(-67 * HOUR),
      durationMs: 3_200,
      error: "weather_forecast: upstream timed out after 3s",
    },
    {
      id: "run-brief-2",
      status: "success",
      firedAt: fromNow(-91 * HOUR),
      durationMs: 10_100,
    },
    {
      id: "run-brief-1",
      status: "cancelled",
      firedAt: fromNow(-115 * HOUR),
      durationMs: 1_050,
    },
  ],
  "routine-standup": [
    {
      id: "run-standup-2",
      status: "success",
      firedAt: fromNow(-2 * DAY),
      durationMs: 4_900,
    },
    {
      id: "run-standup-1",
      status: "pending_approval",
      firedAt: fromNow(-3 * DAY),
      durationMs: null,
    },
  ],
  "routine-rent": [
    { id: "run-rent-1", status: "success", firedAt: fromNow(-14 * DAY), durationMs: 640 },
  ],
  "routine-ledger": [
    {
      id: "run-ledger-1",
      status: "error",
      firedAt: fromNow(-3 * HOUR),
      durationMs: 2_100,
      error: "Action registration failed: `ledger_push` declared an unknown input schema.",
    },
  ],
  "routine-digest": [
    {
      id: "run-digest-1",
      status: "running",
      firedAt: fromNow(-4 * MINUTE),
      durationMs: null,
    },
  ],
  "routine-archive": [],
};

/** Epoch **seconds** — the trace schema stores timestamps that way, and the
 *  tree renders durations off them. */
const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const node = (fields: Partial<ActionNode> & Pick<ActionNode, "id" | "actionName" | "status">) => ({
  durationMs: null,
  children: [],
  ...fields,
});

// Only the runs a guardian is likely to expand carry a trace: the successful
// brief (a real multi-step tree) and the failed ledger push (one node with the
// swallowed tool message). Every other run falls back to the endpoint's 404,
// which the expander renders as its own load error.
const traces: Record<string, RoutineRunTrace> = {
  "run-brief-5": {
    runId: "run-brief-5",
    status: "success",
    error: null,
    roots: [
      node({
        id: "exec-1",
        actionName: "daily_summary",
        status: "success",
        actionType: "custom",
        durationMs: 11_400,
        initiator: "routine:morning-brief",
        args: { sections: ["inbox", "weather"] },
        startedAt: at("2026-08-05T14:00:00.000Z"),
        finishedAt: at("2026-08-05T14:00:11.400Z"),
        children: [
          node({
            id: "exec-1a",
            actionName: "inbox_scan",
            status: "success",
            durationMs: 4_900,
            startedAt: at("2026-08-05T14:00:01.000Z"),
            finishedAt: at("2026-08-05T14:00:05.900Z"),
          }),
          node({
            id: "exec-1b",
            actionName: "weather_forecast",
            status: "success",
            durationMs: 1_300,
            args: { location: "home", days: 1 },
            startedAt: at("2026-08-05T14:00:06.000Z"),
            finishedAt: at("2026-08-05T14:00:07.300Z"),
          }),
        ],
      }),
    ],
  },
  "run-ledger-1": {
    runId: "run-ledger-1",
    status: "error",
    error: "Action registration failed: `ledger_push` declared an unknown input schema.",
    roots: [
      node({
        id: "exec-2",
        actionName: "ledger_push",
        status: "error",
        durationMs: 2_100,
        error: "inputSchema: expected a zod schema, received undefined",
        args: { spreadsheetId: "1a2b3c" },
        startedAt: at("2026-08-05T06:30:00.000Z"),
        finishedAt: at("2026-08-05T06:30:02.100Z"),
      }),
    ],
  },
};

/** Run states that block a delete. Mirrors core's ACTIVE_ROUTINE_RUN_STATUSES —
 *  a run awaiting approval is as active as one executing. */
const ACTIVE_RUN_STATUSES = new Set<RoutineRun["status"]>(["running", "pending_approval"]);

let nextRoutineId = 1;

/** A disabled routine is never scheduled, so toggling it off has to clear its
 *  next run — and toggling it back on has to produce a *future* one, the way
 *  reactivation recomputes the next occurrence. The mock can't evaluate an
 *  rrule, so it remembers how far ahead each schedule sat and re-offsets from
 *  the current clock; replaying the stored instant would hand back a time that
 *  has since passed. */
const scheduledLeadMs = new Map(
  routines.map((routine) => [
    routine.id,
    routine.nextRunAt ? Date.parse(routine.nextRunAt) - Date.now() : null,
  ]),
);

function findRoutine(id: string): Routine | undefined {
  return routines.find((routine) => routine.id === id);
}

export interface MockRoutineCreatedContext {
  sessionId: string;
  turnId: string;
  toolUseId: string;
}

type MockRoutineCreatedListener = (context: MockRoutineCreatedContext, routine: Routine) => void;
let routineCreatedListener: MockRoutineCreatedListener | undefined;

export function setMockRoutineCreatedListener(listener: MockRoutineCreatedListener): void {
  routineCreatedListener = listener;
}

export const routineHandlers = [
  http.get("/api/routines", () => HttpResponse.json(routines)),
  // Also the write behind the transcript's routine_draft_card: turning that card
  // on lands here, so a routine created from chat shows up on this page.
  http.post("/api/routines", async ({ request }) => {
    const body = (await request.json()) as Omit<
      Routine,
      "id" | "createdAt" | "lastFiredAt" | "nextRunAt" | "lastRun"
    > & { webchatContext?: MockRoutineCreatedContext };
    const { webchatContext, ...routineBody } = body;
    const created: Routine = {
      ...routineBody,
      id: `routine-new-${nextRoutineId++}`,
      createdAt: new Date().toISOString(),
      lastFiredAt: null,
      nextRunAt: null,
      lastRun: null,
    };
    routines.unshift(created);
    runs[created.id] = [];
    if (webchatContext) routineCreatedListener?.(webchatContext, created);
    return HttpResponse.json(created, { status: 201 });
  }),
  http.get("/api/routines/:id/runs", ({ params, request }) => {
    const routine = findRoutine(String(params.id));
    if (!routine) return HttpResponse.json({ error: "Unknown routine" }, { status: 404 });
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    const history = runs[routine.id] ?? [];
    return HttpResponse.json(
      Number.isFinite(limit) && limit > 0 ? history.slice(0, limit) : history,
    );
  }),
  http.get("/api/routines/:id/runs/:runId/trace", ({ params }) => {
    const trace = traces[String(params.runId)];
    if (!trace) return HttpResponse.json({ error: "No trace for this run" }, { status: 404 });
    return HttpResponse.json(trace);
  }),
  // A manual run executes for real on the server, so the HTTP call succeeding
  // says nothing about the outcome: this records a run and reports its status,
  // and the routine whose action is broken reports an error from a 200.
  http.post("/api/routines/:id/run", ({ params }) => {
    const routine = findRoutine(String(params.id));
    if (!routine) return HttpResponse.json({ error: "Unknown routine" }, { status: 404 });
    const failing = routine.id === "routine-ledger";
    const firedAt = new Date().toISOString();
    const result: RunNowResult = {
      runId: `run-manual-${routine.id}-${nextRoutineId++}`,
      status: failing ? "error" : "success",
      ...(failing ? { error: "Action registration failed: unknown input schema." } : {}),
    };
    routine.lastFiredAt = firedAt;
    routine.lastRun = { status: result.status, firedAt };
    runs[routine.id] = [
      { id: result.runId, status: result.status, firedAt, durationMs: failing ? 900 : 5_400 },
      ...(runs[routine.id] ?? []),
    ];
    return HttpResponse.json(result);
  }),
  http.post("/api/routines/:id/cancel", ({ params }) => {
    const routine = findRoutine(String(params.id));
    if (!routine) return HttpResponse.json({ error: "Unknown routine" }, { status: 404 });
    const history = runs[routine.id] ?? [];
    const active = history.find((run) => run.status === "running");
    if (active) active.status = "cancelled";
    if (routine.lastRun?.status === "running") {
      routine.lastRun = { status: "cancelled", firedAt: routine.lastRun.firedAt };
    }
    return HttpResponse.json({ ok: true });
  }),
  http.patch("/api/routines/:id", async ({ params, request }) => {
    const routine = findRoutine(String(params.id));
    if (!routine) return HttpResponse.json({ error: "Unknown routine" }, { status: 404 });
    const body = (await request.json()) as { enabled: boolean };
    routine.enabled = body.enabled;
    const lead = scheduledLeadMs.get(routine.id);
    routine.nextRunAt = body.enabled && lead != null ? fromNow(Math.max(lead, MINUTE)) : null;
    return HttpResponse.json(routine);
  }),
  // Delete is gated on in-flight runs, atomically with the delete on the real
  // route: a routine mid-run is a 409 and stays put, history included. The
  // Routines page offers Delete on a running card, so a mock that always
  // succeeded would hide the branch the guardian actually hits there.
  http.delete("/api/routines/:id", ({ params }) => {
    const id = String(params.id);
    const index = routines.findIndex((routine) => routine.id === id);
    if (index < 0) return HttpResponse.json({ error: "Unknown routine" }, { status: 404 });
    const activeRuns = (runs[id] ?? []).filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
    if (activeRuns > 0) {
      return HttpResponse.json(
        {
          error: `Routine has ${activeRuns} active run(s); wait for them to finish or cancel them first.`,
        },
        { status: 409 },
      );
    }
    routines.splice(index, 1);
    delete runs[id];
    return HttpResponse.json({ ok: true });
  }),
];
