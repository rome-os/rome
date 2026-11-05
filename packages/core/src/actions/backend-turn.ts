// Backend-turn orchestrator. Session model: docs/concepts/sessions.md.
//
// "Run a turn in session X, then deliver the reply to X's channel" is the core
// shared by every conversation entry point. Inbound handlers wrap it with a
// trust pipeline (message_handler, the webchat HTTP route); system-initiated
// continuations (defer, approval resumption, timers) call it directly — trust
// was settled when the session began, so there is nothing to re-triage.
//
// This is the single main-process owner of that core for *system* turns. It
// keeps the one unavoidable per-channel difference — how a reply is delivered —
// in exactly one place:
//   - webchat: run inside `enqueueSessionTask` so the turn queues behind any
//     in-flight browser turn and shows live on the session's stream. That
//     stream is main-process-only, which is why this lives here and the worker
//     reaches it over one RPC. The reply still goes out on the channel's `send`
//     port, which pushes it to open chats.
//   - other channels: run the turn, then hand the reply to the channel's `send`
//     port (chats/connected-accounts/connected-account.ts).
//
// The AgentSession stays channel-agnostic: it produces the turn; this
// orchestrator, sitting above it, owns delivery — exactly as message_handler and
// the webchat route do for inbound turns.

import type { BackendTurnParams, BackendTurnRunner, ChatId } from "@rome-os/app-runtime";
import type { Channel } from "../chats/connected-accounts/connected-account.js";
import type { SpeakerReplies } from "../sessions/speaker-replies.js";
import type { AgentRunnerInterface, RunParams, ThreadContext } from "../core/types.js";
import type { AgentEvent } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("backend-turn");

/**
 * Minimal structural view of `WebchatRuntime` this orchestrator needs.
 * Declared here (not imported from the API layer) so the actions package does
 * not depend on the API layer — same pattern as `ApprovalSessionStreamHost`.
 */
export interface WebchatSessionStreamHost {
  enqueueSessionTask(
    sessionId: string,
    task: BackendSessionTask,
    options?: BackendTurnOptions,
  ): Promise<void>;
}

export interface BackendTurnOptions {
  /** The turn is housekeeping for the agent: a chat that draws a typing
   *  indicator for a running turn holds it back until the agent speaks. */
  quiet?: boolean;
  /** Keeps the turn's input in its saved trace under this label. */
  inputLabel?: string;
}

export interface BackendEmitOptions {
  /** The task already saved this event's trace and delivers its turn's reply
   * itself, so the session stream only shows the event live and mounts its
   * cards. */
  recorded?: boolean;
}

/** A backend session task: code that runs inside a session's stream context and
 * may emit agent messages (rendered as live trace + captured for delivery).
 * `emit` settles once the cards the event carries are written, so a task that
 * awaits it can deliver its reply after them. */
export type BackendSessionTask = (helpers: {
  emit: (msg: AgentEvent & { agent?: string }, options?: BackendEmitOptions) => Promise<void>;
}) => Promise<void>;

/** The main-process runner. Beyond the worker-facing `runAndDeliver`, it owns
 * the webchat runtime (one holder for all backend turns — defer, approvals,
 * timers) and exposes the lower-level `runBackendSessionTask` for callers that
 * need to run more than a plain turn in the session (e.g. the approval handler,
 * which prepends the approved action's trace before the continuation). */
/** Whether a backend turn ran to its end: `failed` when it errored, was
 *  interrupted, or never ran. */
export type BackendTurnOutcome = "completed" | "failed";

export interface MainBackendTurnRunner extends BackendTurnRunner {
  runAndDeliver(params: BackendTurnParams, options?: BackendTurnOptions): Promise<void>;
  /** `runAndDeliver`, answering whether the turn ran to its end. */
  runAndReport(
    params: BackendTurnParams,
    options?: BackendTurnOptions,
  ): Promise<BackendTurnOutcome>;
  setWebchatRuntime(runtime: WebchatSessionStreamHost): void;
  /** Run `task` in the session for (channel, threadId). For webchat it queues
   * behind any in-flight browser turn and its emitted reply rides the SSE push;
   * for other channels (or when no webchat runtime is wired) it runs the task
   * with a no-op emit — delivery, if any, is the task's own responsibility. */
  runBackendSessionTask(
    channel: string,
    threadId: string,
    task: BackendSessionTask,
    options?: BackendTurnOptions,
  ): Promise<void>;
  /** Says a messaging channel's reply through the session's speaker, which
   * sends it and records it in the chat, as `runAndDeliver` does for a turn it
   * ran itself. For a task run through `runBackendSessionTask` on a channel
   * other than webchat, whose own work produced the reply. Sends nothing for
   * an empty reply or an agent whose text is private. Throws, having sent
   * nothing, when no speaker can say the reply or the session stands in no
   * chat. */
  deliverMessagingReply(
    params: Pick<BackendTurnParams, "agentName" | "channel" | "threadId">,
    reply: string,
    turnId?: string,
  ): Promise<void>;
}

