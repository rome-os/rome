// Deferred agent self-wakeup. Session model: docs/concepts/sessions.md.
//
// The agent calls `defer` mid-turn with a delay, an absolute time, or an event
// to wait for, plus a note-to-self. We create a one-off routine that, when it
// fires, resumes the *same* session through `resume_session` — so the agent
// wakes in its own conversation with full context. A time wakeup is a dated
// schedule routine; an event wakeup is a `once` event-bus routine.
//
// This module is the pure logic half: parse the input, compute the absolute
// fire instant, and shape the `create_routine` args. The side effects
// (reading the live thread context, subscribing to the event's source,
// calling create_routine through the action engine) are injected by the
// caller (`agent-session.ts`) so this stays testable without a running engine.

import { z } from "zod";
import type { ThreadContext } from "./types.js";

/** The action the one-off routine fires: `resume_session` continues this
 * thread's conversation on any channel. It's a thin shim over the
 * main-process backend-turn orchestrator — defer needs only name the session to
 * resume; the orchestrator owns running the turn and delivering the reply. */
export const RESUME_SESSION_ACTION = "resume_session";

const MINUTE_MS = 60_000;

/** The thread the `defer` call is running in, captured from the live session. */
export interface DeferContext {
  agentName?: string;
  /** Exact runtime session to resume when the one-off routine fires. */
  sessionId: string;
  channelContext?: ThreadContext;
}

export interface DeferDeps {
  context: DeferContext;
  /** Persist + activate the one-off routine; returns create_routine's `data`
   * (or throws on a domain error). Injected so this module never touches the
   * action engine directly. */
  createRoutine: (args: Record<string, unknown>) => Promise<unknown>;
  /** Make sure an event wait can fire: subscribe through the app that
   * declares the event, or confirm an undeclared event is known. Called
   * before the routine is created; on `ok: false` no routine is created.
   * Absent = no check. */
  prepareEventWait?: (
    eventName: string,
    filter: { field: string; equals: string }[],
  ) => Promise<
    | { ok: true; subscription?: "existing" | "created"; warning?: string }
    | { ok: false; error: string }
  >;
  /** Wall-clock `Date.now()` for the running turn, injected for testability. */
  now: number;
}

export type DeferResult =
  | {
      ok: true;
      /** The name stored on the one-off routine (shown on the Routines page). */
      name: string;
      /** Absolute UTC instant the wakeup is scheduled for (ISO 8601). */
      deferredUntil: string;
      routineId?: string;
    }
  | {
      ok: true;
      name: string;
      /** The event type the wakeup waits for. */
      waitingFor: string;
      /** For an app-declared event: whether the provider subscription was
       * already there or was created for this wait. */
      subscription?: "existing" | "created";
      /** Set when the wait was created but may never fire, e.g. nothing has
       * emitted the event since boot. */
      warning?: string;
      routineId?: string;
    };

type ParsedDefer =
  | { ok: true; kind: "time"; name: string; fireAtMs: number }
  | { ok: true; kind: "event"; name: string; event: DeferEvent }
  | { ok: false; error: string };

// Strict: an unknown key (say, a field nested one level off) is an error the
// model sees and fixes, not a field silently dropped.
const deferEventSchema = z.strictObject({
  eventName: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message: "defer.event.eventName is required" }),
  sourcePattern: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      message: "defer.event.sourcePattern must be non-empty when provided",
    })
    .optional(),
  filter: z
    .array(
      z.object({
        field: z
          .string()
          .transform((value) => value.trim())
          .refine((value) => value.length > 0 && value.split(".").every((seg) => seg.trim()), {
            message: "defer.event.filter field must be a dot-path with no empty segments",
          }),
        equals: z.string(),
      }),
    )
    .optional(),
});

type DeferEvent = z.infer<typeof deferEventSchema>;

/** The `defer` tool input. The MCP boundary already validates the model's call
 * against the advertised JSON schema (see `mcp-facade.ts` → `toMcpToolShape`),
 * so field types are guaranteed by the time we get here; this schema is the
 * runtime source of truth that also encodes the constraints a JSON schema
 * can't express — exactly one of `afterMinutes`, `at` or `event` is required.
 * The future-time check stays in code (a schema can't see "now"). `name` is
 * trimmed-then-required so a whitespace-only name can't slip through. Strict,
 * like the event object: an unknown key is rejected, not dropped. */
export const deferInputSchema = z
  .strictObject({
    name: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, {
        message: "defer.name is required — a short name for what you're watching",
      }),
    afterMinutes: z.number().int().min(1).optional(),
    at: z.string().optional(),
    event: deferEventSchema.optional(),
  })
  .refine(
    (value) => [value.afterMinutes, value.at, value.event].filter((v) => v != null).length === 1,
    {
      message:
        'defer needs exactly one of "afterMinutes", "at" (an ISO 8601 instant) or "event" (an event to wait for)',
    },
  );

export type DeferInput = z.infer<typeof deferInputSchema>;

/** Validate the tool input. A time wakeup resolves to one absolute fire
 * instant, ceiled to the next whole minute (the schedule trigger is
 * minute-resolution) and in the future. An event wakeup resolves to the event
 * match. Exported for unit tests. */
