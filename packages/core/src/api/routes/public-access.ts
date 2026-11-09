import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { settings } from "../../db/schema.js";
import {
  DEFAULT_PUBLIC_ACCESS_CONFIG,
  PUBLIC_ACCESS_SETTING_KEY,
  normalizePublicAccessConfig,
  type PublicAccessConfig,
} from "../../access/public-access-config.js";
import type { ApiDeps } from "../deps.js";

export function publicAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/public-access", async (c) => {
    const rows = await deps.db
      .select()
      .from(settings)
      .where(eq(settings.key, PUBLIC_ACCESS_SETTING_KEY));

    const config =
      rows.length > 0 && rows[0].value
        ? normalizePublicAccessConfig(rows[0].value)
        : DEFAULT_PUBLIC_ACCESS_CONFIG;
    return c.json(config);
  });

  app.put("/public-access", async (c) => {
    const body = await c.req.json().catch(() => null);
    const config: PublicAccessConfig = normalizePublicAccessConfig(body);

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
