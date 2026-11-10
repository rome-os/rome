import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { settings } from "../../db/schema.js";
import {
  DEFAULT_PUBLIC_ACCESS_CONFIG,
  PUBLIC_ACCESS_SETTING_KEY,
  normalizePublicAccessConfig,
  type PublicAccessConfig,
} from "../../access/public-access-config.js";
import { isValidAppId } from "../../apps/packaging/app-id.js";
import type { ApiDeps } from "../deps.js";

// Access matches app ids as plain strings, so the dashboard's route is where a
// malformed app id is dropped, both when the guardian saves and when the saved
// setting is shown back to them.
function withValidAppIds(config: PublicAccessConfig): PublicAccessConfig {
  return {
    allowedApps: config.allowedApps.filter(isValidAppId),
    cloudEmailAccess: Object.fromEntries(
      Object.entries(config.cloudEmailAccess).filter(([appId]) => isValidAppId(appId)),
    ),
  };
}

export function publicAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/public-access", async (c) => {
    const rows = await deps.db
      .select()
      .from(settings)
      .where(eq(settings.key, PUBLIC_ACCESS_SETTING_KEY));

    const config =
      rows.length > 0 && rows[0].value
        ? withValidAppIds(normalizePublicAccessConfig(rows[0].value))
        : DEFAULT_PUBLIC_ACCESS_CONFIG;
    return c.json(config);
  });

  app.put("/public-access", async (c) => {
    const body = await c.req.json().catch(() => null);
    const config = withValidAppIds(normalizePublicAccessConfig(body));

    const now = new Date();
    await deps.db
      .insert(settings)
      .values({ key: PUBLIC_ACCESS_SETTING_KEY, value: config, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: config, updatedAt: now },
      });

    // Refresh the in-memory snapshot read by `/api/auth/verify`. The proxy
    // config does not depend on the policy, so nothing else needs to reload.
    deps.publicAccessState.setConfig(config);

    return c.json({ ok: true });
  });

  return app;
}
