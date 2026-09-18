import { createHmac } from "node:crypto";
import { describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { SlackIngress } from "../../channels/slack.js";
import { slackEventsRoutes } from "./slack-events.js";

function signedRequest(
  secret: string,
  body: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new Request("http://localhost/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("POST /slack/events", () => {
  it("answers Slack's signed URL verification challenge", async () => {
    const secret = "secret";
    const app = new Hono().route(
      "/",
      slackEventsRoutes({ slackIngress: new SlackIngress(secret) }),
    );
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-value" });
    const response = await app.request(signedRequest(secret, body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "challenge-value" });
  });

  it("rejects unsigned requests before dispatch", async () => {
    const ingress = new SlackIngress("secret");
    const handler = rs.fn(() => {});
    ingress.subscribe("T1", handler);
    const app = new Hono().route("/", slackEventsRoutes({ slackIngress: ingress }));
    const response = await app.request("/slack/events", {
      method: "POST",
      body: JSON.stringify({
        type: "event_callback",
        event_id: "Ev1",
        team_id: "T1",
        event: { type: "message" },
      }),
    });

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches a signed event once", async () => {
    const secret = "secret";
    const ingress = new SlackIngress(secret);
    const handler = rs.fn(async () => {});
    ingress.subscribe("T1", handler);
    const app = new Hono().route("/", slackEventsRoutes({ slackIngress: ingress }));
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      team_id: "T1",
      event: { type: "message", channel_type: "im" },
    });

    expect((await app.request(signedRequest(secret, body))).status).toBe(200);
    expect((await app.request(signedRequest(secret, body))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
