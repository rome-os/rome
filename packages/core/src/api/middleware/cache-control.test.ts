import { describe, it, expect } from "@rstest/core";
import { Hono } from "hono";
import { defaultApiCacheControl } from "./cache-control.js";
import { errorHandler } from "./error-handler.js";

function buildApp() {
  // Mirror production wiring: the API sub-app is mounted under /api on an outer
  // app that owns the error handler (see api/index.ts). `app.route` merges the
  // sub-app's middleware and routes into the outer compose chain, so the
  // middleware's post-handler pass also covers error responses.
  const outer = new Hono();
  outer.onError(errorHandler);
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
  // App API handlers can return a raw Fetch Response (e.g. a proxied fetch()
  // result or Response.redirect()) whose headers are immutable.
  api.get("/immutable-redirect", () => Response.redirect("https://example.com/x", 302));
  // A handler that throws routes to the outer errorHandler's 500 response.
  api.get("/boom", () => {
    throw new Error("boom");
  });
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

  it("applies the default to immutable Fetch responses instead of dropping it", async () => {
    const app = buildApp();
    const res = await app.request("/api/immutable-redirect");
    // A response returned straight from Response.redirect() has immutable
    // headers; the default must still land (and the redirect is preserved).
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/x");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("defaults error-handler responses under /api to no-store", async () => {
    const app = buildApp();
    const res = await app.request("/api/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
