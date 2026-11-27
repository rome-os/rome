import { z } from "zod";
import type { PreviewPayload } from "@rome-os/app-runtime";
import { actionExecutionContext } from "../apps/actions/context.js";
import { withApprovalPerCall, type Action } from "../apps/actions/types.js";
import type { AppConnectionAccessRepository } from "./app-connection-access.js";
import { appAccessibleOperations, describeAct } from "./app-connections.js";
import type { ConnectionRegistry } from "./registry.js";
import type { OperationDescriptor } from "./types.js";

export const REQUEST_CONNECTION_ACCESS_ACTION = "core:request_connection_access";

export const requestConnectionAccessSchema = z
  .object({
    appId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe('Installed app ID requesting connection access, e.g. "lark".'),
    connectionId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Specific Rome connection ID. Optional when connectionKind uniquely identifies one connected account.",
      ),
    connectionKind: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('Connection kind when connectionId is omitted, e.g. "feishu".'),
    identity: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe("Connection identity (defaults to the connection's primary grant identity)."),
    preset: z
      .enum(["read", "read_and_write", "custom"])
      .optional()
      .describe(
        'Access level to request: "read" (default, all read-only operations), "read_and_write" (read-only plus write operations, which still require per-call approval), or "custom" (explicit operations list).',
      ),
    operations: z
      .array(z.string().trim().min(1).max(128))
      .min(1)
      .max(50)
      .optional()
      .describe('Specific operation names when preset is "custom".'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Short, clear explanation of why the app needs access. Shown on the chat card."),
  })
  .strict()
  .refine((input) => Boolean(input.connectionId || input.connectionKind), {
    message: "Provide either connectionId or connectionKind.",
  })
  .refine((input) => input.preset !== "custom" || (input.operations?.length ?? 0) > 0, {
    message: 'Provide at least one operation when preset is "custom".',
  });

export type RequestConnectionAccessInput = z.infer<typeof requestConnectionAccessSchema>;

export interface AppCatalogLookup {
  (appId: string): { id: string; displayName: string; enabled: boolean } | null;
}

export interface RequestConnectionAccessDeps {
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "grantOf">;
  access: Pick<AppConnectionAccessRepository, "listActiveForConnection" | "putManyIfAppActive">;
  lookupApp: AppCatalogLookup;
  findApproval?: (approvalId: string) => Promise<{ status: string; payload: unknown } | null>;
  isReady?: () => boolean;
}

export interface ResolvedConnectionAccessRequest {
  appId: string;
  appName: string;
  connectionId: string;
  connectionKind: string;
  connectionLabel: string;
  identity: string;
  grantEpoch: string;
  preset: "read" | "read_and_write" | "custom";
  reason: string;
  requestedOperations: readonly OperationDescriptor[];
  missingOperations: readonly OperationDescriptor[];
}

