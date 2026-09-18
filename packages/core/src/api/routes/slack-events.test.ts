import { createHmac } from "node:crypto";
import { describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { SlackAdapter, SlackIngress } from "../../channels/slack.js";
import { SLACK_EVENT_BODY_LIMIT_BYTES, slackEventsRoutes } from "./slack-events.js";

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

  it("rejects an oversized declared body before authentication", async () => {
    const app = new Hono().route(
      "/",
      slackEventsRoutes({ slackIngress: new SlackIngress("secret") }),
    );
    const response = await app.request(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: { "content-length": String(SLACK_EVENT_BODY_LIMIT_BYTES + 1) },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
  });

  it("stops reading an oversized chunked body before authentication", async () => {
    const app = new Hono().route(
      "/",
      slackEventsRoutes({ slackIngress: new SlackIngress("secret") }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(SLACK_EVENT_BODY_LIMIT_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const response = await app.request(
      new Request("http://localhost/slack/events", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
  });

  it("acknowledges authenticated Slack control payloads", async () => {
    const secret = "secret";
    const app = new Hono().route(
      "/",
      slackEventsRoutes({ slackIngress: new SlackIngress(secret) }),
    );
    const response = await app.request(
      signedRequest(secret, JSON.stringify({ type: "app_rate_limited", team_id: "T1" })),
    );

    expect(response.status).toBe(200);
  });

  it("asks Slack to retry while a workspace handler is not registered", async () => {
    const secret = "secret";
    const app = new Hono().route(
      "/",
      slackEventsRoutes({ slackIngress: new SlackIngress(secret) }),
    );
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-starting",
      team_id: "T1",
      event: { type: "message", channel_type: "im" },
    });
    const response = await app.request(signedRequest(secret, body));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("does not deduplicate a failed delivery before Slack retries", async () => {
    const secret = "secret";
    const ingress = new SlackIngress(secret);
    let attempts = 0;
    const handler = rs.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary failure");
    });
    ingress.subscribe("T1", handler);
    const app = new Hono().route("/", slackEventsRoutes({ slackIngress: ingress }));
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-retry",
      team_id: "T1",
      event: { type: "message", channel_type: "im" },
    });

    expect((await app.request(signedRequest(secret, body))).status).toBe(503);
    expect((await app.request(signedRequest(secret, body))).status).toBe(200);
    expect((await app.request(signedRequest(secret, body))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps an event retryable while adapter startup is still identifying the bot", async () => {
    const secret = "secret";
    const ingress = new SlackIngress(secret);
    let finishAuth!: () => void;
    const authReady = new Promise<void>((resolve) => {
      finishAuth = resolve;
    });
    const delivered = rs.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      ingress,
      api: {
        authTest: async () => {
          await authReady;
          return { teamId: "T1", botUserId: "UBOT" };
        },
        postMessage: async () => ({ ts: "unused" }),
      },
    });
    adapter.onMessage(delivered);
    const started = adapter.start();
    const app = new Hono().route("/", slackEventsRoutes({ slackIngress: ingress }));
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-during-start",
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "hello",
        ts: "1700000000.1",
      },
    });

    expect((await app.request(signedRequest(secret, body))).status).toBe(503);
    finishAuth();
    await started;
    expect((await app.request(signedRequest(secret, body))).status).toBe(200);
    expect(delivered).toHaveBeenCalledTimes(1);
    adapter.stop();
  });
});
