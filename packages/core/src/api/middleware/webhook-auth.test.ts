import { describe, it, expect } from "@rstest/core";
import { Hono } from "hono";
import { createWebhookAuth } from "./webhook-auth.js";

function buildApp(apiKey: string | undefined) {
  const app = new Hono();
  app.use("/webhooks/*", createWebhookAuth(apiKey));
  app.post("/webhooks/test", (c) => c.json({ ok: true }));
  return app;
}

describe("createWebhookAuth middleware", () => {
  it("returns 503 when the API key is not configured", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "x-api-key": "anything" },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Webhook API key is not configured" });
  });

  it("returns 503 when the configured key is blank whitespace", async () => {
    const app = buildApp("   ");
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "x-api-key": "   " },
    });
    expect(res.status).toBe(503);
  });

  it("rejects requests without the X-API-Key header", async () => {
    const app = buildApp("secret-key");
    const res = await app.request("/webhooks/test", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects requests with a wrong key", async () => {
    const app = buildApp("secret-key");
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with the matching key", async () => {
    const app = buildApp("secret-key");
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "x-api-key": "secret-key" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("trims surrounding whitespace from the configured key", async () => {
    const app = buildApp("  secret-key  ");
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "x-api-key": "secret-key" },
    });
    expect(res.status).toBe(200);
  });

  it("does not touch routes outside the /webhooks/* mount", async () => {
    const app = new Hono();
    app.use("/webhooks/*", createWebhookAuth("secret-key"));
    app.get("/public", (c) => c.json({ ok: true }));

    const res = await app.request("/public");
    expect(res.status).toBe(200);
  });
});
