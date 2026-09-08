import { describe, it, expect } from "@rstest/core";
import { Hono } from "hono";
import { defaultApiCacheControl } from "./cache-control.js";

function buildApp() {
  const outer = new Hono();
  const api = new Hono();
  api.use("*", defaultApiCacheControl());
  // No cache policy declared — should default to no-store.
  api.get("/chat/sessions", (c) => c.json([{ id: "s1" }]));
  // Explicit route-level policy — must win over the default.
  api.get("/apps/:appId/icon", (c) =>
    c.body("icon-bytes", 200, { "Cache-Control": "public, max-age=300" }),
  );
  // Explicit no-cache policy is also preserved verbatim.
  api.get("/explicit-no-cache", (c) => c.json({ ok: true }, 200, { "Cache-Control": "no-cache" }));
  outer.route("/api", api);
  // Root-mounted surface outside /api is never touched by this middleware.
  outer.get("/app-assets/:appId/:version/*", (c) =>
    c.body("asset", 200, { "Cache-Control": "public, max-age=31536000, immutable" }),
  );
  return outer;
}

describe("defaultApiCacheControl middleware", () => {
  it("defaults /api/* responses without a cache policy to no-store", async () => {
    const app = buildApp();
    const res = await app.request("/api/chat/sessions");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("lets a route-level Cache-Control override the default", async () => {
    const app = buildApp();
    const res = await app.request("/api/apps/demo/icon");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("preserves an explicit no-cache policy instead of replacing it", async () => {
    const app = buildApp();
    const res = await app.request("/api/explicit-no-cache");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("does not touch surfaces mounted outside the /api sub-app", async () => {
    const app = buildApp();
    const res = await app.request("/app-assets/demo/1.0.0/index.js");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });
});
