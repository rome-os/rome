// Deferred agent self-wakeup. Session model: docs/concepts/sessions.md.
//
// The agent calls `defer` mid-turn with a delay (or an absolute time) and a
// note-to-self. We schedule a one-off routine that, when it fires, injects the
// note back into the *same* thread through the `inject_thread_message`
// dispatcher — so the agent wakes in its own conversation with full context.
//
// This module is the pure logic half: parse the input, compute the absolute
// fire instant, and shape the `create_routine` args. The side effects
// (reading the live thread context, calling create_routine through the action
// engine) are injected by the caller (`agent-session.ts`) so this stays
// testable without a running engine.

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
  /** Wall-clock `Date.now()` for the running turn, injected for testability. */
  now: number;
}

export interface DeferResult {
  ok: true;
  /** The name stored on the one-off routine (shown on the Routines page). */
  name: string;
  /** Absolute UTC instant the wakeup is scheduled for (ISO 8601). */
  deferredUntil: string;
  routineId?: string;
}

type ParsedDefer = { ok: true; name: string; fireAtMs: number } | { ok: false; error: string };

/** The `defer` tool input. The MCP boundary already validates the model's call
 * against the advertised JSON schema (see `mcp-facade.ts` → `toMcpToolShape`),
 * so field types are guaranteed by the time we get here; this schema is the
 * runtime source of truth that also encodes the one constraint a JSON
 * schema can't express — `afterMinutes` and `at` are mutually exclusive and one
 * is required. The future-time check stays in code (a schema can't see "now").
 * `name` is trimmed-then-required so a whitespace-only name can't slip through. */
export const deferInputSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, {
        message: "defer.name is required — a short name for what you're watching",
      }),
    afterMinutes: z.number().int().min(1).optional(),
    at: z.string().optional(),
  })
  .refine((value) => (value.afterMinutes != null) !== (value.at != null), {
    message: 'defer needs exactly one of "afterMinutes" or "at" (an ISO 8601 instant)',
  });

export type DeferInput = z.infer<typeof deferInputSchema>;

/** Validate the tool input and resolve it to one absolute fire instant. The
 * instant is ceiled to the next whole minute (the schedule trigger is
 * minute-resolution) and must land in the future. Exported for
 * unit tests. */
export function parseDeferInput(input: unknown, now: number): ParsedDefer {
  const parsed = deferInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid defer input" };
  }
  const { name, afterMinutes, at } = parsed.data;

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

  return { ok: true, name, fireAtMs };
}

/** Build the args `resume_session` fires with: which runtime session to continue,
 * where its reply is delivered, and the prompt the woken turn receives.
 * No trust fields — a continuation skips the inbound trust pipeline. */
function buildResumeArgs(name: string, context: DeferContext): Record<string, unknown> {
  const channelContext = context.channelContext;
  return {
    sessionId: context.sessionId,
    channel: channelContext?.channel,
    threadId: channelContext?.threadId,
    channelUserId: channelContext?.channelUserId,
    agentName: context.agentName ?? "main",
    // The woken agent resumes the same session with full context, so the wakeup
    // needs no instructions — just a simple time's-up nudge naming what it was
    // watching. The ⏰ prefix marks it in the thread.
    text: `⏰ Time's up: ${name}`,
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
    args: buildResumeArgs(parsed.name, deps.context),
  };

  const data = await deps.createRoutine(createArgs);
  const routineId = (data as { routineId?: string } | null | undefined)?.routineId;

  return { ok: true, name: parsed.name, deferredUntil: iso, ...(routineId ? { routineId } : {}) };
}
