// Deferred agent self-wakeup. Session model: docs/concepts/sessions.md.
//
// The agent calls `defer` mid-turn with a delay, an absolute time, or an event
// to wait for, plus a note-to-self. We create a one-off routine that, when it
// fires, resumes the *same* session through `resume_session` — so the agent
// wakes in its own conversation with full context. A time wakeup is a dated
// schedule routine; an event wakeup is a `once` event-bus routine.
//
// This module shapes the `create_routine` args from the parsed input. The side
// effects (reading the live thread context, subscribing to the event's source,
// calling create_routine through the action engine) are injected by the
// caller (`agent-session.ts`) so this stays testable without a running engine.

import { parseDeferInput, type DeferInput } from "../agent/index.js";
import type { ThreadContext } from "../core/types.js";

/** The action the one-off routine fires: `resume_session` continues this
 * thread's conversation on any channel. It's a thin shim over the
 * main-process backend-turn orchestrator — defer needs only name the session to
 * resume; the orchestrator owns running the turn and delivering the reply. */
export const RESUME_SESSION_ACTION = "resume_session";

/** The thread the `defer` call is running in, captured from the live session. */
export interface DeferContext {
  agentName?: string;
  /** Exact runtime session to resume when the one-off routine fires. */
  sessionId: string;
  channelContext?: ThreadContext;
  /** Whose the thread's chat is, so the wake-up reaches that person even
   *  after the chat is gone. */
  ownerKey?: string;
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
    ...(context.ownerKey ? { ownerKey: context.ownerKey } : {}),
    ...prompt,
  };
}

/** Schedule the deferred wakeup. Throws (for the tool to relay as an error)
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
