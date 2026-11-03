import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { FEEDBACK_BODY_MAX } from "../../lib/feedback.js";

// Guardian-facing "share feedback" relay. The dashboard POSTs free text plus the
// context it owns (`client`); the instance attaches the diagnostics it measures
// and forwards a versioned report to Rome Cloud over the instance token,
// where it lands as a triage row. Like the system-upgrade forwarders, the route
// holds no policy of its own — `/api/*` is already guardian-gated at the edge —
// it just enriches and relays.
//
// The trust boundary lives here: `diagnostics` is assembled server-side and is
// never read from the request body, so a malicious or buggy client can't spoof
// the trusted namespace (the worst it can do is stuff keys under `client`).

const bodySchema = z
  .object({
    body: z.string().trim().min(1).max(FEEDBACK_BODY_MAX),
    // Open-ended by design (route, theme, UA, …). `.record` accepts any keys, so
    // the client namespace can grow without a contract change.
    client: z.record(z.string(), z.unknown()).default({}),
  })
  // Strict on the envelope (the part both sides control): a stray top-level key
  // — e.g. a `diagnostics` spoof attempt — is rejected outright.
  .strict();

export function feedbackRoutes(deps: Pick<ApiDeps, "feedback">): Hono {
  const app = new Hono();

  app.post("/feedback", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    }

    const outcome = await deps.feedback.sendGuardian(parsed.data);
    switch (outcome.kind) {
      case "no_token":
      case "unconfigured":
        return c.json({ error: "pantheon_unconfigured" }, 503);
      case "unreachable":
        return c.json({ error: "pantheon_unreachable" }, 502);
      case "rejected":
        return c.json(outcome.body, outcome.status as ContentfulStatusCode);
      case "ok":
        break;
      default:
        throw new Error(`Unexpected guardian feedback outcome: ${outcome.kind}`);
    }

    return c.json({ ok: true }, 201);
  });

  return app;
}
