import { describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import type { FeatureVisibility } from "@rome/api-types/features";
import { gatedFeatureOf, hideGatedFeatureRoutes } from "./feature-routes.js";

describe("gatedFeatureOf", () => {
  it("names the feature that owns each gated route", () => {
    expect(gatedFeatureOf("/people")).toBe("people");
    expect(gatedFeatureOf("/people/ray/messages")).toBe("people");
    expect(gatedFeatureOf("/accounts")).toBe("people");
    expect(gatedFeatureOf("/accounts/telegram/42/dismiss")).toBe("people");
    expect(gatedFeatureOf("/sentinel-log/7/review")).toBe("inbox");
  });

  it("leaves routes of other features alone, including look-alike prefixes", () => {
    expect(gatedFeatureOf("/peoplex")).toBeUndefined();
    expect(gatedFeatureOf("/connections")).toBeUndefined();
    expect(gatedFeatureOf("/apps")).toBeUndefined();
  });
});

function api(visibility: FeatureVisibility) {
  const inner = new Hono();
  inner.use("*", hideGatedFeatureRoutes(visibility));
  inner.get("/people", (c) => c.json({ people: [] }));
  inner.get("/sentinel-log", (c) => c.json([]));
  inner.get("/apps", (c) => c.json({ apps: [] }));
  const app = new Hono();
  app.route("/api", inner);
  return app;
}

describe("hideGatedFeatureRoutes", () => {
  const hidden: FeatureVisibility = { people: false, inbox: false };

  it("answers 404 for a hidden feature's routes", async () => {
    const app = api(hidden);
    expect((await app.request("/api/people")).status).toBe(404);
    expect((await app.request("/api/sentinel-log")).status).toBe(404);
  });

  it("serves a shown feature's routes", async () => {
    const app = api({ ...hidden, people: true });
    expect((await app.request("/api/people")).status).toBe(200);
    expect((await app.request("/api/sentinel-log")).status).toBe(404);
  });

  it("serves routes no feature owns", async () => {
    expect((await api(hidden).request("/api/apps")).status).toBe(200);
  });
});

describe("hideGatedFeatureRoutes in this release", () => {
  it("hides People and Inbox", async () => {
    const inner = new Hono();
    inner.use("*", hideGatedFeatureRoutes());
    inner.get("/people", (c) => c.json({ people: [] }));
    inner.get("/sentinel-log", (c) => c.json([]));
    const app = new Hono();
    app.route("/api", inner);
    for (const path of ["/api/people", "/api/sentinel-log"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });
});
