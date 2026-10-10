import { createAppLogger, defineAction, getCurrentActionContext, z } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
  Routine,
  RoutineEngine,
  RoutinesRepository,
  Trigger,
} from "@rome-os/app-runtime";
export type { CreateRoutineOutput } from "./types.js";

const log = createAppLogger("create-routine");

// The engine merges trigger payloads into action args under this key. Forbid
// it in caller-supplied args so a routine never silently overwrites it.
const RESERVED_ARG_KEY = "__triggerPayload";

const scheduleTriggerSchema = z.object({
  type: z.literal("schedule"),
  tzid: z.string().describe("IANA timezone identifier, e.g. America/Los_Angeles"),
  tzMode: z
    .enum(["fixed", "floating"])
    .describe(
      "REQUIRED — how the timezone is bound; choose deliberately. 'floating' means the routine follows the guardian: it fires at localTime in their CURRENT timezone and re-targets automatically if they move (use this for almost everything — 'remind me at 9am' means 9am wherever they are). 'fixed' pins the absolute zone in tzid forever, ignoring where the guardian goes — only for a zone-anchored event (a travel reminder at the destination's time, a market open, a locale-tied broadcast). A one-off is always stored as 'fixed': a dated one fires in tzid, and one with neither date nor rrule fires at the next localTime in tzid, or in the guardian's current zone when 'floating'.",
    ),
  localTime: z.string().describe("Time of day in HH:mm format (24-hour)"),
  rrule: z
    .string()
    .optional()
    .describe("iCal RRULE for a recurring routine; mutually exclusive with date"),
  date: z
    .string()
    .optional()
    .describe(
      "Calendar date (YYYY-MM-DD) for a one-off; omit both date and rrule to fire once at the next localTime, stored as that date",
    ),
});

const eventBusTriggerSchema = z.object({
  type: z.literal("event-bus"),
  eventName: z.string().min(1).describe("Watchable event type (find it with search_event_catalog)"),
  sourcePattern: z.string().optional(),
  filter: z
    .array(z.object({ field: z.string().min(1), equals: z.string() }))
    .optional()
    .describe("Payload conditions, AND-ed together; omit to fire on every matching event"),
});

const manualTriggerSchema = z.object({
  type: z.literal("manual"),
  // No config: a manual routine never fires on its own. Use this for a saved
  // playbook the guardian runs on demand from the dashboard's Run-now button.
});

export const createRoutineInputSchema = z.object({
  name: z.string().min(1).describe("Human-readable routine name shown to the guardian"),
  key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional stable, unique identity for dedup/idempotency, distinct from the display name. " +
        "Creation is rejected if a routine already uses this key. Omit unless you need to " +
        "recreate or guard against double-creating a specific routine (e.g. an app managing its own).",
    ),
  trigger: z
    .discriminatedUnion("type", [scheduleTriggerSchema, eventBusTriggerSchema, manualTriggerSchema])
    .describe("When the routine fires"),
  actionName: z.string().min(1).describe("Name of the action to run when the trigger fires"),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "A single argument object passed to the action. Not an array — to fan out, create one routine per argument set",
    ),
  enabled: z
    .boolean()
    .optional()
    .describe("Whether the routine is live on creation (default true)"),
});

export type CreateRoutineInput = z.infer<typeof createRoutineInputSchema>;

export interface CreateRoutineDeps {
  routinesRepo: RoutinesRepository;
  /** Real engine in the main process, RPC-backed proxy in the action worker —
   * injected per process, so this action never knows where it runs. */
  routineEngine: RoutineEngine;
  /** The action registry of the executing process. Used to reject a routine
   * bound to an action that doesn't exist — otherwise the routine persists and
   * fails the `actionEngine.run` lookup on every fire. Both the main process
   * and the action worker put a fully-populated registry in the action deps. */
  actionRegistry: ActionExistenceChecker;
  /** Core's resolver that stores "once at the next localTime" as a dated
   * one-off, the same one POST /routines uses. Each process binds it to its own
   * guardian-timezone setting. */
  resolveOneOffDate: (trigger: Trigger) => Promise<Trigger>;
}

/** The single capability create_routine needs from the action registry: ask
 * whether an action name is registered. Named (rather than an inline shape) so
 * the dependency reads as a contract; the runtime passes the full registry,
 * which satisfies it. */
