// Deferred agent self-wakeup. Session model: docs/concepts/sessions.md.
//
// The agent calls `defer` mid-turn with a delay, an absolute time, or an event
// to wait for, plus a note-to-self. We create a one-off routine that, when it
// fires, resumes the *same* session through `resume_session` — so the agent
// wakes in its own conversation with full context. A time wakeup is a dated
// schedule routine; an event wakeup is a `once` event-bus routine.
//
// This module shapes the `create_routine` args from the parsed wake-up. The side
// effects (reading the live thread context, subscribing to the event's source,
// calling create_routine through the action engine) are injected by the
// caller (`agent-session.ts`) so this stays testable without a running engine.

import type { WakeUp } from "../agent/index.js";
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
  /** The turn that called `defer`, so the woken turn can find its context. */
  turnId?: string;
  /** When `defer` was called. */
  scheduledAt: Date;
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
      /** When the wait ends without the event (ISO 8601), when it has a deadline. */
      deadline?: string;
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
  wakeUp: WakeUp,
): Record<string, unknown> {
  const channelContext = context.channelContext;
  return {
    sessionId: context.sessionId,
    // The task the check is for: its "later" time is read from here, and
    // stopping the task cancels it.
    ...(wakeUp.taskId ? { taskId: wakeUp.taskId } : {}),
    channel: channelContext?.channel,
    threadId: channelContext?.threadId,
    channelUserId: channelContext?.channelUserId,
    agentName: context.agentName ?? "main",
    ...(context.ownerKey ? { ownerKey: context.ownerKey } : {}),
    ...prompt,
  };
}

/**
 * The prompt the woken turn receives: what fired, then the agent's
 * note-to-self and where it was written, since the session that wakes may be
 * a newer one with none of that turn in its context.
 */
function wakePrompt(headline: string, wakeUp: WakeUp, context: DeferContext): string {
  const attrs = [
    `scheduled_at="${context.scheduledAt.toISOString()}"`,
    ...(context.turnId ? [`turn_id="${xmlAttr(context.turnId)}"`] : []),
    ...(wakeUp.taskId ? [`task_id="${xmlAttr(wakeUp.taskId)}"`] : []),
  ].join(" ");
  return `${headline}\n<defer_note ${attrs}>\n${wakeUp.note}\n</defer_note>`;
}

function xmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Schedule the deferred wakeup. Throws (for the tool to relay as an error)
 * on a missing thread context. */
export async function runDefer(parsed: WakeUp, deps: DeferDeps): Promise<DeferResult> {
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
      args: buildResumeArgs(
        deps.context,
        {
          text: wakePrompt(`📨 Event arrived: ${parsed.name}`, parsed, deps.context),
          attachEvent: true,
          // What the chat shows while it waits, and when the wait ends without
          // the event: the trigger wakes the session then with a payload that
          // says so (event-bus-trigger-provider.ts). Only an agent whose
          // policy asks for them gives them.
          ...(parsed.waitingFor ? { waitingFor: parsed.waitingFor } : {}),
          ...(parsed.deadlineMs !== undefined
            ? { deadline: new Date(parsed.deadlineMs).toISOString() }
            : {}),
        },
        parsed,
      ),
    });
    const routineId = (data as { routineId?: string } | null | undefined)?.routineId;
    return {
      ok: true,
      name: parsed.name,
      waitingFor: eventName,
      ...(parsed.deadlineMs !== undefined
        ? { deadline: new Date(parsed.deadlineMs).toISOString() }
        : {}),
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
    // The ⏰ prefix marks it in the thread, and the note says what to do.
    args: buildResumeArgs(
      deps.context,
      { text: wakePrompt(`⏰ Time's up: ${parsed.name}`, parsed, deps.context) },
      parsed,
    ),
  };

  const data = await deps.createRoutine(createArgs);
  const routineId = (data as { routineId?: string } | null | undefined)?.routineId;

  return { ok: true, name: parsed.name, deferredUntil: iso, ...(routineId ? { routineId } : {}) };
}
