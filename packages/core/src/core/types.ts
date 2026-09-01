import type { MessageReplyReference, ThreadContext } from "@rome-os/app-runtime";
import type { AgentConfig, AgentMessage } from "../types.js";

export type { ThreadContext } from "@rome-os/app-runtime";

export interface RunParams {
  agentName: string;
  prompt: string;
  /**
   * Absolute local paths of images to attach to the turn input. Providers
   * with image-input support (Codex) attach them to the user turn; providers
   * without it ignore them.
   */
  images?: string[];
  /** Shared action context forwarded into agent-triggered action executions. */
  sharedContext?: Record<string, unknown>;
  /** Used for session reuse lookup: `${channel}:${threadId}` */
  channelThreadKey?: string;
  /** Rich thread metadata forwarded into action execution context and prompt assembly. */
  threadContext?: ThreadContext;
  /** Stable Rome conversation to bind to the provider/runtime session. */
  romeSessionId?: string;
  /** Platform id of the inbound message that triggers this turn. */
  platformMessageId?: string;
  /** Platform message referenced by the current ordinary reply. */
  replyTo?: MessageReplyReference;
  /** Explicit session ID to continue */
  sessionId?: string;
  /** Variable content appended to the end of the system prompt */
  contextSuffix?: string;
  /** Working directory for the agent. Defaults to project root. */
  workingDir?: string;
  /** Internal continuations should not be treated as guardian-authored turns. */
  initiatedBy?: "user" | "system";
}

/**
 * How a forked run's session is configured relative to its source.
 *
 * - `"isolated"` (default) — the fork opens with an empty tool surface: no
 *   actions, skills, subagents, or builtin tools, and no interactive-surface
 *   tools. The fork can only read the inherited conversation and answer.
 *   Right for side-channel turns that must not act (e.g. recap summaries).
 * - `"exact"` — a direct fork: the session opens with the source session's
 *   exact configuration (system prompt, action/skill catalogs, builtin and
 *   subagent tools, MCP servers, output contract), so the model-visible
 *   prefix is identical to the source conversation. Tools remain callable;
 *   executions are attributed to the fork's own session and turn ids.
 */
export type ForkRunMode = "isolated" | "exact";

/** Provider-native history anchor for the source turn of a fork. */
export interface ForkSourceCheckpoint {
  providerId: string;
  providerThreadId: string;
  checkpointId: string;
}

export interface ForkRunParams {
  agentName: string;
  sourceSessionId: string;
  prompt: string;
  /** Optional capability tier override for the forked turn. */
  tier?: AgentConfig["tier"];
  channelThreadKey: string;
  threadContext?: ThreadContext;
  workingDir?: string;
  /**
   * Turn on the source session that triggered this fork. Recorded as lineage
   * on the fork's rome session so the trajectory links back to the exact turn.
   */
  parentTurnId?: string;
  /**
   * Provider-native checkpoint for `parentTurnId`. When present, the fork
   * must end its inherited transcript at this checkpoint rather than at the
   * source session's current head.
   */
  sourceCheckpoint?: ForkSourceCheckpoint;
  /**
   * Short name for the fork's purpose (e.g. "recap"). Recorded as the fork
   * session's trigger name and used in its display name.
   */
  label?: string;
  /** Tool-surface mode for the fork. Defaults to `"isolated"`. */
  mode?: ForkRunMode;
  /**
   * Builds the channel-thread key to leave the completed fork resumable under,
   * from the fork session id that `runForkedTurn` mints. When set, the fork
   * asks the provider for a thread of its own and persists it, so a later
   * `acquire` on this key continues the branch instead of opening a fresh
   * conversation. Absent — the default — keeps the fork one-shot and ephemeral.
   *
   * A function because the key derives from an id the caller does not have
   * until the run starts.
   */
  persistThreadKey?: (forkSessionId: string) => string;
}

/** Maps tier names to full model IDs (Anthropic provider defaults). */
export const MODEL_MAP: Record<AgentConfig["tier"], string> = {
  large: "claude-opus-4-8[1m]",
  medium: "claude-sonnet-5",
  small: "claude-haiku-4-5-20251001",
};

export interface AgentRunnerInterface {
  run(params: RunParams): AsyncIterable<AgentMessage>;
  runForked?(params: ForkRunParams): AsyncIterable<AgentMessage>;
}
