import { Hono } from "hono";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  DEFAULT_DASHBOARD_ACCESS_CONFIG,
  normalizeDashboardAccessConfig,
  readDashboardAccessRevision,
  type DashboardAccessConfig,
} from "../../lib/dashboard-access-config.js";
import type { ApiDeps } from "../deps.js";

export function dashboardAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  // Saves run one at a time so each gets its own revision, and lists reach the
  // Rome Cloud sync in revision order.
  let saving: Promise<unknown> = Promise.resolve();

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

    const save = saving.then(async () => {
      const stored = await deps.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
      const revision = readDashboardAccessRevision(stored) + 1;
      await deps.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, { ...config, revision });
      deps.dashboardAccessState.setConfig(config);
      deps.visitorAllowListSync.push({ emails: config.cloudEmailAccess, revision });
    });
    saving = save.catch(() => {});
    await save;

    return c.json({ ok: true });
  });

  return app;
}