export interface BackendTurnRunnerDeps {
  agentRunner: AgentRunnerInterface;
  /** The channel a reply is delivered on, by name, or null when there is none.
   *  Its send port must be the platform's own, not one that records its
   *  sends: the speaker records the reply. */
  channel: (name: string) => Channel | null;
  /** Resolve the working dir for the continued session from its (channel,
   * thread), so the resumed turn runs in the SAME project the conversation
   * started in — the SDK transcript is stored per cwd, so a wrong dir makes the
   * resume fail with "No conversation found". Returns undefined when there is no
   * project to honor (non-webchat channels, unknown threads); the session then
   * falls back to the default working dir. */
  resolveWorkingDir?: (channel: string, threadId: string) => Promise<string | undefined>;
  /** Resolve the device folder the continued chat works in, so a continuation
   * keeps the `<device_folder>` block its chat's turns carry. */
  resolveDeviceFolder?: (
    channel: string,
    threadId: string,
  ) => Promise<ThreadContext["deviceFolder"] | undefined>;
  /** Opens the chat a delivered reply is recorded in, and the session whose
   *  speaker says it. Absent, a messaging continuation's reply is refused. */
  chats?: {
    ensureChannelChat(input: {
      channel: string;
      threadId: string;
      agentName: string;
    }): Promise<{ id: string }>;
  };
  /** Says a reply through the speaker of the agent's session at the reply's
   *  address, which sends it through its account's chat adapter and records
   *  it in Chats as the turn's answer. Absent, a messaging continuation's
   *  reply is refused, since nothing could record it. */
  replies?: Pick<SpeakerReplies, "send">;
  /** Runs when a webchat continuation starts, after it has waited its turn in
   * the queue, so it resolves its model from the chat's current selection. */
  beforeTurn?: (params: BackendTurnParams) => Promise<unknown>;
  /** Whether the agent's session policy keeps its text private, so its turn
   * delivers no reply. Absent ⇒ every agent's reply is delivered. */
  isTextPrivate?: (agentName: string) => boolean;
}