export async function resolveConnectionAccessRequest(
  deps: RequestConnectionAccessDeps,
  rawArgs: unknown,
): Promise<{ ok: true; value: ResolvedConnectionAccessRequest } | { ok: false; error: string }> {
  if (deps.isReady && !deps.isReady()) {
    return {
      ok: false,
      error: "App connection access is unavailable until startup reconciliation completes.",
    };
  }
  const normalizedArgs =
    rawArgs && typeof rawArgs === "object" && "__triggerPayload" in rawArgs
      ? Object.fromEntries(
          Object.entries(rawArgs as Record<string, unknown>).filter(
            ([key]) => key !== "__triggerPayload",
          ),
        )
      : rawArgs;
  const parsed = requestConnectionAccessSchema.safeParse(normalizedArgs);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid connection access request.",
    };
  }
  const input = parsed.data;
  const app = deps.lookupApp(input.appId);
  if (!app || !app.enabled) {
    return { ok: false, error: `App "${input.appId}" is not installed or is disabled.` };
  }

  const allConnections = deps.registry.all();
  let connection = input.connectionId
    ? allConnections.find((item) => item.id === input.connectionId)
    : undefined;
  if (input.connectionId && !connection) {
    return { ok: false, error: `Connection "${input.connectionId}" was not found.` };
  }
  if (!connection && input.connectionKind) {
    const matches = allConnections.filter((item) => item.connectionKind === input.connectionKind);
    if (matches.length === 0) {
      return {
        ok: false,
        error: `No "${input.connectionKind}" connection is connected yet. Ask the guardian to connect it in Settings → Connections first.`,
      };
    }
    if (matches.length > 1) {
      const choices = matches.map((item) => `${item.label} (${item.id})`).join(", ");
      return {
        ok: false,
        error: `Multiple "${input.connectionKind}" connections exist (${choices}). Specify connectionId.`,
      };
    }
    connection = matches[0];
  }
  if (!connection) {
    return { ok: false, error: "Could not resolve a target connection." };
  }

  const descriptor = deps.registry.getDescriptor(connection.connectionKind);
  if (!descriptor) {
    return { ok: false, error: `Connection kind "${connection.connectionKind}" is unavailable.` };
  }
  const identity = input.identity ?? descriptor.grant;
  const grant = await deps.registry.grantOf(connection.id);
  if (!grant?.grantEpoch || grant.state !== "authorized") {
    return {
      ok: false,
      error: `Connection "${connection.label}" needs authorization before apps can access it.`,
    };
  }
  const act = describeAct(connection);
  if (act.state !== "available") {
    return {
      ok: false,
      error: `Connection "${connection.label}" cannot run app operations right now (${act.state}).`,
    };
  }

  const accessible = appAccessibleOperations(deps.registry, connection, identity);
  if (!accessible.ok) {
    return { ok: false, error: accessible.error.message };
  }
  if (accessible.value.length === 0) {
    return {
      ok: false,
      error: `Connection "${connection.label}" does not expose app-accessible operations.`,
    };
  }

  const preset: "read" | "read_and_write" | "custom" =
    input.preset ?? (input.operations?.length ? "custom" : "read");
  const byName = new Map(accessible.value.map((op) => [op.name, op]));
  let requestedOperations: OperationDescriptor[];

  if (preset === "custom" || input.operations?.length) {
    const names = [...new Set(input.operations ?? [])];
    const unknown = names.filter((name) => !byName.has(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Unknown or unsupported operations for "${connection.label}": ${unknown.join(", ")}.`,
      };
    }
    requestedOperations = names.map((name) => byName.get(name)!);
  } else if (preset === "read") {
    requestedOperations = accessible.value.filter(
      (op) => op.appAccess?.sideEffects === "read-only",
    );
  } else {
    requestedOperations = [...accessible.value];
  }

  if (requestedOperations.length === 0) {
    return {
      ok: false,
      error: `Connection "${connection.label}" has no matching operations for preset "${preset}".`,
    };
  }

  const existing = await deps.access.listActiveForConnection(app.id, connection.id);
  const grantedNames = new Set(
    existing
      .filter((policy) => policy.identity === identity && policy.grantEpoch === grant.grantEpoch)
      .map((policy) => policy.operation),
  );
  const missingOperations = requestedOperations.filter((op) => !grantedNames.has(op.name));

  return {
    ok: true,
    value: {
      appId: app.id,
      appName: app.displayName || app.id,
      connectionId: connection.id,
      connectionKind: connection.connectionKind,
      connectionLabel: connection.label,
      identity,
      grantEpoch: grant.grantEpoch,
      preset,
      reason: input.reason,
      requestedOperations,
      missingOperations,
    },
  };
}

const connectionAccessPreviewSchema = z.object({
  kind: z.literal("connection_access"),
  appId: z.string().min(1),
  connectionId: z.string().min(1),
  identity: z.string().min(1),
  grantEpoch: z.string().min(1).optional(),
  operations: z.array(
    z.object({
      name: z.string().min(1),
      sideEffect: z.enum(["read-only", "write"]),
      approvalRequired: z.boolean().optional(),
    }),
  ),
});

export type ConnectionAccessPreviewSnapshot = z.infer<typeof connectionAccessPreviewSchema>;

export function extractConnectionAccessPreview(
  payload: unknown,
): ConnectionAccessPreviewSnapshot | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const preview = (payload as { preview?: unknown }).preview;
  const parsed = connectionAccessPreviewSchema.safeParse(preview);
  return parsed.success ? parsed.data : null;
}

export function matchesConnectionAccessPreview(
  resolved: ResolvedConnectionAccessRequest,
  preview: ConnectionAccessPreviewSnapshot,
): boolean {
  if (
    preview.appId !== resolved.appId ||
    preview.connectionId !== resolved.connectionId ||
    preview.identity !== resolved.identity
  ) {
    return false;
  }
  if (preview.grantEpoch !== undefined && preview.grantEpoch !== resolved.grantEpoch) {
    return false;
  }
  const previewByName = new Map(preview.operations.map((op) => [op.name, op]));
  for (const actual of resolved.missingOperations) {
    const expected = previewByName.get(actual.name);
    if (
      !expected ||
      expected.sideEffect !== actual.appAccess?.sideEffects ||
      Boolean(expected.approvalRequired) !== Boolean(actual.appAccess?.approvalRequired)
    ) {
      return false;
    }
  }
  return true;
}

export async function grantConnectionAccessOperations(
  deps: RequestConnectionAccessDeps,
  resolved: ResolvedConnectionAccessRequest,
  options: { expiresAt?: Date | null } = {},
): Promise<{ ok: true; grantedOperations: string[] } | { ok: false; error: string }> {
  const written = await deps.access.putManyIfAppActive(
    resolved.appId,
    resolved.missingOperations.map((op) => {
      const sideEffects = op.appAccess!.sideEffects;
      return {
        connectionId: resolved.connectionId,
        identity: resolved.identity,
        operation: op.name,
        sideEffects,
        approval: sideEffects === "write" ? "required" : "not_required",
        constraints: [],
        grantEpoch: resolved.grantEpoch,
        expiresAt: options.expiresAt ?? null,
        // Chat approvals never disclose or overwrite existing resource allowlists
        // or shorten/extend an active expiry carried over across a reconnect.
        preserveExistingConstraints: true,
        preserveExistingExpiry: true,
      };
    }),
    () => {
      const app = deps.lookupApp(resolved.appId);
      return Boolean(app && app.enabled);
    },
  );
  if (!written) {
    return {
      ok: false,
      error: `Could not grant connection access to "${resolved.appId}".`,
    };
  }
  return { ok: true, grantedOperations: written.map((policy) => policy.operation) };
}

function buildPreview(resolved: ResolvedConnectionAccessRequest): PreviewPayload {
  const readCount = resolved.missingOperations.filter(
    (op) => op.appAccess?.sideEffects === "read-only",
  ).length;
  const writeCount = resolved.missingOperations.length - readCount;
  const scopeDesc =
    writeCount > 0 && readCount > 0
      ? `${readCount} read and ${writeCount} write operations`
      : writeCount > 0
        ? `${writeCount} write operation${writeCount === 1 ? "" : "s"}`
        : `${readCount} read operation${readCount === 1 ? "" : "s"}`;

  return {
    kind: "connection_access",
    appId: resolved.appId,
    appName: resolved.appName,
    connectionId: resolved.connectionId,
    connectionKind: resolved.connectionKind,
    connectionLabel: resolved.connectionLabel,
    identity: resolved.identity,
    grantEpoch: resolved.grantEpoch,
    preset: resolved.preset,
    operations: resolved.missingOperations.map((op) => ({
      name: op.name,
      sideEffect: op.appAccess!.sideEffects,
      ...(op.description ? { summary: op.description } : {}),
      ...(op.appAccess!.approvalRequired ? { approvalRequired: true } : {}),
    })),
    reason: resolved.reason,
    title: `Allow ${resolved.appName} to access ${resolved.connectionLabel}`,
    summary: `${resolved.reason} (${scopeDesc})`,
  };
}

export function createRequestConnectionAccessAction(deps: RequestConnectionAccessDeps): Action {
  return withApprovalPerCall({
    config: {
      name: REQUEST_CONNECTION_ACCESS_ACTION,
      type: "system",
      description:
        "Request guardian approval in chat to grant an installed App (such as lark) access to a connected Rome service (such as feishu). Sends an authorization card so the guardian can approve with one click instead of manually configuring permissions in Settings. Use preset 'read' (default) for read-only access or 'read_and_write' when writes are also needed (write calls still ask per-call approval). After approval, retry the app action immediately.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
      requiresApproval: true,
    },
    inputSchema: z.toJSONSchema(requestConnectionAccessSchema),
    preview: async (args) => {
      const resolved = await resolveConnectionAccessRequest(deps, args);
      if (!resolved.ok) throw new Error(resolved.error);
      if (resolved.value.missingOperations.length === 0) return undefined;
      return buildPreview(resolved.value);
    },
    execute: async (args) => {
      const resolved = await resolveConnectionAccessRequest(deps, args);
      if (!resolved.ok) return { status: "error", error: resolved.error };
      const allRequested = resolved.value.requestedOperations.map((op) => op.name);
      if (resolved.value.missingOperations.length === 0) {
        return {
          status: "ok",
          data: {
            appId: resolved.value.appId,
            connectionId: resolved.value.connectionId,
            connectionKind: resolved.value.connectionKind,
            identity: resolved.value.identity,
            grantedOperations: allRequested,
            alreadyGranted: true,
          },
        };
      }
      const initiator = actionExecutionContext.getStore()?.initiator;
      if (!initiator?.startsWith("approval:")) {
        return {
          status: "error",
          error: "Granting app connection access requires guardian approval.",
        };
      }
      if (deps.findApproval) {
        const approvalId = initiator.slice("approval:".length);
        const approval = await deps.findApproval(approvalId);
        const preview = extractConnectionAccessPreview(approval?.payload);
        if (
          approval?.status !== "approved" ||
          !preview ||
          !matchesConnectionAccessPreview(resolved.value, preview)
        ) {
          return {
            status: "error",
            error:
              "This connection access request changed after it was created. Please request access again.",
          };
        }
      }
      const granted = await grantConnectionAccessOperations(deps, resolved.value);
      if (!granted.ok) return { status: "error", error: granted.error };
      return {
        status: "ok",
        data: {
          appId: resolved.value.appId,
          connectionId: resolved.value.connectionId,
          connectionKind: resolved.value.connectionKind,
          identity: resolved.value.identity,
          grantedOperations: allRequested,
          newlyGranted: granted.grantedOperations,
          alreadyGranted: false,
        },
      };
    },
  });
}
