import { Hono } from "hono";
import type { SlackEventEnvelope } from "../../channels/slack.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("slack-events");
export const SLACK_EVENT_BODY_LIMIT_BYTES = 256 * 1024;

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

    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > SLACK_EVENT_BODY_LIMIT_BYTES) {
      return c.json({ error: "Slack request is too large." }, 413);
    }
    const rawBody = await readLimitedBody(c.req.raw, SLACK_EVENT_BODY_LIMIT_BYTES);
    if (!rawBody) return c.json({ error: "Slack request is too large." }, 413);

    const verification = ingress.verifyRequest(rawBody, {
      timestamp: c.req.header("x-slack-request-timestamp"),
      signature: c.req.header("x-slack-signature"),
    });
    if (!verification.ok) {
      log.debug("slack request rejected", { reason: verification.reason });
      return c.json({ error: "Invalid Slack request." }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
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
    if (
      payload &&
      typeof payload === "object" &&
      typeof (payload as { type?: unknown }).type === "string" &&
      (payload as { type: string }).type !== "event_callback"
    ) {
      // Authenticated Slack control/future payloads (for example
      // `app_rate_limited`) need no work but must not trigger retry storms.
      return c.json({ ok: true });
    }
    if (!isSlackEventEnvelope(payload)) {
      return c.json({ error: "Unsupported Slack event." }, 400);
    }

    try {
      const result = await ingress.dispatch(payload);
      if (result === "starting" || result === "retry") {
        c.header("Retry-After", "1");
        return c.json({ error: "Slack workspace handler is starting." }, 503);
      }
      if (result === "unhandled") {
        // A correctly signed event may belong to an unbound/degraded workspace.
        // Outside a bounded registration window it cannot become deliverable by
        // retrying, so acknowledge it rather than harming the shared Slack app's
        // Events API health with an indefinite 5xx loop.
        log.debug("slack event has no workspace handler", {
          eventId: payload.event_id,
          teamId: payload.team_id,
        });
      }
    } catch (error) {
      log.error("slack event dispatch failed", {
        eventId: payload.event_id,
        error: error instanceof Error ? error.message : String(error),
      });
      c.header("Retry-After", "1");
      return c.json({ error: "Slack event handling failed." }, 503);
    }
    return c.json({ ok: true });
  });

  return app;
}

/** Read no more than `limit` bytes, including requests without Content-Length. */
async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
