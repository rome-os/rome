import { defineAction, z } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
export type { CreateRoutineOutput } from "./types.js";

// The rules for a new routine live in core (routines/create.ts), shared with the
// Routines page. This action is how agents and apps reach them: it declares the
// input agents read and hands it to core's `routineCreation`.

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
  eventName: z
    .string()
    .min(1)
    .describe("Watchable event type (find it with system:search_event_catalog)"),
  sourcePattern: z.string().optional(),
  filter: z
    .array(z.object({ field: z.string().min(1), equals: z.string() }))
    .optional()
    .describe("Payload conditions, AND-ed together; omit to fire on every matching event"),
  once: z
    .boolean()
    .optional()
    .describe("Fire on the first matching event only, then disable the routine"),
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

/** Core's routine creation: the main process's own, or a worker's call to it.
 * It reads who asks (the calling app, or the agent) from the running action. */
export interface RoutineCreationService {
  create(input: unknown): Promise<ActionResult>;
}

export interface CreateRoutineDeps {
  routineCreation: RoutineCreationService;
}

export function createCreateRoutineAction(config: ActionConfig, deps: CreateRoutineDeps): Action {
  return defineAction({
    config,
    schema: createRoutineInputSchema,
    execute: async (input) => {
      const result = await deps.routineCreation.create(input);
      // Core names an existing routine for a taken key; the agent reads it in
      // the error text, so only the status and text pass on.
      return result.status === "error" ? { status: "error", error: result.error } : result;
    },
  });
}

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<CreateRoutineDeps>,
): Action {
  // The deps bag is untyped at the wiring seam; a missing dep must fail the
  // action load at boot, not on first invocation.
  if (typeof deps.routineCreation?.create !== "function") {
    throw new Error("system:create_routine requires a routineCreation dep");
  }
  return createCreateRoutineAction(config, deps);
}
