import { Hono, type Context } from "hono";
import { isDeepStrictEqual } from "node:util";
import type {
  AppConnectionAccessAuditPage,
  AppConnectionAccessPolicyDto,
  AppConnectionScopeCheck,
  ConnectionAppAccessDto,
} from "@rome/api-types/app-connection-access";
import { z } from "zod";
import { isResolvedApp } from "../../apps/state.js";
import type { AppConnectionAccessRecord } from "../../connections/app-connection-access.js";
import { CredentialRejected, ProviderOperationError } from "../../connections/errors.js";
import type { GrantValue } from "../../connections/grant.js";
import type { OperationDescriptor } from "../../connections/types.js";
import { appAccessibleOperations, describeAct } from "../../connections/app-connections.js";
import type { ApiDeps } from "../deps.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";

const ConstraintSchema = z
  .object({
    inputPointer: z.string().refine((value) => value === "" || value.startsWith("/")),
    allowedValues: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(100),
  })
  .strict();

const ConnectionPutSchema = z
  .object({
    appId: z.string().min(1),
    identity: z.string().min(1),
    operation: z.string().min(1),
    expectedRevision: z.int().nonnegative().optional(),
    approvalMode: z.enum(["required", "not_required"]).optional(),
    constraints: z.array(ConstraintSchema).max(20).default([]),
  })
  .strict();

