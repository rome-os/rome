import { defineAction, z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";

// ---------------------------------------------------------------------------
// Dependencies injected via factory
// ---------------------------------------------------------------------------

/** Structural copy of core's `SendOutcome`/`NotifyService`
 * (`packages/core/src/lib/notify-client.ts`). Like every system action's
 * capability interface, it is re-declared here rather than imported: the action
 * can't reach core internals, and the runtime injects the real `NotifyClient`
 * in the main process or its WorkerRPC proxy in a worker — both satisfy this
 * shape. Keep field-for-field in sync with core. */
export type SendOutcome =
  | { kind: "ok"; attempted: number; sent: number; failed: number }
  | { kind: "no_token" }
  | { kind: "unconfigured" }
  | { kind: "reenroll" }
  /** Rome Cloud refused the named recipient: not the instance's owner nor on its visitor list. Nothing was sent. */
  | { kind: "recipient_not_allowed" }
  | { kind: "outcome_unknown" };

/** Structural copy of core's `NotifyContent`. An optional
 * sender-supplied body. `defineAction` validates the agent input against
 * `inputSchema` and fails closed; Rome Cloud independently validates and
 * normalizes the raw HTTP request (the two validation layers). */
export interface NotifyContent {
  body?: string;
}

export interface NotifyService {
  send(content?: NotifyContent): Promise<SendOutcome>;
}

export interface SendNotificationDeps {
  notify: NotifyService;
}

// ---------------------------------------------------------------------------
// Factory: createSendNotificationAction
// ---------------------------------------------------------------------------

// The Zod schema is the single source of truth: `defineAction` generates the
// model-facing `inputSchema` from it AND validates every call at the boundary,
// failing closed. `.strict()` rejects unknown keys (e.g. a typo'd `bodu` or a
// caller-supplied `title`) and a non-string `body` — those return an error
// result without ever calling `notify.send`. An absent `body` sends the default
// alert (backward compatible with the zero-argument call); an empty string is
// forwarded unchanged, since Rome Cloud owns the blank→default fallback.
const sendNotificationInput = z.object({ body: z.string().optional() }).strict();

export function createSendNotificationAction(
  config: ActionConfig,
  deps: SendNotificationDeps,
): Action {
  return defineAction({
    config,
    schema: sendNotificationInput,
    async execute({ body }): Promise<ActionResult> {
      const outcome = await deps.notify.send(body !== undefined ? { body } : undefined);
      switch (outcome.kind) {
        case "ok":
          if (outcome.sent > 0) {
            return {
              status: "ok",
              data: { attempted: outcome.attempted, sent: outcome.sent, failed: outcome.failed },
            };
          }
          // 200 from the broker but nothing delivered: distinguish "no device
          // registered" (persistent) from "every registered device failed"
          // (possibly transient) so the agent can respond appropriately.
          return outcome.attempted === 0
            ? { status: "error", error: "no_devices" }
            : { status: "error", error: "sent_zero" };
        case "no_token":
          return { status: "error", error: "no_token" };
        case "unconfigured":
          return { status: "error", error: "unconfigured" };
        case "reenroll":
          return { status: "error", error: "instance_reenrollment_required" };
        case "recipient_not_allowed":
          return { status: "error", error: "recipient_not_allowed" };
        case "outcome_unknown":
          return { status: "error", error: "notification_outcome_unknown" };
        default: {
          // Compile-time exhaustiveness for the local union; runtime fallback
          // for drift from core's separately declared canonical SendOutcome.
          const _exhaustive: never = outcome;
          void _exhaustive;
          return { status: "error", error: "notification_outcome_unknown" };
        }
      }
    },
  });
}

export function createAction(config: ActionConfig, deps: SendNotificationDeps): Action {
  // Validate the shape (not just presence): the loader threads deps as an
  // untyped bag, so a missing/mis-wired notify is caught here at load rather
  // than as a TypeError on the first send.
  if (typeof deps.notify?.send !== "function") {
    throw new Error("send_notification requires a notify capability with a send() method");
  }
  return createSendNotificationAction(config, deps);
}