export interface ActionExistenceChecker {
  has(name: string): boolean | Promise<boolean>;
}

/** Error returned when a routine names an action that isn't registered. Names
 * the remedy so the agent routes correctly instead of guessing again: build the
 * missing automation as a workflow (which registers a `<appId>_run` action),
 * or fall back to the always-available `summon` / `send_message`. */
export function unknownActionError(actionName: string): string {
  return (
    `actionName "${actionName}" is not a registered action. ` +
    `To run multi-step work that doesn't exist yet, build it first with the ` +
    `workflow_creation skill (it registers a "<appId>_run" action), then bind the ` +
    `routine to that action. For one-shot judgement or a notification, use the ` +
    `built-in "summon" or "send_message".`
  );
}

const LOCAL_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The FREQ and BYDAY tokens ScheduleTriggerProvider.rruleToCron understands.
// It silently falls back (unknown FREQ → DAILY, unknown BYDAY → Sunday), so a
// typo would otherwise produce a live routine on the wrong cadence. Reject
// anything outside these sets up front.
const VALID_FREQ = new Set(["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const VALID_BYDAY = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);

// The clauses ScheduleTriggerProvider.rruleToCron actually applies for each
// FREQ. Anything else in the RRULE (e.g. INTERVAL under WEEKLY, BYDAY under
// DAILY, or COUNT/UNTIL anywhere) is silently ignored by the cron conversion,
// changing the cadence the caller asked for — so reject it. Keep in sync with
// rruleToCron; the deeper fix is for that converter to fail loudly itself.
const HONORED_CLAUSES: Record<string, Set<string>> = {
  MINUTELY: new Set(["FREQ", "INTERVAL"]),
  HOURLY: new Set(["FREQ", "INTERVAL"]),
  DAILY: new Set(["FREQ", "INTERVAL"]),
  WEEKLY: new Set(["FREQ", "BYDAY"]),
  MONTHLY: new Set(["FREQ", "INTERVAL", "BYMONTHDAY"]),
  YEARLY: new Set(["FREQ", "BYMONTH", "BYMONTHDAY"]),
};

/** Convert a wall-clock date+time in `tzid` to the real UTC instant — the same
 * algorithm `ScheduleTriggerProvider.parseDateAndLocalTime` uses at fire time.
 * Treats the fields as if they were UTC, then corrects by the zone's offset at
 * that instant. Inlined because app actions can't import core internals. */
function wallClockToUtc(date: string, localTime: string, tzid: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(guessUtcMs))
      .map((p) => [p.type, p.value]),
  );
  const tzWallMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl can emit "24" for midnight in some locales — normalize to 0.
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    0,
  );
  return new Date(guessUtcMs - (tzWallMs - guessUtcMs));
}

/** Trim the exact-match string fields of an event-bus trigger so a value with
 * stray whitespace (`" gmail.x "`) isn't persisted verbatim and then never
 * matched by EventBusTriggerProvider's exact comparison. `equals` is left
 * untouched — it's matched against payload values that may legitimately contain
 * whitespace. Schedule triggers pass through unchanged. */
function canonicalizeTrigger(trigger: CreateRoutineInput["trigger"]): Trigger {
  if (trigger.type === "schedule") {
    // A dated one-off is an absolute instant: pin it to a `fixed` zone at
    // creation. `floating` would make the scheduler resolve the fire
    // instant against the guardian's *live* zone, which (a) disagrees with the
    // past-date check below — computed from the stored `tzid` — and (b) would
    // silently move the instant if the guardian's zone later changes, even
    // though a one-off should fire at the moment it was scheduled for. The
    // supplied `tzid` is the zone at creation, so pinning it resolves the
    // one-off to a stable absolute instant.
    if (trigger.date && trigger.tzMode !== "fixed") {
      return { ...trigger, tzMode: "fixed" };
    }
    return trigger;
  }
  // Event-bus triggers need their match strings trimmed.
  if (trigger.type !== "event-bus") return trigger;
  return {
    ...trigger,
    eventName: trigger.eventName.trim(),
    ...(trigger.sourcePattern !== undefined ? { sourcePattern: trigger.sourcePattern.trim() } : {}),
    ...(trigger.filter
      ? { filter: trigger.filter.map((c) => ({ field: c.field.trim(), equals: c.equals })) }
      : {}),
  };
}