const ConnectionAuditQuery = z.strictObject({
  appId: z.string().min(1).optional(),
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const ScopeResult = z.object({
  scopes: z.array(
    z.object({ scopeName: z.string(), grantStatus: z.int(), scopeType: z.string().optional() }),
  ),
  checkedAt: z.iso.datetime({ offset: true }),
});

function grantStatus(
  policy: AppConnectionAccessRecord,
  grant: GrantValue | null | undefined,
): AppConnectionAccessPolicyDto["grantStatus"] {
  if (grant?.grantEpoch === policy.grantEpoch) return "current";
  if (grant?.state === "unauthorized") return "authorization_required";
  return grant ? "replaced" : "unavailable";
}

function policyDto(
  policy: AppConnectionAccessRecord,
  grant: GrantValue | null | undefined,
): AppConnectionAccessPolicyDto {
  return {
    appId: policy.appId,
    connectionId: policy.connectionId,
    identity: policy.identity,
    operation: policy.operation,
    sideEffect: policy.sideEffects,
    approvalMode: policy.approval,
    constraints: policy.constraints,
    revision: policy.revision,
    grantStatus: grantStatus(policy, grant),
    expiresAt: policy.expiresAt?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

export function appConnectionAccessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const repo = deps.appConnectionAccessRepo;

  app.get("/app-connection-access/connections/:connectionId", async (c) => {
    const registry = deps.connectionRegistry;
    if (!registry) return c.json({ error: "Connections are unavailable." }, 503);
    const id = c.req.param("connectionId");
    const connection = registry.all().find((conn) => conn.id === id);
    if (!connection) return c.json({ error: "Connection not found." }, 404);
    const descriptor = registry.getDescriptor(connection.connectionKind);
    const [grant, policies] = await Promise.all([
      registry.grantOf(id),
      repo.listActiveForConnectionId(id),
    ]);
    const ops = descriptor && appAccessibleOperations(registry, connection, descriptor.grant);
    const detail: ConnectionAppAccessDto = {
      connection: {
        connectionId: id,
        connectionKind: connection.connectionKind,
        label: connection.label,
      },
      identities: descriptor
        ? [
            {
              identity: descriptor.grant,
              actState: describeAct(connection).state,
              providerGuidance: descriptor.appAccessGuidance?.(grant?.profile),
              operations: ops?.ok
                ? ops.value.map((op) => ({
                    name: op.name,
                    sideEffect: op.appAccess!.sideEffects,
                    summary: op.description,
                    requiredScopes: op.appAccess!.requiredScopes,
                    requiredScopeGroups: op.appAccess!.requiredScopeGroups,
                    resourceConstraintKind: op.appAccess!.resourceConstraintKind,
                    approvalPreviewSummary: op.appAccess!.approvalPreview?.summary,
                  }))
                : [],
            },
          ]
        : [],
      policies: policies.map((policy) => policyDto(policy, grant)),
    };
    return c.json(detail);
  });

  app.post("/app-connection-access/connections/:connectionId/scopes/check", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
    const reply = (status: AppConnectionScopeCheck["status"], errorCode?: string) =>
      c.json({
        status,
        checkedAt: new Date().toISOString(),
        errorCode,
      } satisfies AppConnectionScopeCheck);
    const registry = deps.connectionRegistry;
    if (!registry) return reply("unavailable");
    const id = c.req.param("connectionId");
    const connection = registry.all().find((conn) => conn.id === id);
    if (!connection) return c.json({ error: "Connection not found." }, 404);
    const descriptor = registry.getDescriptor(connection.connectionKind);
    const grant = await registry.grantOf(id);
    const name = descriptor?.appAccessGuidance?.(grant?.profile).scopeCheckOperation;
    if (!name) return reply("unsupported");
    const isCheck = (op: OperationDescriptor) =>
      op.name === name && op.appAccess?.sideEffects === "read-only";
    if (!descriptor?.capabilities.actor?.operations?.some(isCheck)) return reply("unsupported");
    const act = connection.act;
    if (!act || grant?.state !== "authorized") return reply("unavailable");
    try {
      if (!act.operations().some(isCheck)) return reply("unsupported");
      const result = ScopeResult.safeParse(await act.invoke({ operation: name, input: {} }));
      if (!result.success) return reply("error", "provider_response_invalid");
      const current = await registry.grantOf(id);
      if (current?.state !== "authorized" || current.grantEpoch !== grant.grantEpoch)
        return reply("unavailable");
      return c.json({ status: "checked", ...result.data } satisfies AppConnectionScopeCheck);
    } catch (error) {
      if (error instanceof CredentialRejected)
        return reply("unavailable", "authorization_required");
      return reply(
        "error",
        error instanceof ProviderOperationError ? error.reason : "provider_unavailable",
      );
    }
  });

  app.get("/app-connection-access/connections/:connectionId/audit", async (c) => {
    const query = ConnectionAuditQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid pagination." }, 400);
    const page = await repo.listAuditForConnection(c.req.param("connectionId"), query.data);
    return c.json({
      entries: page.entries.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextBeforeSeq: page.nextBeforeSeq,
    } satisfies AppConnectionAccessAuditPage);
  });

  app.put("/app-connection-access/connections/:connectionId/policies", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
    const parsed = ConnectionPutSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid access policy." }, 400);
    const { appId, identity, operation, ...policy } = parsed.data;
    return putPolicy(
      c,
      deps,
      { appId, identity, operation, connectionId: c.req.param("connectionId") },
      policy,
    );
  });

  app.delete(
    "/app-connection-access/connections/:connectionId/policies/:appId/:identity/:operation",
    async (c) => {
      if (!isSameOriginMutationRequest(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
      const target = c.req.param();
      const revoked = await repo.revoke(
        target.appId,
        target.connectionId,
        target.identity,
        target.operation,
      );
      return revoked ? c.body(null, 204) : c.json({ error: "Access policy not found." }, 404);
    },
  );

  return app;
}

type PolicyTarget = { appId: string; connectionId: string; identity: string; operation: string };

async function putPolicy(
  c: Context,
  deps: ApiDeps,
  key: PolicyTarget,
  policyInput: Pick<
    z.infer<typeof ConnectionPutSchema>,
    "approvalMode" | "constraints" | "expectedRevision"
  >,
) {
  const target = await resolveTarget(deps, key);
  if (!target.ok) return c.json({ error: target.error }, target.status);
  const access = target.value.access;
  const approval =
    policyInput.approvalMode ?? (access.sideEffects === "write" ? "required" : "not_required");
  const editable = (rule: z.infer<typeof ConstraintSchema>) =>
    access.resourceConstraintKind === "documentIds" && rule.inputPointer === "/documentId";
  const policy = await deps.appConnectionAccessRepo.putIfAppActive(
    {
      appId: target.value.appId,
      connectionId: target.value.connectionId,
      identity: target.value.identity,
      operation: target.value.operation,
      sideEffects: target.value.access.sideEffects,
      approval,
      expectedRevision: policyInput.expectedRevision,
      constraints: policyInput.constraints,
      expiresAt: null,
      grantEpoch: target.value.grantEpoch,
    },
    () => {
      const app = deps.appCatalog.get(target.value.appId);
      return isResolvedApp(app) && app.enabled;
    },
    (existing) => {
      const incoming = policyInput.constraints;
      if (isDeepStrictEqual(existing, incoming)) return true;
      return (
        isDeepStrictEqual(
          existing.filter((r) => !editable(r)),
          incoming.filter((r) => !editable(r)),
        ) &&
        incoming
          .filter(editable)
          .every((r) =>
            r.allowedValues.every(
              (id) => typeof id === "string" && /^[a-zA-Z0-9]{1,128}$/.test(id),
            ),
          )
      );
    },
  );
  if (policy === "policy_conflict")
    return c.json(
      { error: policy, message: "The access policy changed. Refresh and try again." },
      409,
    );
  if (policy === "unsupported_constraints")
    return c.json({ error: "Unsupported resource constraint." }, 400);
  if (!policy) return c.json({ error: "App not found or disabled." }, 409);
  return c.json({ policy: policyDto(policy, target.value.grant) });
}

async function resolveTarget(
  deps: ApiDeps,
  target: PolicyTarget,
): Promise<
  | {
      ok: true;
      value: typeof target & {
        access: NonNullable<OperationDescriptor["appAccess"]>;
        grant: GrantValue;
        grantEpoch: string;
      };
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
      access: operation.appAccess,
      grant,
      grantEpoch: grant.grantEpoch,
    },
  };
}
