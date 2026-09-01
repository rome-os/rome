import type { TraceBlockDto } from "@rome/api-types/trace-segments";
import type { AgentMessage } from "../types.js";
import type { ActionResult } from "../actions/types.js";
import type { ConnectionRegistry } from "../connections/index.js";
import type { WebhookInvocationRecord } from "../db/repositories/webhook-invocations.js";
import type { ApiDeps } from "./deps.js";
import { isValidAppId } from "../apps/packaging/app-id.js";

/** Connections and channels are owned by the ConnectionRegistry. The
 *  daemon always injects `connectionRegistry`; a missing one is a wiring bug,
 *  surfaced loudly rather than silently no-op'd. */
export function requireConnectionRegistry(deps: ApiDeps): ConnectionRegistry {
  if (!deps.connectionRegistry) {
    throw new Error("connectionRegistry is not wired");
  }
  return deps.connectionRegistry;
}

/** Conferral setups. The daemon injects `setupManager` alongside
 *  the registry; a missing one on the generic setup routes is a wiring bug. */
export function requireSetupManager(
  deps: ApiDeps,
): import("../connections/setup/manager.js").SetupManager {
  if (!deps.setupManager) {
    throw new Error("setupManager is not wired");
  }
  return deps.setupManager;
}

export class InvalidAppApiPathError extends Error {}

export function decodeAppApiPathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new InvalidAppApiPathError(`Invalid app API route segment "${segment}"`);
  }

  if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
    throw new InvalidAppApiPathError(`Invalid app API route segment "${segment}"`);
  }

  return decoded;
}

/** Decode one route segment that must contain a complete canonical app id. */
export function decodeAppIdPathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new InvalidAppApiPathError(`Invalid app id route segment "${segment}"`);
  }

  if (!isValidAppId(decoded)) {
    throw new InvalidAppApiPathError(`Invalid app id route segment "${segment}"`);
  }
  return decoded;
}

export function decodeAppApiPath(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeAppApiPathSegment(segment));
}

export function toWebhookInvocationStatus(
  result: ActionResult,
): "pending_approval" | "success" | "error" {
  if (result.status === "pending_approval") return "pending_approval";
  return result.status === "error" ? "error" : "success";
}

export function toWebhookInvocationResponse(invocation: WebhookInvocationRecord) {
  return {
    executionId: invocation.executionId,
    actionName: invocation.actionName,
    status: invocation.status,
    result: invocation.result,
    error: invocation.error,
    pollUrl: `/webhooks/executions/${invocation.executionId}`,
    createdAt: invocation.createdAt.toISOString(),
    updatedAt: invocation.updatedAt.toISOString(),
    finishedAt: invocation.finishedAt?.toISOString() ?? null,
    callback: {
      requested: invocation.callbackStatus !== "not_requested",
      status: invocation.callbackStatus,
      attemptedAt: invocation.callbackAttemptedAt?.toISOString() ?? null,
      deliveredAt: invocation.callbackDeliveredAt?.toISOString() ?? null,
      responseStatus: invocation.callbackResponseStatus,
      error: invocation.callbackError,
    },
  };
}

export function toWebchatSessionResponse(
  session: {
    id: string;
    name: string;
    personaId: string | null;
    largeModelSelection?: string | null;
    projectName: string;
    projectPath?: string | null;
    agentName?: string | null;
    archivedAt?: Date | null;
    pinnedAt?: Date | null;
    createdAt: Date;
    activityAt: Date | number;
    lastSeenActivityAt?: Date | null;
    unread?: boolean;
  },
  messageCount: number,
) {
  const activityAt = timestampToIso(session.activityAt);
  const lastSeenActivityAt = session.lastSeenActivityAt
    ? timestampToIso(session.lastSeenActivityAt)
    : null;
  return {
    id: session.id,
    name: session.name,
    personaId: session.personaId ?? null,
    largeModelSelection: session.largeModelSelection ?? null,
    projectName: session.projectName,
    projectPath: session.projectPath ?? session.projectName,
    agentName: session.agentName ?? null,
    archivedAt: session.archivedAt ? session.archivedAt.toISOString() : null,
    pinnedAt: session.pinnedAt ? session.pinnedAt.toISOString() : null,
    createdAt: session.createdAt.toISOString(),
    activityAt,
    lastSeenActivityAt,
    unread:
      session.unread ??
      (session.lastSeenActivityAt != null &&
        timestampToMillis(session.activityAt) > timestampToMillis(session.lastSeenActivityAt)),
    messageCount,
  };
}