/** Validate trigger fields per type. Returns an error string (for the agent to
 * relay) or null. Fails closed so a malformed trigger never becomes an enabled
 * routine that silently never fires. */
function validateTrigger(trigger: Trigger): string | null {
  if (trigger.type === "schedule") {
    if (!LOCAL_TIME_RE.test(trigger.localTime)) {
      return `trigger.localTime "${trigger.localTime}" must be HH:mm (24-hour), e.g. 09:30`;
    }
    if (trigger.tzid !== "UTC") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: trigger.tzid });
      } catch {
        return `trigger.tzid "${trigger.tzid}" is not a valid IANA timezone`;
      }
    }
    if (trigger.date !== undefined) {
      if (!DATE_RE.test(trigger.date)) {
        return 'trigger.date must be "YYYY-MM-DD"';
      }
      // Shape alone isn't enough: "2026-02-30" matches the regex but the
      // scheduler's Date.UTC conversion silently normalizes it to Mar 2, so the
      // routine fires on a different day than asked. Reject dates that don't
      // round-trip through a real calendar.
      const [y, mo, d] = trigger.date.split("-").map(Number);
      const parsed = new Date(Date.UTC(y, mo - 1, d));
      if (
        parsed.getUTCFullYear() !== y ||
        parsed.getUTCMonth() !== mo - 1 ||
        parsed.getUTCDate() !== d
      ) {
        return `trigger.date "${trigger.date}" is not a real calendar date`;
      }
      if (trigger.rrule) {
        return "trigger.date and trigger.rrule are mutually exclusive";
      }
      // A one-off whose instant has already passed would persist as an enabled
      // routine that never fires (ScheduleTriggerProvider assumes the create
      // path filtered these out). Compare in the routine's own timezone so a
      // positive-offset zone can't slip an already-expired one-off through.
      const fireAt = wallClockToUtc(trigger.date, trigger.localTime, trigger.tzid);
      if (fireAt.getTime() < Date.now()) {
        return `trigger.date "${trigger.date}" ${trigger.localTime} is in the past for ${trigger.tzid}`;
      }
    }
    // A blank rrule ("") is neither a real recurrence nor an omitted one: with
    // no date it reads as "fire once at the next localTime", silently changing
    // recurring intent into a one-off. Reject it; omit rrule entirely for a
    // one-off.
    if (trigger.rrule !== undefined && !trigger.rrule.trim()) {
      return "trigger.rrule must be a non-empty RRULE when provided (omit it for a one-off)";
    }
    if (trigger.rrule) {
      const upper = trigger.rrule.toUpperCase();
      const freqMatch = upper.match(/FREQ=([A-Z]+)/);
      if (!freqMatch || !VALID_FREQ.has(freqMatch[1])) {
        return `trigger.rrule must specify a valid FREQ (one of ${[...VALID_FREQ].join(", ")})`;
      }
      // Reject clauses this FREQ doesn't honor, rather than let the scheduler
      // silently drop them and fire on a different cadence.
      const honored = HONORED_CLAUSES[freqMatch[1]];
      const clauseNames = [...upper.matchAll(/(?:^|;)([A-Z]+)=/g)].map((m) => m[1]);
      const unsupported = clauseNames.filter((clause) => !honored.has(clause));
      if (unsupported.length > 0) {
        return `FREQ=${freqMatch[1]} does not support clause(s): ${[...new Set(unsupported)].join(", ")} — the scheduler would ignore them and fire on a different cadence`;
      }
      // Every downstream check (and rruleToCron itself) reads only the first
      // occurrence of each clause, so a repeat like FREQ=DAILY;INTERVAL=1;INTERVAL=2
      // or a doubled FREQ silently fires on the first value's cadence while the
      // caller may have meant the second. Reject any repeated clause.
      const duplicates = [...new Set(clauseNames.filter((c, i) => clauseNames.indexOf(c) !== i))];
      if (duplicates.length > 0) {
        return `trigger.rrule repeats clause(s): ${duplicates.join(", ")} — each clause may appear at most once`;
      }
      // rruleToCron consumes only the first number of each numeric clause and
      // otherwise falls back, so a multi-value ("1,15") or non-numeric ("foo")
      // clause silently produces the wrong cadence. Match each clause to the end
      // of its segment and require a single in-range integer.
      const singleIntClause = (name: string, min: number, max: number): string | null => {
        const m = upper.match(new RegExp(`${name}=([^;]*)`));
        if (!m) return null;
        const v = m[1];
        if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
          return `trigger.rrule ${name} must be a single integer between ${min} and ${max}`;
        }
        return null;
      };
      // INTERVAL=0/negative produces a `*/0` cron that never fires.
      const intervalErr = singleIntClause("INTERVAL", 1, 1_000_000);
      if (intervalErr) return intervalErr;
      // Reject FREQs whose day/month rruleToCron leaves to a nondeterministic
      // or silently-assumed default: MONTHLY → every day, WEEKLY → the weekday
      // the routine happens to be created on, YEARLY → Jan 1.
      if (freqMatch[1] === "MONTHLY" && !/BYMONTHDAY=\d+/.test(upper)) {
        return "FREQ=MONTHLY requires BYMONTHDAY=N — without it the schedule silently fires daily (e.g. FREQ=MONTHLY;BYMONTHDAY=15)";
      }
      if (freqMatch[1] === "WEEKLY" && !/(?:^|;)BYDAY=/.test(upper)) {
        return "FREQ=WEEKLY requires BYDAY=... (e.g. BYDAY=MO) — without it the firing day is nondeterministic";
      }
      if (
        freqMatch[1] === "YEARLY" &&
        !(/(?:^|;)BYMONTH=/.test(upper) && /(?:^|;)BYMONTHDAY=/.test(upper))
      ) {
        return "FREQ=YEARLY requires both BYMONTH=M and BYMONTHDAY=D (e.g. BYMONTH=1;BYMONTHDAY=1)";
      }
      const bmdErr = singleIntClause("BYMONTHDAY", 1, 31);
      if (bmdErr) return bmdErr;
      const bmErr = singleIntClause("BYMONTH", 1, 12);
      if (bmErr) return bmErr;
      // Match the whole BYDAY value (up to the next clause) so ordinals like
      // "1MO" — which rruleToCron silently maps to today's weekday — are caught
      // rather than partially matched.
      const byDay = upper.match(/BYDAY=([^;]+)/);
      if (byDay) {
        const bad = byDay[1]
          .split(",")
          .map((d) => d.trim())
          .filter((d) => !VALID_BYDAY.has(d));
        if (bad.length > 0) {
          return `trigger.rrule has invalid BYDAY token(s): ${bad.join(", ")} (use SU,MO,TU,WE,TH,FR,SA; ordinals like 1MO are not supported)`;
        }
      }
    }
  }
  if (trigger.type === "event-bus") {
    // EventBusTriggerProvider matches on exact eventName equality, so a blank
    // name can never fire. Validate here too (not only in the Zod schema) so a
    // direct/programmatic call is fail-closed regardless of how it was built.
    if (!trigger.eventName.trim()) {
      return "trigger.eventName must be a non-empty event type (find one with search_event_catalog)";
    }
    // A blank sourcePattern is falsy to EventBusTriggerProvider, which widens
    // the routine to every source — the opposite of what a caller who bothered
    // to send the field intended. Reject it; omit the field to match all.
    if (trigger.sourcePattern !== undefined && !trigger.sourcePattern.trim()) {
      return "trigger.sourcePattern must be non-empty when provided (omit it to match all sources)";
    }
    for (const cond of trigger.filter ?? []) {
      if (!cond.field.trim() || typeof cond.equals !== "string") {
        return "each trigger.filter condition needs a non-empty field and a string equals";
      }
      // EventBusTriggerProvider resolves field as a dot-path (path.split(".")),
      // so an empty or whitespace-only segment (".from", "from.", "from..email")
      // reads as obj[""] → undefined and the routine can never match. Reject it
      // before persisting rather than create a live-but-dead routine.
      if (cond.field.split(".").some((seg) => seg.trim() === "")) {
        return `trigger.filter field "${cond.field}" has an empty path segment — use dot-separated keys with no blank segments (e.g. message.from.email)`;
      }
    }
  }
  return null;
}

