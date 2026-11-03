import type { ActionEvent } from "@rome-os/app-runtime";
import type { AgentEvent } from "../types.js";
import { actionExecutionContext } from "./context.js";

export type StreamAgentEvent = AgentEvent & { agent?: string };

export interface AgentMessageRuntimeEvent {
  type: "agent_message";
  message: StreamAgentEvent;
}

export interface PublicActionRuntimeEvent {
  type: "action_event";
  event: ActionEvent;
  /** Private routing metadata. Removed before app-facing delivery. */
  sourceExecutionId: string;
}

export type ActionRuntimeEvent = AgentMessageRuntimeEvent | PublicActionRuntimeEvent;

export interface ActionRunObserver {
  onRuntimeEvent?: (event: ActionRuntimeEvent) => void;
}

/** Direct caller observer. Unlike ActionRunObserver, this is never inherited
 * by descendant Action executions. */
export interface ActionInvocationObserver {
  onActionEvent?: (event: ActionEvent) => void;
}

export function normalizeActionEvent(event: ActionEvent): ActionEvent {
  assertJsonValue(event, "$event", new Set<object>());
  const cloned = JSON.parse(JSON.stringify(event)) as unknown;
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new TypeError("Action event must be a plain JSON object");
  }
  const type = (cloned as { type?: unknown }).type;
  if (typeof type !== "string" || type.trim().length === 0) {
    throw new TypeError("Action event type must be a non-empty string");
  }
  return cloned as ActionEvent;
}

function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain a finite number`);
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON ${typeof value} value`);
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a circular reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, seen);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} contains symbol keys`);
    }
  }
  seen.delete(value);
}

export function emitAgentMessage(message: StreamAgentEvent): void {
  const observer = actionExecutionContext.getStore()?.runtimeObserver;
  observer?.onRuntimeEvent?.({
    type: "agent_message",
    message,
  });
}
