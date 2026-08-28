import { Hono } from "hono";
import { describe, expect, it, rs } from "@rstest/core";
import { VISITOR_COOKIE_NAME, createVisitorSession } from "../../lib/auth.js";
import type { FavorService } from "../../favors/types.js";
import type { ApiDeps } from "../deps.js";
import { favorRoutes } from "./favors.js";

function buildApp(deps: Partial<ApiDeps>) {
  return new Hono().route("/", favorRoutes(deps as ApiDeps));
}

describe("Favor routes", () => {
  it("refuses browser favor-action creation without trusting a caller-supplied app id", async () => {
    const requestAction = rs.fn();
    const appCatalogGet = rs.fn();
    const app = buildApp({
      appCatalog: { get: appCatalogGet } as unknown as ApiDeps["appCatalog"],
      favorService: { requestAction } as unknown as FavorService,
    });

    const res = await app.request("/favors/action-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${VISITOR_COOKIE_NAME}=${createVisitorSession("acct-1", "visitor@example.test")}`,
      },
      body: JSON.stringify({
        appId: "other-app",
        actionName: "ship",
        args: {},
        idempotencyKey: "idem-1",
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "app_bound_runtime_required" });
    expect(appCatalogGet).not.toHaveBeenCalled();
    expect(requestAction).not.toHaveBeenCalled();
  });
});