/** Bring a freshly-created routine live. Activation is best-effort: the row
 * is already persisted, so a failure degrades to "created but not yet active"
 * (the boot-time `routineEngine.start()` sweep re-activates it) rather than
 * surfacing as a hard error that would make callers retry and duplicate. */
async function activateRoutine(routine: Routine, engine: RoutineEngine): Promise<void> {
  try {
    await engine.activate(routine);
  } catch (err) {
    log.error("failed to activate routine", {
      routineId: routine.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function createRoutine(
  input: CreateRoutineInput,
  deps: CreateRoutineDeps,
): Promise<ActionResult> {
  const args = input.args ?? {};
  if (Array.isArray(args)) {
    return {
      status: "error",
      error:
        "args must be a single object — fan-out is unsupported; create one routine per argument set instead",
    };
  }
  if (RESERVED_ARG_KEY in args) {
    return { status: "error", error: `args may not contain reserved key "${RESERVED_ARG_KEY}"` };
  }

  // A blank/whitespace actionName fails the exact lookup in actionEngine.run on
  // every fire; reject and persist the trimmed canonical form.
  const actionName = input.actionName.trim();
  if (!actionName) {
    return { status: "error", error: "actionName must be a non-empty action name" };
  }
  // Fail closed: a routine bound to a non-existent action would persist and
  // error on every fire (actionEngine.run throws "Action not found"). Reject at
  // create time with a remedy the agent can act on.
  if (!(await deps.actionRegistry.has(actionName))) {
    return { status: "error", error: unknownActionError(actionName) };
  }

  // `name` is the human-readable display label; trim and reject blank so a
  // whitespace-only " " isn't persisted as a routine with no visible title.
  const name = input.name.trim();
  if (!name) {
    return { status: "error", error: "name must be a non-empty routine name" };
  }

  // `key` is the optional stable identity for dedup. Trim, treat blank as unset,
  // and reject a duplicate before insert (the column's UNIQUE constraint is the
  // authoritative backstop against a create/create race). A taken key is a
  // caller error — surface it rather than silently creating an unkeyed twin.
  const key = input.key?.trim() || undefined;
  if (key) {
    const existing = await deps.routinesRepo.findByKey(key);
    if (existing) {
      return {
        status: "error",
        error: `a routine with key "${key}" already exists (id ${existing.id}); delete it first or use a different key`,
      };
    }
  }

  const canonical = canonicalizeTrigger(input.trigger);
  const triggerError = validateTrigger(canonical);
  if (triggerError) {
    return { status: "error", error: triggerError };
  }
  const trigger = await deps.resolveOneOffDate(canonical);

  // The runtime attributes the routine to the app that invoked this action (from
  // action ownership, not caller-supplied) — so any routine an app creates is
  // managed by that app, and a routine an agent/user creates stays unmanaged.
  const managedBy = getCurrentActionContext()?.callerAppId;

  const enabled = input.enabled ?? true;
  const routineId = await deps.routinesRepo.create({
    name,
    key,
    managedBy,
    trigger,
    actionName,
    args,
    enabled,
  });

  if (enabled) {
    const routine: Routine = {
      id: routineId,
      name,
      key,
      managedBy,
      enabled: true,
      trigger,
      actionName,
      args,
      createdAt: new Date(),
    };
    await activateRoutine(routine, deps.routineEngine);
  }

  return { status: "ok", data: { routineId } };
}

// --- Action factory ---

export function createCreateRoutineAction(config: ActionConfig, deps: CreateRoutineDeps): Action {
  return defineAction({
    config,
    schema: createRoutineInputSchema,
    execute: (input) => createRoutine(input, deps),
  });
}

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<CreateRoutineDeps>,
): Action {
  // The deps bag is untyped at the wiring seam; a missing dep must fail the
  // action load at boot, not surface as a runtime TypeError (or worse, a
  // zombie routine) on first invocation.
  if (!deps.routineEngine) {
    throw new Error("create_routine requires a routineEngine dep");
  }
  if (!deps.routinesRepo) {
    throw new Error("create_routine requires a routinesRepo dep");
  }
  if (typeof deps.actionRegistry?.has !== "function") {
    throw new Error("create_routine requires an actionRegistry dep with has()");
  }
  if (typeof deps.resolveOneOffDate !== "function") {
    throw new Error("create_routine requires a resolveOneOffDate dep");
  }
  return createCreateRoutineAction(config, deps);
}
