import { Hono } from "hono";
import {
  isAppAccessRefusal,
  loadAppPermissionsSetting,
  parseAppAccess,
  setAppAccess,
  shareableApps,
} from "../../apps/app-permissions.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";

const REFUSAL_STATUS = { "unknown-app": 404, "no-page": 409, invalid: 400, widens: 409 } as const;

export function publicAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/public-access", async (c) => {
    return c.json(await loadAppPermissionsSetting(deps.db));
  });

  // One app's access, `{ mode, emails }`. Answers the access before and after.
  app.put("/public-access/:appId", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const access = parseAppAccess(body ?? {});
    if (isAppAccessRefusal(access))
      return c.json({ error: access.message }, REFUSAL_STATUS[access.reason]);
    const result = await setAppAccess(
      { db: deps.db, permissions: deps.permissions, apps: shareableApps(deps.appCatalog) },
      c.req.param("appId"),
      access,
    );
    if (isAppAccessRefusal(result))
      return c.json({ error: result.message }, REFUSAL_STATUS[result.reason]);
    return c.json(result);
  });

  return app;
}
