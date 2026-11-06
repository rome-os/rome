import { Hono } from "hono";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  DEFAULT_DASHBOARD_ACCESS_CONFIG,
  normalizeDashboardAccessConfig,
  type DashboardAccessConfig,
} from "../../lib/dashboard-access-config.js";
import type { ApiDeps } from "../deps.js";

export function dashboardAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/dashboard-access", async (c) => {
    const stored = await deps.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
    const config = stored
      ? normalizeDashboardAccessConfig(stored)
      : DEFAULT_DASHBOARD_ACCESS_CONFIG;
    return c.json(config);
  });

  app.put("/dashboard-access", async (c) => {
    const body = await c.req.json().catch(() => null);
    const config: DashboardAccessConfig = normalizeDashboardAccessConfig(body);

    const saved = await deps.dashboardAccessStore.save(config);
    deps.dashboardAccessState.setConfig(config);
    // The sync drops a revision older than one it already holds, so two saves
    // that finish out of order still send the newer list.
    deps.visitorAllowListSync.push(saved);

    return c.json({ ok: true });
  });

  return app;
}
