import { createAppLogger } from "@rome-os/app-runtime";
import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";

const log = createAppLogger("email-inbound");

// The inbound email logic (HMAC verify, guardian gate, body pull, normalize,
// dispatch) lives in the core EmailAdapter, which runs in the main process. This
// action runs in a forked action worker, so it can't touch that adapter
// directly — it forwards the raw relay deposit + HMAC to the main process via
// the injected control (a direct call in main, an RPC proxy in a worker).
interface EmailInboundControl {
  ingest(rawBody: string, signature: string): Promise<{ status: string; reason?: string }>;
}

export function createEmailInboundAction(
  config: ActionConfig,
  emailInbound: EmailInboundControl,
): Action {
  return {
    config,
    // No inputSchema — invoked only by the connector transport, never an agent.
    async execute(args: Record<string, unknown>): Promise<ActionResult> {
      const rawBody = typeof args.rawBody === "string" ? args.rawBody : "";
      const signature = typeof args.signature === "string" ? args.signature : "";

      const result = await emailInbound.ingest(rawBody, signature);
      if (result.status !== "dispatched") {
        log.info("system:email_inbound not dispatched", {
          status: result.status,
          reason: result.reason,
        });
      }
      return { status: "ok", data: result };
    },
  };
}

export function createAction(
  config: ActionConfig,
  deps: { emailInbound: EmailInboundControl },
): Action {
  return createEmailInboundAction(config, deps.emailInbound);
}