export function parseDeferInput(input: unknown, now: number): ParsedDefer {
  const parsed = deferInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: "invalid defer input" };
    // Name where a structural error sits ("defer.event: Unrecognized key …");
    // the custom messages already start with their path.
    const where = ["defer", ...issue.path.map(String)].join(".");
    const error = issue.message.startsWith("defer") ? issue.message : `${where}: ${issue.message}`;
    return { ok: false, error };
  }
  const { name, afterMinutes, at, event } = parsed.data;

  if (event) return { ok: true, kind: "event", name, event };

  let rawMs: number;
  if (afterMinutes != null) {
    rawMs = now + afterMinutes * MINUTE_MS;
  } else {
    // The refine above guarantees `at` is set when `afterMinutes` isn't.
    const parsedAt = Date.parse(at as string);
    if (Number.isNaN(parsedAt)) {
      return { ok: false, error: `defer.at "${at}" is not a valid ISO 8601 instant` };
    }
    rawMs = parsedAt;
  }

  // Minute floor: the schedule trigger is HH:mm. Ceil so we never
  // round down into the past, and so "fire in N minutes" never lands early.
  const fireAtMs = Math.ceil(rawMs / MINUTE_MS) * MINUTE_MS;
  if (fireAtMs <= now) {
    return { ok: false, error: "defer fires in the past — pick a time at least a minute from now" };
  }

  return { ok: true, kind: "time", name, fireAtMs };
}

/** Build the args `resume_session` fires with: which runtime session to continue,
 * where its reply is delivered, and the prompt the woken turn receives.
 * No trust fields — a continuation skips the inbound trust pipeline. */
function buildResumeArgs(
  context: DeferContext,
  prompt: Record<string, unknown>,
): Record<string, unknown> {
  const channelContext = context.channelContext;
  return {
    sessionId: context.sessionId,
    channel: channelContext?.channel,
    threadId: channelContext?.threadId,
    channelUserId: channelContext?.channelUserId,
    agentName: context.agentName ?? "main",
    ...prompt,
  };
}

/** Schedule the deferred wakeup. Throws (for the facade to relay as an error)
 * on bad input or a missing thread context. `parseDeferInput` still re-validates
 * the value-level rules the MCP schema can't express (note non-empty, the
 * afterMinutes/at xor). */
export async function runDefer(input: DeferInput, deps: DeferDeps): Promise<DeferResult> {
  const parsed = parseDeferInput(input, deps.now);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const channelContext = deps.context.channelContext;
  if (!channelContext?.channel || !channelContext?.threadId) {
    throw new Error("defer is only available inside an active conversation thread");
  }

  if (parsed.kind === "event") {
    const { eventName, sourcePattern, filter } = parsed.event;
    // Subscribe first: a routine on an event nothing delivers would wait forever.
    const prepared = deps.prepareEventWait
      ? await deps.prepareEventWait(eventName, filter ?? [])
      : { ok: true as const };
    if (!prepared.ok) throw new Error(prepared.error);
    const data = await deps.createRoutine({
      name: parsed.name,
      trigger: {
        type: "event-bus" as const,
        eventName,
        ...(sourcePattern ? { sourcePattern } : {}),
        ...(filter?.length ? { filter } : {}),
        once: true,
      },
      actionName: RESUME_SESSION_ACTION,
      // `resume_session` appends a summary of the event payload to `text`.
      args: buildResumeArgs(deps.context, {
        text: `📨 Event arrived: ${parsed.name}`,
        attachEvent: true,
      }),
    });
    const routineId = (data as { routineId?: string } | null | undefined)?.routineId;
    return {
      ok: true,
      name: parsed.name,
      waitingFor: eventName,
      ...(prepared.subscription ? { subscription: prepared.subscription } : {}),
      ...(prepared.warning ? { warning: prepared.warning } : {}),
      ...(routineId ? { routineId } : {}),
    };
  }

  const fireAt = new Date(parsed.fireAtMs);
  const iso = fireAt.toISOString();

  const createArgs = {
    // Routine name, shown on the Routines page.
    name: parsed.name,
    // A one-off pinned to an absolute UTC instant. Expressing the instant in UTC
    // sidesteps any guardian-timezone resolution — an instant is the same
    // instant in every zone — and `fixed` keeps it from drifting.
    trigger: {
      type: "schedule" as const,
      tzid: "UTC",
      tzMode: "fixed" as const,
      date: iso.slice(0, 10),
      localTime: iso.slice(11, 16),
    },
    actionName: RESUME_SESSION_ACTION,
    // The woken agent resumes the same session with full context, so the wakeup
    // needs no instructions — just a simple time's-up nudge naming what it was
    // watching. The ⏰ prefix marks it in the thread.
    args: buildResumeArgs(deps.context, { text: `⏰ Time's up: ${parsed.name}` }),
  };

  const data = await deps.createRoutine(createArgs);
  const routineId = (data as { routineId?: string } | null | undefined)?.routineId;

  return { ok: true, name: parsed.name, deferredUntil: iso, ...(routineId ? { routineId } : {}) };
}
