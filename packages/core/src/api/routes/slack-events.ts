import { Hono } from "hono";
import type { SlackEventEnvelope } from "../../channels/slack.js";
import type { ApiDeps } from "../deps.js";

function isSlackEventEnvelope(value: unknown): value is SlackEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "event_callback" &&
    typeof candidate.event_id === "string" &&
    candidate.event_id.length > 0 &&
    typeof candidate.team_id === "string" &&
    candidate.team_id.length > 0 &&
    !!candidate.event &&
    typeof candidate.event === "object" &&
    typeof (candidate.event as Record<string, unknown>).type === "string"
  );
}

/** Public Slack Events API endpoint. Slack request signatures are its auth. */
export function slackEventsRoutes(deps: Pick<ApiDeps, "slackIngress">): Hono {
  const app = new Hono();

  app.post("/slack/events", async (c) => {
    const ingress = deps.slackIngress;
    if (!ingress?.configured) {
      return c.json({ error: "Slack events are not configured." }, 503);
    }

    const rawBody = await c.req.text();
    const verification = ingress.verifyRequest(rawBody, {
      timestamp: c.req.header("x-slack-request-timestamp"),
      signature: c.req.header("x-slack-signature"),
    });
    if (!verification.ok) {
      return c.json({ error: "Invalid Slack request." }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
    }

    if (
      payload &&
      typeof payload === "object" &&
      (payload as { type?: unknown }).type === "url_verification" &&
      typeof (payload as { challenge?: unknown }).challenge === "string"
    ) {
      return c.json({ challenge: (payload as { challenge: string }).challenge });
    }
    if (!isSlackEventEnvelope(payload)) {
      return c.json({ error: "Unsupported Slack event." }, 400);
    }

    await ingress.dispatch(payload);
    return c.json({ ok: true });
  });

  return app;
}
