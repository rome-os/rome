// A subagent: an agent that another agent's turn hands work to, and a subagent
// call: one call a turn makes to it (docs/domains/agents.md#subagent).

import { createHash } from "node:crypto";
import { isCoreMainAgentId, type StreamAgentEvent } from "@rome-os/app-runtime";
import type { ModelToolCallContext } from "./rome-tools.js";
import type { AgentName, SessionId } from "./session.js";

/** The id of a session's dashboard record (`rome_sessions.id`). For a
 *  subagent's session it equals the agent session's id. For a dashboard
 *  chat's own session it does not. Like `SessionId`, the alias names the id
 *  for the reader, and the compiler does not tell the two apart. */
export type SessionRecordId = string;

/** A subagent this agent may hand work to. */
export interface Subagent {
  /** The subagent's canonical agent id, e.g. `core:helper`. */
  name: AgentName;
  description: string;
}

/** The subagents this agent may hand work to. */
export interface Subagents {
  list(): readonly Subagent[];
  /** Runs a subagent call as a child of the calling turn and waits for how it
   *  ended. */
  run(name: AgentName, input: unknown, call: ModelToolCallContext): Promise<unknown>;
}

/** What the model asked the subagent for. */
export interface SubagentRequest {
  prompt: string;
  /** The subagent session to continue. Omitted, the call opens a fresh one. */
  resumeSessionId?: SessionId;
}

/** How a subagent call ended. */
export type SubagentOutcome =
  | { status: "completed"; output: unknown }
  | { status: "failed" | "cancelled"; error: { message: string; code?: string } };

/** Reads the request out of a subagent tool's input. Throws on a missing or
 *  empty prompt. */
export function subagentRequest(input: unknown): SubagentRequest {
  const fields = (input ?? {}) as { prompt?: unknown; resumeSessionId?: unknown };
  if (!fields.prompt || typeof fields.prompt !== "string") {
    throw new Error("execute_subagent requires a non-empty prompt");
  }
  return {
    prompt: fields.prompt,
    ...(fields.resumeSessionId ? { resumeSessionId: fields.resumeSessionId as SessionId } : {}),
  };
}

/** A stored session's dashboard record, as a resume reads it. */
export interface StoredSubagentSession {
  type: string;
  /** Null for the core main agent, which reads as `main`. */
  agentName: AgentName | null;
  parentSessionId: SessionRecordId | null;
  projectPath: string | null;
}

/**
 * Why a resume may not continue the stored session, or null when it may. A
 * resume continues only a subagent session that the same parent record
 * started, for the same subagent, in the parent's project.
 */
export function refuseResume(
  stored: StoredSubagentSession | null,
  parent: { projectPath: string | null } | null,
  call: { subagent: AgentName; parentRecordId: SessionRecordId; resumeSessionId: SessionId },
): string | null {
  if (!parent) return `Parent Rome session "${call.parentRecordId}" was not found`;
  if (!stored || stored.type !== "subagent") {
    return `Subagent session "${call.resumeSessionId}" was not found`;
  }
  const storedAgentName = stored.agentName ?? "main";
  if (storedAgentName !== call.subagent) {
    return `Subagent session "${call.resumeSessionId}" belongs to agent "${storedAgentName}", not "${call.subagent}"`;
  }
  if (stored.parentSessionId !== call.parentRecordId) {
    return `Subagent session "${call.resumeSessionId}" belongs to a different Parent session`;
  }
  if ((stored.projectPath ?? null) !== (parent.projectPath ?? null)) {
    return `Subagent session "${call.resumeSessionId}" belongs to a different project`;
  }
  return null;
}

/** The name a fresh subagent session's record carries: the subagent, then the
 *  parent record's name, or the parent's agent when the record has none. */
export function subagentSessionName(
  subagent: AgentName,
  parentName: string | null | undefined,
  parentAgent: AgentName,
): string {
  return `${subagent}: ${parentName ?? parentAgent}`;
}

/** The agent name a subagent session's record stores: null for the core main
 *  agent. */
export function storedAgentName(subagent: AgentName): AgentName | null {
  return isCoreMainAgentId(subagent) ? null : subagent;
}

/** Folds a subagent's turn events, one at a time, into how the call ended. */
export class SubagentOutcomeReader {
  private resultText = "";
  private structuredOutput: unknown;
  private hasStructuredOutput = false;
  private terminalError: Extract<StreamAgentEvent, { type: "error" }> | undefined;
  private cancelled = false;

  read(event: StreamAgentEvent): void {
    if (event.type === "result") {
      this.resultText = event.content;
      if (Object.prototype.hasOwnProperty.call(event, "structuredOutput")) {
        this.structuredOutput = event.structuredOutput;
        this.hasStructuredOutput = true;
      }
    }
    if (event.type === "error") this.terminalError = event;
    if (event.type === "turn_end" && event.status === "interrupted") this.cancelled = true;
  }

  /** Cancelled if the turn ended interrupted, failed on an error event,
   *  otherwise completed with its structured output when it has one and its
   *  result text when not. */
  outcome(): SubagentOutcome {
    if (this.cancelled) {
      return {
        status: "cancelled",
        error: { message: this.terminalError?.error ?? "Subagent execution was cancelled" },
      };
    }
    if (this.terminalError) {
      return {
        status: "failed",
        error: {
          message: this.terminalError.error,
          ...(this.terminalError.code ? { code: this.terminalError.code } : {}),
        },
      };
    }
    return {
      status: "completed",
      output: this.hasStructuredOutput ? this.structuredOutput : this.resultText,
    };
  }
}

/**
 * The model-facing tool name for delegating to a subagent. Provider tool names
 * reject the ":" in an agent id, so the id maps to a stable hash.
 */
export function subagentToolName(subagentName: AgentName): string {
  return `sa_${createHash("sha256").update(subagentName).digest("hex").slice(0, 16)}`;
}