function timestampToMillis(value: Date | number): number {
  if (value instanceof Date) return value.getTime();
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function timestampToIso(value: Date | number): string {
  return new Date(timestampToMillis(value)).toISOString();
}

/**
 * AgentMessage variants that have a trace-block representation. `text_delta`
 * is excluded at the type level: it is a transient streaming preview that is
 * never persisted, so callers must filter deltas out before reaching here —
 * the compiler enforces it instead of a runtime throw.
 */
export type TraceableAgentMessage = Exclude<AgentMessage, { type: "text_delta" | "input_status" }>;

export function toTraceBlock(msg: TraceableAgentMessage & { agent?: string }): TraceBlockDto {
  switch (msg.type) {
    case "session_init":
      return {
        type: "session_init",
        sessionId: msg.sessionId,
        romeSession: msg.romeSession,
        systemPrompt: msg.systemPrompt,
        userPrompt: msg.userPrompt,
        projectPath: msg.projectPath,
        agent: msg.agent,
      };
    case "turn_start":
      return {
        type: "turn_start",
        turnId: msg.turnId,
        sessionId: msg.sessionId,
        userPrompt: msg.userPrompt,
        agent: msg.agent,
      };
    case "turn_end":
      return {
        type: "turn_end",
        turnId: msg.turnId,
        status: msg.status,
        durationMs: msg.durationMs,
        agent: msg.agent,
      };
    case "text":
      return {
        type: "text",
        content: msg.content,
        agent: msg.agent,
        ...(msg.turnPhase ? { turnPhase: msg.turnPhase } : {}),
      };
    case "thinking":
      return { type: "thinking", content: msg.content, agent: msg.agent };
    case "tool_use":
      return {
        type: "tool_use",
        tool: msg.tool,
        input: msg.input,
        agent: msg.agent,
        ...(msg.id ? { id: msg.id } : {}),
        ...(msg.startedAt ? { startedAt: msg.startedAt } : {}),
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool: msg.tool,
        output: msg.output,
        agent: msg.agent,
        ...(msg.toolUseId ? { toolUseId: msg.toolUseId } : {}),
        ...(msg.endedAt ? { endedAt: msg.endedAt } : {}),
      };
    case "subagent_start":
      return {
        type: "subagent_start",
        toolUseId: msg.toolUseId,
        agentName: msg.agentName,
        input: msg.input,
        sessionId: msg.sessionId,
        turnId: msg.turnId,
        agent: msg.agent,
        ...(msg.startedAt ? { startedAt: msg.startedAt } : {}),
      };
    case "subagent_result":
      return msg.status === "completed"
        ? {
            type: "subagent_result",
            toolUseId: msg.toolUseId,
            agentName: msg.agentName,
            sessionId: msg.sessionId,
            turnId: msg.turnId,
            status: msg.status,
            output: msg.output,
            agent: msg.agent,
            ...(msg.endedAt ? { endedAt: msg.endedAt } : {}),
          }
        : {
            type: "subagent_result",
            toolUseId: msg.toolUseId,
            agentName: msg.agentName,
            sessionId: msg.sessionId,
            turnId: msg.turnId,
            status: msg.status,
            error: msg.error,
            agent: msg.agent,
            ...(msg.endedAt ? { endedAt: msg.endedAt } : {}),
          };
    case "result":
      return {
        type: "result",
        content: msg.content,
        structuredOutput: msg.structuredOutput,
        accounting: msg.accounting,
        agent: msg.agent,
      };
    case "error":
      return {
        type: "error",
        error: msg.error,
        accounting: msg.accounting,
        agent: msg.agent,
        code: msg.code,
        provider: msg.provider,
        reason: msg.reason,
      };
    case "structured_output":
      return {
        type: "structured_output",
        payload: msg.payload,
        agent: msg.agent,
      };
    case "plan_update":
      return {
        type: "plan_update",
        plan: msg.plan,
        agent: msg.agent,
      };
    default: {
      const exhaustiveCheck: never = msg;
      throw new Error(`Unsupported trace block: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function parseWebhookRequestBody(body: string): {
  args: Record<string, unknown>;
  callbackUrl?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Webhook body must be a JSON object");
  }

  const args = "args" in parsed ? (parsed as { args?: unknown }).args : undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("args must be an object");
  }

  const rawCallbackUrl = (parsed as { callbackUrl?: unknown }).callbackUrl;
  if (rawCallbackUrl === undefined) {
    return { args: args as Record<string, unknown> };
  }
  if (typeof rawCallbackUrl !== "string") {
    throw new Error("callbackUrl must be a string");
  }

  const callbackUrl = rawCallbackUrl.trim();
  if (!callbackUrl) {
    throw new Error("callbackUrl must be a non-empty string");
  }

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error("callbackUrl must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("callbackUrl must use http or https");
  }

  return { args: args as Record<string, unknown>, callbackUrl };
}
