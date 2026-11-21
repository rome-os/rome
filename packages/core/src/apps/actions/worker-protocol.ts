import { isSendRefused, SendRefused, type SendRefusedReason } from "@rome-os/app-runtime";
import type { ActionRunContext } from "./engine.js";
import type { ActionRuntimeEvent } from "./runtime-events.js";
import type { ActionResult } from "./types.js";

export interface ActionWorkerPayload {
  actionName: string;
  args: Record<string, unknown>;
  context: ActionRunContext;
  /**
   * W3C Trace Context carrier (typically `{ traceparent, tracestate? }`)
   * serialized via `propagation.inject` from the parent's active span.
   * The worker calls `propagation.extract` and runs the action body under
   * the resulting context so its `agent:*` / `model.turn` spans nest under
   * the parent `action:*` span instead of starting a new disconnected trace.
   */
  traceCarrier?: Record<string, string>;
  /**
   * Epoch-ms the parent stamped immediately before `child.send()`. The worker
   * subtracts it from its own clock on entry to record `rome.action.worker.startup`
   * (the fork → body cold-start, dominated by Node/tsx module eval). Optional so
   * an older parent still runs; the worker no-ops the timing when absent.
   */
  forkStartedAt?: number;
}

export interface ActionWorkerReady {
  type: "ready";
}

export interface ActionWorkerShutdown {
  type: "shutdown";
}

export interface ActionWorkerSuccess {
  type: "result";
  result: ActionResult;
}

export interface ActionWorkerFailure {
  type: "error";
  /**
   * Serialized form of the error thrown in the worker. `name` and `message`
   * are carried separately so the parent can reconstruct an `Error` whose
   * identity matches what an in-process caller would have seen — IPC cannot
   * ship the instance itself.
   */
  error: WireError;
}

/** An error as it crosses the worker boundary. `refusal` is the reason of a
 *  refused send, so the caller can tell it from any other failure. */
export interface WireError {
  name: string;
  message: string;
  refusal?: SendRefusedReason;
}

/** `err` as it crosses the worker boundary. */
export function toWireError(err: unknown): WireError {
  if (!(err instanceof Error)) return { name: "Error", message: String(err) };
  const refusal = sendRefusalOf(err);
  return {
    name: err.name,
    message: err.message,
    ...(refusal ? { refusal } : {}),
  };
}

/** Why a send `err` fails on was refused: a {@link SendRefused}'s reason, or
 *  the refusal an action called from this one failed on, which it let pass
 *  up. Undefined for any other failure. */
export function sendRefusalOf(err: unknown): SendRefusedReason | undefined {
  if (isSendRefused(err)) return err.reason;
  if (!(err instanceof Error) || err.name !== "ActionInvocationError") return undefined;
  const { refusal } = err as { refusal?: unknown };
  return typeof refusal === "string" ? (refusal as SendRefusedReason) : undefined;
}

/** The error `wire` describes, with the name and message an in-process
 *  caller would have seen, and a refused send rebuilt as one. */
export function fromWireError(wire: WireError): Error {
  if (wire.refusal && wire.name === "ActionInvocationError") {
    // A called action's refusal, which the action let pass up, keeps the
    // field `ActionInvocationError` carries it in.
    const err = Object.assign(new Error(wire.message), { refusal: wire.refusal });
    err.name = wire.name;
    return err;
  }
  const err = wire.refusal ? new SendRefused(wire.refusal, wire.message) : new Error(wire.message);
  err.name = wire.name;
  return err;
}

export interface ActionWorkerRuntimeEvent {
  type: "runtime_event";
  event: ActionRuntimeEvent;
}

export type ActionWorkerMessage =
  | ActionWorkerReady
  | ActionWorkerSuccess
  | ActionWorkerFailure
  | ActionWorkerRuntimeEvent;

export function isActionWorkerMessage(message: unknown): message is ActionWorkerMessage {
  if (typeof message !== "object" || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return type === "ready" || type === "result" || type === "error" || type === "runtime_event";
}

export function isActionWorkerPayload(message: unknown): message is ActionWorkerPayload {
  if (typeof message !== "object" || message === null) return false;
  const value = message as Partial<ActionWorkerPayload>;
  return (
    typeof value.actionName === "string" &&
    typeof value.args === "object" &&
    value.args !== null &&
    typeof value.context === "object" &&
    value.context !== null
  );
}

export function isActionWorkerShutdown(message: unknown): message is ActionWorkerShutdown {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "shutdown"
  );
}
