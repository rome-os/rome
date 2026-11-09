import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { resolveVisitorSession } from "../../access/visitor-session.js";
import {
  FavorServiceRequestError,
  FavorServiceUnavailableError,
} from "../../favors/rome-cloud-service.js";

function toStatus(err: unknown): ContentfulStatusCode {
  if (err instanceof FavorServiceRequestError) return err.status as ContentfulStatusCode;
  if (err instanceof FavorServiceUnavailableError) return 503;
  return 500;
}

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const rechargeSchema = z.object({ packId: z.string().min(1) }).strict();

export function favorRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/favors/balance", async (c) => {
    try {
      return c.json(await deps.favorService.getBalance(resolveVisitorSession(c) ?? undefined));
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  app.get("/favors/ledger", async (c) => {
    try {
      return c.json(
        await deps.favorService.listLedger(
          c.req.query("cursor"),
          resolveVisitorSession(c) ?? undefined,
        ),
      );
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  app.get("/favors/action-requests", async (c) => {
    try {
      return c.json(
        await deps.favorService.listActionRequests(
          c.req.query("cursor"),
          resolveVisitorSession(c) ?? undefined,
        ),
      );
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  app.post("/favors/action-requests", (c) => {
    // Favor action-request creation must come through an app API/runtime context, where
    // AppApiDispatcher supplies the requester app identity from the route.
    return c.json({ error: "app_bound_runtime_required" }, 403);
  });

  app.get("/favors/action-requests/:id", async (c) => {
    try {
      return c.json(
        await deps.favorService.getActionRequest(
          c.req.param("id"),
          resolveVisitorSession(c) ?? undefined,
        ),
      );
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  app.post("/favors/action-requests/:id/pay", async (c) => {
    try {
      return c.json(
        await deps.favorService.resolveActionRequest(
          c.req.param("id"),
          "pay",
          resolveVisitorSession(c) ?? undefined,
        ),
      );
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  app.post("/favors/action-requests/:id/decline", async (c) => {
    try {
      return c.json(
        await deps.favorService.resolveActionRequest(
          c.req.param("id"),
          "decline",
          resolveVisitorSession(c) ?? undefined,
        ),
      );
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  app.get("/favors/recharge", async (c) => {
    try {
      return c.json(
        await deps.favorService.listRechargePacks(resolveVisitorSession(c) ?? undefined),
      );
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  app.post("/favors/recharge", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = rechargeSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    }
    try {
      return c.json(
        await deps.favorService.createRechargeCheckout(
          parsed.data.packId,
          resolveVisitorSession(c) ?? undefined,
        ),
      );
    } catch (err) {
      return c.json({ error: toError(err) }, toStatus(err));
    }
  });

  return app;
}
