import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cloudBearer } from "../../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";

// Dashboard/app-facing relay for Showcase preset cases (shareable agent-trace
// "cases"). The Showcases app cannot reach Rome Cloud itself and must never hold
// the instance token, so core brokers every call: it attaches the
// token where Rome Cloud requires it and mirrors Rome Cloud's verdict (status +
// JSON body) back unchanged. Read endpoints (catalog/bundle) are public on
// Rome Cloud, so they work even on an instance that is not enrolled.
//
// Routes (mounted under /api):
//   GET  /showcase-presets/catalog        → Rome Cloud GET  /api/showcases/presets
//   GET  /showcase-presets/:id/bundle     → Rome Cloud GET  /api/showcases/presets/:id/bundle
//   GET    /showcase-presets/can-publish  → Rome Cloud GET    /api/showcases/can-publish (token)
//   POST   /showcase-presets/publish      → Rome Cloud POST   /api/showcases/presets     (token)
//   DELETE /showcase-presets/:id          → Rome Cloud DELETE /api/showcases/presets/:id  (token)

const RELAY_TIMEOUT_MS = 30_000;

function romeCloudOrigin(): string | null {
  return getRomeCloudOrigin();
}

// Bearer the relay presents to Rome Cloud's authenticated cases endpoints
// (can-publish / publish). Prefer the instance token; if the instance
// is not enrolled, fall back to a cloud account/CLI token (`rome_…`) from
// ROME_CLOUD_TOKEN. Rome Cloud accepts either — an instance token via
// verifyInstanceRequest, an account/CLI token via the store session — so the
// fallback lets a not-yet-enrolled instance (local dev / self-host) act as the
// signed-in account. The token is presented only to Rome Cloud, never to the app.
async function cloudAuthToken(): Promise<string | null> {
  const instance = await cloudBearer();
  if (instance) return instance;
  const account = process.env.ROME_CLOUD_TOKEN?.trim();
  return account && account.length > 0 ? account : null;
}

async function mirror(response: Response, c: Context) {
  const body: unknown = await response.json().catch(() => null);
  if (body === null) {
    return c.json({ error: "Rome Cloud returned a non-JSON response" }, 502);
  }
  c.header("Cache-Control", "no-store");
  return c.json(body as Record<string, unknown>, response.status as ContentfulStatusCode);
}

export function showcasePresetRoutes(): Hono {
  const app = new Hono();

  app.get("/showcase-presets/catalog", async (c) => {
    const origin = romeCloudOrigin();
    if (!origin) {
      c.header("Cache-Control", "no-store");
      return c.json({ available: false, presets: [] });
    }
    let upstream: Response;
    try {
      upstream = await fetch(new URL("/api/showcases/presets", origin), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      return c.json({ available: true, error: `Failed to reach Rome Cloud: ${message}` }, 502);
    }
    return mirror(upstream, c);
  });

  app.get("/showcase-presets/:id/bundle", async (c) => {
    const origin = romeCloudOrigin();
    if (!origin) return c.json({ error: "unconfigured" }, 503);
    const id = c.req.param("id");
    let upstream: Response;
    try {
      upstream = await fetch(
        new URL(`/api/showcases/presets/${encodeURIComponent(id)}/bundle`, origin),
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      return c.json({ error: `Failed to reach Rome Cloud: ${message}` }, 502);
    }
    return mirror(upstream, c);
  });

  app.get("/showcase-presets/can-publish", async (c) => {
    const origin = romeCloudOrigin();
    const token = await cloudAuthToken();
    if (!origin || !token) {
      c.header("Cache-Control", "no-store");
      return c.json({ canPublish: false });
    }
    let upstream: Response;
    try {
      upstream = await fetch(new URL("/api/showcases/can-publish", origin), {
        headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch {
      // A network blip should not hard-fail the gallery; treat as not allowed.
      c.header("Cache-Control", "no-store");
      return c.json({ canPublish: false });
    }
    return mirror(upstream, c);
  });

  app.post("/showcase-presets/publish", async (c) => {
    const origin = romeCloudOrigin();
    if (!origin) return c.json({ error: "unconfigured" }, 503);
    const token = await cloudAuthToken();
    if (!token) return c.json({ error: "no_token" }, 401);

    const payload = await c.req.json().catch(() => null);
    if (payload === null) return c.json({ error: "invalid_json" }, 400);

    let upstream: Response;
    try {
      upstream = await fetch(new URL("/api/showcases/presets", origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      return c.json({ error: `Failed to reach Rome Cloud: ${message}` }, 502);
    }
    return mirror(upstream, c);
  });

  app.delete("/showcase-presets/:id", async (c) => {
    const origin = romeCloudOrigin();
    if (!origin) return c.json({ error: "unconfigured" }, 503);
    const token = await cloudAuthToken();
    if (!token) return c.json({ error: "no_token" }, 401);
    const id = c.req.param("id");
    let upstream: Response;
    try {
      upstream = await fetch(new URL(`/api/showcases/presets/${encodeURIComponent(id)}`, origin), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      return c.json({ error: `Failed to reach Rome Cloud: ${message}` }, 502);
    }
    return mirror(upstream, c);
  });

  return app;
}
