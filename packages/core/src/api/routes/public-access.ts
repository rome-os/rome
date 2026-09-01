import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { settings } from "../../db/schema.js";
import {
  DEFAULT_PUBLIC_ACCESS_CONFIG,
  normalizePublicAccessConfig,
  type PublicAccessConfig,
} from "../../lib/public-access-config.js";
import { writeCaddyfileAndReload } from "../../lib/public-access.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:public-access");

export function publicAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/public-access", async (c) => {
    const rows = await deps.db.select().from(settings).where(eq(settings.key, "publicAccess"));

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
      .values({ key: "publicAccess", value: config, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: config, updatedAt: now },
      });

    // Refresh the in-memory snapshot read by `/api/auth/verify` before
    // touching Caddy — even if the reload fails, the verify probe stays
    // consistent with what's now in the DB.
    deps.publicAccessState.setConfig(config);

    try {
      await writeCaddyfileAndReload(deps.db, config);
    } catch (error) {
      log.error("failed to reload caddy", {
        error: error instanceof Error ? error.message : String(error),
      });
      const detail =
        error instanceof Error && error.message
          ? error.message
          : "Failed to apply proxy configuration";
      const reconciliationDetail = [
        "The stored public-access policy has already been updated, but the proxy may still be using its previous configuration.",
        "Retry the request or restart Rome to reconcile it.",
        detail,
      ].join(" ");
      return c.json(
        { ok: false, error: "Failed to apply proxy configuration", detail: reconciliationDetail },
        500,
      );
    }

    return c.json({ ok: true });
  });

  return app;
}