export function createBackendTurnRunner(deps: BackendTurnRunnerDeps): MainBackendTurnRunner {
  let webchatRuntime: WebchatSessionStreamHost | undefined;

  const runTurn = (
    params: BackendTurnParams,
    workingDir: string | undefined,
    trace: Pick<RunParams, "chatAnswer" | "inputLabel"> = {},
    deviceFolder?: ThreadContext["deviceFolder"],
  ): AsyncIterable<AgentEvent> => {
    return deps.agentRunner.run({
      ...trace,
      agentName: params.agentName,
      prompt: params.prompt,
      // Resume the exact runtime/provider conversation that scheduled the
      // continuation. The session row owns its canonical channelThreadKey;
      // channel/thread coordinates below only own reply delivery.
      sessionId: params.sessionId,
      // Resume in the session's own project dir (the SDK transcript is stored per
      // cwd). Undefined leaves the session's default-dir fallback intact.
      workingDir,
      threadContext: {
        channel: params.channel,
        threadId: params.threadId,
        channelUserId: params.channelUserId,
        ...(deviceFolder ? { deviceFolder } : {}),
      },
      // A continuation is not a guardian-authored turn — mark it system so the
      // turn-level logic treats it as an internal re-entry, not a fresh message.
      initiatedBy: "system",
    });
  };

  const runBackendSessionTask = async (
    channel: string,
    threadId: string,
    task: BackendSessionTask,
    options?: BackendTurnOptions,
  ): Promise<void> => {
    if (channel === "webchat" && webchatRuntime) {
      // Queue behind any in-flight browser turn; the runtime captures the task's
      // emitted reply and pushes it over the session's SSE stream.
      await webchatRuntime.enqueueSessionTask(threadId, task, options);
      return;
    }
    if (channel === "webchat") {
      log.warn("no webchat runtime wired; backend turn runs without SSE delivery", { threadId });
    }
    // No webchat stream to attach to (messaging, or runtime not yet wired): run
    // the task with a no-op emit. Reply delivery, if any, is the task's job.
    await task({ emit: async () => {} });
  };

  const assertSpeaker = (channel: string) => {
    const { replies, chats } = deps;
    if (!replies || !chats) {
      throw new Error(`No speaker can say a reply on "${channel}", so it was not sent`);
    }
    return { replies, chats };
  };

  const deliverMessagingReply = async (
    params: Pick<BackendTurnParams, "agentName" | "channel" | "threadId">,
    reply: string,
    turnId?: string,
  ): Promise<void> => {
    if (!reply.trim() || deps.isTextPrivate?.(params.agentName)) {
      log.info("backend turn produced no reply; nothing to deliver", {
        channel: params.channel,
        threadId: params.threadId,
      });
      return;
    }
    const channel = deps.channel(params.channel);
    const send = channel?.send;
    if (!channel || !send) throw new Error(`Channel "${params.channel}" cannot send`);
    const { replies, chats } = assertSpeaker(params.channel);
    // A delivery that succeeded and failed to record is logged, never
    // thrown, so the continuation never retries a sent reply.
    const session = await chats.ensureChannelChat({
      channel: params.channel,
      threadId: params.threadId,
      agentName: params.agentName,
    });
    const said = await replies.send(
      session.id,
      channel,
      { text: reply },
      { ...(turnId ? { turnId } : {}), agent: params.agentName },
    );
    if (said) return;
    // The session stands in no chat, so nothing could record the reply
    // where it is read back: nothing is sent.
    throw new Error(
      `Session ${session.id} stands in no chat, so its reply${turnId ? ` to turn ${turnId}` : ""} was not sent`,
    );
  };

  return {
    setWebchatRuntime(runtime: WebchatSessionStreamHost): void {
      webchatRuntime = runtime;
    },

    runBackendSessionTask,

    async runAndDeliver(params: BackendTurnParams, options?: BackendTurnOptions): Promise<void> {
      await runAndReport(params, options);
    },

    runAndReport,

    deliverMessagingReply,
  };

  async function runAndReport(
    params: BackendTurnParams,
    options?: BackendTurnOptions,
  ): Promise<BackendTurnOutcome> {
    let outcome: BackendTurnOutcome = "failed";
    // Resolve the continued session's project dir up front so the resumed turn
    // runs where its SDK transcript lives (defer/timer fire on a fresh stack
    // that never carried it). Undefined ⇒ keep the default-dir fallback.
    const [workingDir, deviceFolder] = await Promise.all([
      deps.resolveWorkingDir?.(params.channel, params.threadId),
      deps.resolveDeviceFolder?.(params.channel, params.threadId),
    ]);

    if (params.channel === "webchat") {
      // The turn queues behind any in-flight browser turn and shows live on
      // the session's stream, but like any channel's turn it saves its own
      // trace and sends its reply on the channel's `send` port. The chat
      // keeps its transcript itself, so the runner writes no transcript rows.
      const send = deps.channel(params.channel)?.send;
      if (!send) throw new Error(`Channel "${params.channel}" cannot send`);
      await runBackendSessionTask(
        params.channel,
        params.threadId,
        async ({ emit }) => {
          await deps.beforeTurn?.(params);
          let reply = "";
          let turnId: string | undefined;
          // The dashboard chat writes its own copy of the answer.
          const trace = {
            ...(options?.inputLabel ? { inputLabel: options.inputLabel } : {}),
          };
          for await (const msg of runTurn(params, workingDir, trace, deviceFolder)) {
            if (msg.type === "turn_start") turnId = msg.turnId;
            if (msg.type === "result") reply = msg.content;
            if (msg.type === "turn_end" && msg.status === "completed") outcome = "completed";
            await emit({ ...msg, agent: params.agentName }, { recorded: true });
          }
          if (!reply.trim() || deps.isTextPrivate?.(params.agentName)) return;
          await send.send(params.threadId as ChatId, {
            text: reply,
            ...(turnId ? { turnId } : {}),
          });
        },
        options,
      );
      return outcome;
    }

    // Messaging channels: run the turn here in main, then say the reply
    // through the session's speaker. Without one the reply could not be
    // sent, so the turn is not run.
    assertSpeaker(params.channel);
    let reply = "";
    let turnId: string | undefined;
    // A speaker puts the answer on record in the chat as it says it, so the
    // run writes none there: one that was never sent must not read as said,
    // and one that was must not be said twice.
    const trace = {
      chatAnswer: false,
      ...(options?.inputLabel ? { inputLabel: options.inputLabel } : {}),
    };
    for await (const msg of runTurn(params, workingDir, trace, deviceFolder)) {
      if (msg.type === "turn_start") turnId = msg.turnId;
      if (msg.type === "result") reply = msg.content;
      if (msg.type === "turn_end" && msg.status === "completed") outcome = "completed";
    }
    await deliverMessagingReply(params, reply, turnId);
    return outcome;
  }
}
