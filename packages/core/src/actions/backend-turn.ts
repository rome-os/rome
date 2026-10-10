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
//     in-flight browser turn and the reply rides the session's SSE push
//     (`addBackendReplyMessage`). That push path is main-process-only, which is
//     why this lives here and the worker reaches it over one RPC.
//   - other channels: run the turn, then hand the reply to the channel's `send`
//     port (channels/channel.ts).
//
// The AgentSession stays channel-agnostic: it produces the turn; this
// orchestrator, sitting above it, owns delivery — exactly as message_handler and
// the webchat route do for inbound turns.

import type {
  BackendTurnParams,
  BackendTurnRunner,
  ConversationId,
  ConversationRepository,
} from "@rome-os/app-runtime";
import type { Channel } from "../channels/channel.js";
import type { AgentRunnerInterface } from "../core/types.js";
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
    task: (helpers: { emit: (msg: AgentEvent & { agent?: string }) => void }) => Promise<void>,
  ): Promise<void>;
}

/** A backend session task: code that runs inside a session's stream context and
 * may emit agent messages (rendered as live trace + captured for delivery). */
export type BackendSessionTask = (helpers: {
  emit: (msg: AgentEvent & { agent?: string }) => void;
}) => Promise<void>;

/** The main-process runner. Beyond the worker-facing `runAndDeliver`, it owns
 * the webchat runtime (one holder for all backend turns — defer, approvals,
 * timers) and exposes the lower-level `runBackendSessionTask` for callers that
 * need to run more than a plain turn in the session (e.g. the approval handler,
 * which prepends the approved action's trace before the continuation). */
export interface MainBackendTurnRunner extends BackendTurnRunner {
  setWebchatRuntime(runtime: WebchatSessionStreamHost): void;
  /** Run `task` in the session for (channel, threadId). For webchat it queues
   * behind any in-flight browser turn and its emitted reply rides the SSE push;
   * for other channels (or when no webchat runtime is wired) it runs the task
   * with a no-op emit — delivery, if any, is the task's own responsibility. */
  runBackendSessionTask(channel: string, threadId: string, task: BackendSessionTask): Promise<void>;
}

export interface BackendTurnRunnerDeps {
  agentRunner: AgentRunnerInterface;
  /** The channel a reply is delivered on, by name, or null when there is none. */
  channel: (name: string) => Channel | null;
  /** Resolve the working dir for the continued session from its (channel,
   * thread), so the resumed turn runs in the SAME project the conversation
   * started in — the SDK transcript is stored per cwd, so a wrong dir makes the
   * resume fail with "No conversation found". Returns undefined when there is no
   * project to honor (non-webchat channels, unknown threads); the session then
   * falls back to the default working dir. */
  resolveWorkingDir?: (channel: string, threadId: string) => Promise<string | undefined>;
  /** The conversation (channel, thread) names, so the continued turn's trace
   * lands on it. Null when the address has no conversation yet. */
  resolveConversationId?: (channel: string, threadId: string) => Promise<string | null>;
  /** Durable conversation projection used to attach provider delivery ids. */
  conversations?: ConversationRepository;
}

export function createBackendTurnRunner(deps: BackendTurnRunnerDeps): MainBackendTurnRunner {
  let webchatRuntime: WebchatSessionStreamHost | undefined;

  const runTurn = (
    params: BackendTurnParams,
    workingDir: string | undefined,
    conversationId: string | null | undefined,
  ): AsyncIterable<AgentEvent> => {
    return deps.agentRunner.run({
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
        ...(conversationId ? { romeSessionId: conversationId } : {}),
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
  ): Promise<void> => {
    if (channel === "webchat" && webchatRuntime) {
      // Queue behind any in-flight browser turn; the runtime captures the task's
      // emitted reply and pushes it over the session's SSE stream.
      await webchatRuntime.enqueueSessionTask(threadId, task);
      return;
    }
    if (channel === "webchat") {
      log.warn("no webchat runtime wired; backend turn runs without SSE delivery", { threadId });
    }
    // No webchat stream to attach to (messaging, or runtime not yet wired): run
    // the task with a no-op emit. Reply delivery, if any, is the task's job.
    await task({ emit: () => {} });
  };

  return {
    setWebchatRuntime(runtime: WebchatSessionStreamHost): void {
      webchatRuntime = runtime;
    },

    runBackendSessionTask,

    async runAndDeliver(params: BackendTurnParams): Promise<void> {
      // Resolve the continued session's project dir up front so the resumed turn
      // runs where its SDK transcript lives (defer/timer fire on a fresh stack
      // that never carried it). Undefined ⇒ keep the default-dir fallback.
      const workingDir = await deps.resolveWorkingDir?.(params.channel, params.threadId);
      const conversationId = await deps.resolveConversationId?.(params.channel, params.threadId);

      if (params.channel === "webchat") {
        // Webchat delivery rides the session's SSE push inside the session task.
        await runBackendSessionTask(params.channel, params.threadId, async ({ emit }) => {
          for await (const msg of runTurn(params, workingDir, conversationId)) {
            emit({ ...msg, agent: params.agentName });
          }
        });
        return;
      }

      // Messaging channels: run the turn here in main, then deliver the reply
      // on the channel's `send` port.
      let reply = "";
      let turnId: string | undefined;
      for await (const msg of runTurn(params, workingDir, conversationId)) {
        if (msg.type === "turn_start") turnId = msg.turnId;
        if (msg.type === "result") reply = msg.content;
      }
      if (!reply.trim()) {
        log.info("backend turn produced no reply; nothing to deliver", {
          channel: params.channel,
          threadId: params.threadId,
        });
        return;
      }
      const send = deps.channel(params.channel)?.send;
      if (!send) throw new Error(`Channel "${params.channel}" cannot send`);
      const delivery = await send.send(params.threadId as ConversationId, {
        text: reply,
        ...(turnId ? { turnId } : {}),
      });
      if (deps.conversations) {
        try {
          const conversation = await deps.conversations.ensureChannelConversation({
            channel: params.channel,
            threadId: params.threadId,
            agentName: params.agentName,
          });
          await deps.conversations.recordOutboundMessage({
            sessionId: conversation.id,
            content: JSON.stringify([{ type: "text", content: reply }]),
            platformMessageId: delivery?.messageId,
            senderId: "rome",
            senderName: "Rome",
            ...(turnId ? { turnId } : {}),
            knownToProvider: true,
          });
        } catch (err) {
          // Delivery already succeeded. A persistence failure must not make the
          // continuation retry and send the same provider message twice.
          log.warn("backend reply delivered but conversation recording failed", {
            channel: params.channel,
            threadId: params.threadId,
            messageId: delivery?.messageId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}
