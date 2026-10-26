import { Hono } from "hono";
import { z } from "zod";
import { isResolvedApp } from "../../apps/state.js";
import { appAccessibleOperations } from "../../connections/app-connections.js";
import type { ApiDeps } from "../deps.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { currentSessionActor } from "../../lib/session-actor.js";

const ConstraintSchema = z
  .object({
    inputPointer: z.string().refine((value) => value === "" || value.startsWith("/")),
    allowedValues: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(100),
  })
  .strict();

const PutAccessSchema = z
  .object({
    approval: z.enum(["required", "not_required"]),
    constraints: z.array(ConstraintSchema).max(20).default([]),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();

const AuditQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function appConnectionAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const repo = deps.appConnectionAccessRepo;

  app.use("/app-connection-access/*", async (c, next) => {
    if ((await currentSessionActor())?.kind !== "guardian") {
      return c.json({ error: "Guardian authentication required" }, 403);
    }
    await next();
  });

  app.get("/app-connection-access/:appId", async (c) => {
    const policies = await repo.listActiveForApp(c.req.param("appId"));
    const registry = deps.connectionRegistry;
    return c.json({
      policies: await Promise.all(
        policies.map(async (policy) => {
          const grant = await registry?.grantOf(policy.connectionId);
          const grantStatus =
            grant?.grantEpoch === policy.grantEpoch
              ? "current"
              : grant?.state === "unauthorized"
                ? "authorization_required"
                : grant
                  ? "replaced"
                  : "unavailable";
          return {
            ...policy,
            grantStatus,
            expiresAt: policy.expiresAt?.toISOString() ?? null,
            createdAt: policy.createdAt.toISOString(),
            updatedAt: policy.updatedAt.toISOString(),
          };
        }),
      ),
    });
  });

  app.get("/app-connection-access/:appId/audit", async (c) => {
    const query = AuditQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid pagination." }, 400);
    const rows = await repo.listAuditForApp(
      c.req.param("appId"),
      query.data.cursor,
      query.data.limit + 1,
    );
    const selected = rows.slice(0, query.data.limit);
    return c.json({
      events: selected.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      ...(rows.length > selected.length ? { nextCursor: selected.at(-1)!.seq } : {}),
    });
  });

  app.put("/app-connection-access/:appId/:connectionId/:identity/:operation", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
    const parsed = PutAccessSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid access policy." }, 400);
    const target = await resolveTarget(deps, {
      appId: c.req.param("appId"),
      connectionId: c.req.param("connectionId"),
      identity: c.req.param("identity"),
      operation: c.req.param("operation"),
    });
    if (!target.ok) return c.json({ error: target.error }, target.status);
    if (target.value.sideEffects === "read-only" && parsed.data.approval === "required") {
      return c.json({ error: "Read operations cannot require deferred approval." }, 400);
    }
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) {
      return c.json({ error: "expiresAt must be in the future." }, 400);
    }
    const policy = await repo.putIfAppActive(
      {
        appId: target.value.appId,
        connectionId: target.value.connectionId,
        identity: target.value.identity,
        operation: target.value.operation,
        sideEffects: target.value.sideEffects,
        approval: parsed.data.approval,
        constraints: parsed.data.constraints,
        expiresAt,
        grantEpoch: target.value.grantEpoch,
      },
      () => {
        const app = deps.appCatalog.get(target.value.appId);
        return isResolvedApp(app) && app.enabled;
      },
    );
    if (!policy) return c.json({ error: "App not found or disabled." }, 409);
    return c.json({
      policy: {
        ...policy,
        expiresAt: policy.expiresAt?.toISOString() ?? null,
        revokedAt: policy.revokedAt?.toISOString() ?? null,
        createdAt: policy.createdAt.toISOString(),
        updatedAt: policy.updatedAt.toISOString(),
      },
    });
  });

  app.delete("/app-connection-access/:appId/:connectionId/:identity/:operation", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
    const revoked = await repo.revoke(
      c.req.param("appId"),
      c.req.param("connectionId"),
      c.req.param("identity"),
      c.req.param("operation"),
    );
    return revoked ? c.body(null, 204) : c.json({ error: "Access policy not found." }, 404);
  });

  return app;
}

async function resolveTarget(
  deps: ApiDeps,
  target: { appId: string; connectionId: string; identity: string; operation: string },
): Promise<
  | {
      ok: true;
      value: typeof target & { sideEffects: "read-only" | "write"; grantEpoch: string };
    }
  | { ok: false; status: 404 | 409 | 503; error: string }
> {
  const app = deps.appCatalog.get(target.appId);
  if (!isResolvedApp(app) || !app.enabled) {
    return { ok: false, status: 404, error: "App not found or disabled." };
  }
  if (!deps.connectionRegistry) {
    return { ok: false, status: 503, error: "Connections are unavailable." };
  }
  const connection = deps.connectionRegistry
    .all()
    .find((candidate) => candidate.id === target.connectionId);
  if (!connection) return { ok: false, status: 404, error: "Connection not found." };
  const operations = appAccessibleOperations(deps.connectionRegistry, connection, target.identity);
  if (!operations.ok) {
    return { ok: false, status: 409, error: operations.error.message };
  }
  const operation = operations.value.find((candidate) => candidate.name === target.operation);
  if (!operation?.appAccess) {
    return { ok: false, status: 404, error: "App-accessible operation not found." };
  }
  const grant = await deps.connectionRegistry.grantOf(target.connectionId);
  if (!grant?.grantEpoch || grant.state === "unauthorized") {
    return { ok: false, status: 409, error: "Connection identity is not authorized." };
  }
  return {
    ok: true,
    value: {
      ...target,
      sideEffects: operation.appAccess.sideEffects,
      grantEpoch: grant.grantEpoch,
    },
  };
}
