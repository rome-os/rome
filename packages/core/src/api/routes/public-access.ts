import { Hono } from "hono";
import {
  loadAppPermissionsSetting,
  normalizeAppPermissionsSetting,
  saveAppPermissionsSetting,
} from "../../apps/app-permissions.js";
import type { ApiDeps } from "../deps.js";

export function publicAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/public-access", async (c) => {
    return c.json(await loadAppPermissionsSetting(deps.db));
  });

  app.put("/public-access", async (c) => {
    const body = await c.req.json().catch(() => null);
    // Also refreshes the permissions `/api/auth/verify` reads. The proxy config
    // does not depend on them, so nothing else needs to reload.
    await saveAppPermissionsSetting(
      deps.db,
      deps.permissions,
      normalizeAppPermissionsSetting(body),
    );
    return c.json({ ok: true });
  });

  return app;
}
