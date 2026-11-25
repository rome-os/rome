import {
  DASHBOARD_ACCESS_MAX_EMAIL_LENGTH,
  DASHBOARD_ACCESS_MAX_EMAILS,
  checkDashboardAccessLimits,
} from "@rome/api-types/dashboard-access";
import { Hono } from "hono";
import {
  normalizeDashboardAccessConfig,
  type DashboardAccessConfig,
} from "../../access/dashboard-access-config.js";
import type { ApiDeps } from "../deps.js";

export function dashboardAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/dashboard-access", async (c) => {
    const { emails } = await deps.dashboardAccessStore.read();
    const config: DashboardAccessConfig = { cloudEmailAccess: [...emails] };
    return c.json(config);
  });

  app.put("/dashboard-access", async (c) => {
    const body = await c.req.json().catch(() => null);
    const raw = (body as { cloudEmailAccess?: unknown } | null)?.cloudEmailAccess;
    const limitError = Array.isArray(raw) ? checkDashboardAccessLimits(raw) : null;
    if (limitError) {
      return c.json(
        {
          error: limitError,
          limit:
            limitError === "too_many_emails"
              ? DASHBOARD_ACCESS_MAX_EMAILS
              : DASHBOARD_ACCESS_MAX_EMAIL_LENGTH,
        },
        400,
      );
    }
    const config: DashboardAccessConfig = normalizeDashboardAccessConfig(body);

    // A failed write to the members fails the request before the snapshot or
    // Rome Cloud hears of the list.
    const saved = await deps.dashboardAccessStore.save(config);
    await deps.dashboardAccessState.load(deps.db);
    // The sync drops a revision older than one it already holds, so two saves
    // that finish out of order still send the newer list.
    deps.visitorAllowListSync.push(saved);

    return c.json({ ok: true });
  });

  return app;
}
