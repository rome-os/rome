import { createHash, randomUUID } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  Action,
  AppConnectionDescription,
  AppConnectionErrorBody,
  AppConnectionInvokeResult,
  AppConnectionOperation,
  AppConnectionOperationsPage,
  AppConnectionPage,
  AppConnectionResourceConstraint,
  AppConnectionsCapability,
} from "@rome-os/app-runtime";
import { AppConnectionError } from "@rome-os/app-runtime";
import type { ActionEngine, ActionRunContext } from "../actions/engine.js";
import type { ActionRegistryImpl } from "../actions/registry.js";
import { actionExecutionContext } from "../actions/context.js";
import type { CatalogEvent } from "../apps/state.js";
import type {
  AppConnectionAccessRecord,
  AppConnectionAccessRepository,
  AppConnectionInvocationRecord,
} from "../db/repositories/app-connection-access.js";
import type { GrantValue } from "./grant.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Connection, OperationDescriptor, ProfileDisplay } from "./types.js";

const READ_ACTION = "core:app_connection_read";
export const APP_CONNECTION_WRITE_ACTION = "core:app_connection_write";
const APPROVED_WRITE_ACTION = "core:app_connection_write_without_approval";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_INVOKE_LIMIT = 120;
const DEFAULT_RATE_WINDOW_MS = 60_000;
export const APP_CONNECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type BrokerActionMode = "read" | "write" | "write_without_approval";

export type AppConnectionBrokerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppConnectionErrorBody };

export type AppConnectionInvocationContext = Pick<
  ActionRunContext,
  | "actor"
  | "channelContext"
  | "sharedContext"
  | "sessionId"
  | "turnId"
  | "agentName"
  | "channelThreadKey"
>;

export interface AppConnectionBrokerPort {
  list(
    appId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<AppConnectionBrokerResult<AppConnectionPage>>;
  describe(
    appId: string,
    input: { connectionId: string; identity: string },
  ): Promise<AppConnectionBrokerResult<AppConnectionDescription>>;
  operations(
    appId: string,
    input: { connectionId: string; identity: string; cursor?: string; limit?: number },
  ): Promise<AppConnectionBrokerResult<AppConnectionOperationsPage>>;
  invoke(
    appId: string,
    input: {
      connectionId: string;
      identity: string;
      operation: string;
      input?: unknown;
      requestId?: string;
    },
    context?: AppConnectionInvocationContext,
  ): Promise<AppConnectionBrokerResult<AppConnectionInvokeResult>>;
}

export interface AppConnectionsContextFactory {
  forApp(appId: string): AppConnectionsCapability;
}

function failure(
  code: AppConnectionErrorBody["code"],
  message: string,
  retryable = false,
): AppConnectionBrokerResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

function brokerUnavailable(): AppConnectionBrokerResult<never> {
  return failure(
    "capability_unavailable",
    "App connection access is unavailable until App startup reconciliation succeeds.",
  );
}

export function createAppConnectionAccessLifecycle(
  access: Pick<AppConnectionAccessRepository, "revokeApp">,
): (event: CatalogEvent) => Promise<void> {
  return async (event) => {
    if (event.change === "removed" || (event.current !== null && !event.current.enabled)) {
      await access.revokeApp(event.appId);
    }
  };
}

export async function reconcileAppConnectionAccess(
  catalog: { get(appId: string): { enabled: boolean } | null },
  access: Pick<AppConnectionAccessRepository, "listUnrevokedAppIds" | "revokeApp">,
): Promise<void> {
  for (const appId of await access.listUnrevokedAppIds()) {
    const current = catalog.get(appId);
    if (!current || !current.enabled) await access.revokeApp(appId);
  }
}

function expose<T>(result: AppConnectionBrokerResult<T>): T {
  if (!result.ok) throw new AppConnectionError(result.error);
  return result.value;
}

export class BoundAppConnections implements AppConnectionsCapability {
  constructor(
    private readonly appId: string,
    private readonly broker: AppConnectionBrokerPort,
  ) {}

  async list(input?: { cursor?: string; limit?: number }): Promise<AppConnectionPage> {
    return expose(await this.broker.list(this.appId, input));
  }

  async describe(input: {
    connectionId: string;
    identity: string;
  }): Promise<AppConnectionDescription> {
    return expose(await this.broker.describe(this.appId, input));
  }

  async operations(input: {
    connectionId: string;
    identity: string;
    cursor?: string;
    limit?: number;
  }): Promise<AppConnectionOperationsPage> {
    return expose(await this.broker.operations(this.appId, input));
  }

  async invoke<T = unknown>(input: {
    connectionId: string;
    identity: string;
    operation: string;
    input?: unknown;
    requestId?: string;
  }): Promise<AppConnectionInvokeResult<T>> {
    return expose(await this.broker.invoke(this.appId, input)) as AppConnectionInvokeResult<T>;
  }
}

export class DeniedAppConnections implements AppConnectionsCapability {
  private denied(): never {
    throw new AppConnectionError({
      code: "access_denied",
      message: "This App has no connection access.",
      retryable: false,
    });
  }

  async list(): Promise<AppConnectionPage> {
    return this.denied();
  }
  async describe(): Promise<AppConnectionDescription> {
    return this.denied();
  }
  async operations(): Promise<AppConnectionOperationsPage> {
    return this.denied();
  }
  async invoke<T = unknown>(): Promise<AppConnectionInvokeResult<T>> {
    return this.denied();
  }
}

export class AppConnectionBroker implements AppConnectionBrokerPort, AppConnectionsContextFactory {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validators = new WeakMap<Record<string, unknown>, ValidateFunction>();
  private readonly invokeWindows = new Map<
    string,
    { startedAt: number; count: number; denialAudited: boolean }
  >();
  private readonly invokeLimit: number;
  private readonly rateWindowMs: number;
  private readonly now: () => number;
  private readonly isReady: () => boolean;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly access: AppConnectionAccessRepository,
    private readonly actionEngine: ActionEngine,
    options: {
      invokeLimit?: number;
      rateWindowMs?: number;
      now?: () => number;
      isReady?: () => boolean;
    } = {},
  ) {
    this.invokeLimit = options.invokeLimit ?? DEFAULT_INVOKE_LIMIT;
    this.rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.isReady = options.isReady ?? (() => true);
  }

  forApp(appId: string): AppConnectionsCapability {
    return new BoundAppConnections(appId, this);
  }

  registerActions(registry: ActionRegistryImpl): void {
    registry.register(this.action(READ_ACTION, "read", false));
    registry.register(this.action(APP_CONNECTION_WRITE_ACTION, "write", true));
    registry.register(this.action(APPROVED_WRITE_ACTION, "write_without_approval", false));
  }

  async list(
    appId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<AppConnectionBrokerResult<AppConnectionPage>> {
    if (!this.isReady()) return brokerUnavailable();
    const page = parsePage(input);
    if (!page.ok) return page;
    const ids = await this.access.listActiveConnectionIds(
      appId,
      page.value.after,
      page.value.limit + 1,
    );
    const byId = new Map(this.registry.all().map((connection) => [connection.id, connection]));
    const hasMore = ids.length > page.value.limit;
    const selected = ids.slice(0, page.value.limit);
    return {
      ok: true,
      value: {
        connections: selected.flatMap((id) => {
          const connection = byId.get(id);
          const identity = connection
            ? this.registry.getDescriptor(connection.connectionKind)?.grant
            : undefined;
          return connection && identity ? [summary(connection, identity)] : [];
        }),
        ...(hasMore ? { nextCursor: Buffer.from(selected.at(-1)!).toString("base64url") } : {}),
      },
    };
  }

  async describe(
    appId: string,
    input: { connectionId: string; identity: string },
  ): Promise<AppConnectionBrokerResult<AppConnectionDescription>> {
    if (!this.isReady()) return brokerUnavailable();
    const policies = await this.access.listActiveForConnection(appId, input.connectionId);
    const grant = await this.registry.grantOf(input.connectionId);
    if (
      !grant ||
      !policies.some(
        (policy) => policy.connectionId === input.connectionId && policyMatchesGrant(policy, grant),
      )
    ) {
      return failure("connection_not_found", "The connection is not visible to this App.");
    }
    const connection = this.findConnection(input.connectionId);
    if (!connection) return failure("connection_not_found", "The connection is unavailable.");
    if (
      !policies.some(
        (policy) =>
          policy.connectionId === input.connectionId &&
          policy.identity === input.identity &&
          policyMatchesGrant(policy, grant),
      )
    ) {
      return failure("identity_not_found", "The identity is not visible to this App.");
    }
    const identity = this.describeIdentity(connection, input.identity, grant);
    if (!identity.ok) return identity;
    return {
      ok: true,
      value: {
        connection: summary(connection, input.identity),
        identity: identity.value,
        act: describeAct(connection),
      },
    };
  }

  async operations(
    appId: string,
    input: { connectionId: string; identity: string; cursor?: string; limit?: number },
  ): Promise<AppConnectionBrokerResult<AppConnectionOperationsPage>> {
    if (!this.isReady()) return brokerUnavailable();
    const page = parsePage(input);
    if (!page.ok) return page;
    const described = await this.describe(appId, input);
    if (!described.ok) return described;
    const connection = this.findConnection(input.connectionId)!;
    const supported = this.supportedOperations(connection, input.identity);
    if (!supported.ok) return supported;
    const policies = await this.access.listActiveForConnection(appId, input.connectionId);
    const grant = await this.registry.grantOf(input.connectionId);
    const byOperation = new Map(
      policies
        .filter(
          (policy) =>
            policy.connectionId === input.connectionId &&
            policy.identity === input.identity &&
            policyMatchesGrant(policy, grant),
        )
        .map((policy) => [policy.operation, policy]),
    );
    const operations = supported.value
      .map((operation): AppConnectionOperation => {
        const candidate = byOperation.get(operation.name);
        const policy =
          candidate?.sideEffects === operation.appAccess!.sideEffects ? candidate : undefined;
        return {
          name: operation.name,
          description: operation.description,
          inputSchema: structuredClone(operation.inputSchema),
          ...(operation.outputSchema
            ? { outputSchema: structuredClone(operation.outputSchema) }
            : {}),
          sideEffects: operation.appAccess!.sideEffects,
          access: policy ? "granted" : "not_granted",
          approval:
            policy?.approval ??
            (operation.appAccess!.sideEffects === "read-only" ? "not_required" : "required"),
          constraints: policy?.constraints ?? [],
        };
      })
      .sort((a, b) => compareStrings(a.name, b.name));
    return { ok: true, value: paginateOperations(operations, page.value) };
  }

  async invoke(
    appId: string,
    input: {
      connectionId: string;
      identity: string;
      operation: string;
      input?: unknown;
      requestId?: string;
    },
    context?: AppConnectionInvocationContext,
  ): Promise<AppConnectionBrokerResult<AppConnectionInvokeResult>> {
    if (!this.isReady()) return brokerUnavailable();
    const invocationId = randomUUID();
    let requestIdHash: string | null = null;
    let policy: AppConnectionAccessRecord | null = null;
    const denied = async (result: AppConnectionBrokerResult<never>) => {
      await this.access.appendAudit({
        appId,
        connectionId: auditKey(input.connectionId),
        identity: auditKey(input.identity),
        operation: auditKey(input.operation),
        accessRevision: policy?.revision,
        approval: "not_required",
        executionId: invocationId,
        requestIdHash,
        status: result.ok ? "denied" : result.error.code,
      });
      return result;
    };
    const rate = this.takeInvokeSlot(appId);
    if (!rate.allowed) {
      const result = failure("rate_limited", "The App connection rate limit was reached.", true);
      return rate.auditDenial ? await denied(result) : result;
    }
    if (![input.connectionId, input.identity, input.operation].every(validKey)) {
      return await denied(failure("invalid_input", "Connection identifiers are invalid."));
    }
    const connection = this.findConnection(input.connectionId);
    policy = await this.access.get(appId, input.connectionId, input.identity, input.operation);
    const activePolicy = policy && isActive(policy) ? policy : null;
    if (!activePolicy)
      return await denied(failure("access_denied", "The operation is not granted."));
    if (!connection) {
      return await denied(failure("connection_not_found", "The connection is unavailable."));
    }
    const grant = await this.registry.grantOf(connection.id);
    if (!policyMatchesGrant(activePolicy, grant)) {
      return await denied(failure("access_denied", "The operation is not granted."));
    }
    if (grant?.state === "unauthorized") {
      return await denied(failure("authorization_required", "The connection needs authorization."));
    }
    if (grant?.state === "degraded") {
      return await denied(failure("connection_unhealthy", "The connection is not healthy."));
    }
    const supported = this.supportedOperations(connection, input.identity);
    if (!supported.ok) return await denied(supported);
    const operation = supported.value.find((candidate) => candidate.name === input.operation);
    if (!operation) {
      return await denied(failure("operation_not_found", "The operation is not App-accessible."));
    }
    const sideEffects = operation.appAccess!.sideEffects;
    if (activePolicy.sideEffects !== sideEffects) {
      return await denied(failure("access_denied", "The operation access classification changed."));
    }
    if (sideEffects === "read-only" && activePolicy.approval === "required") {
      return await denied(
        failure("access_denied", "Read operations cannot use deferred approval."),
      );
    }
    if (sideEffects === "write" && input.requestId === undefined) {
      return await denied(
        failure("request_id_required", "Write operations require a stable requestId."),
      );
    }
    if (
      sideEffects === "write" &&
      input.requestId !== undefined &&
      !validRequestId(input.requestId)
    ) {
      return await denied(failure("invalid_input", "The requestId is invalid."));
    }
    requestIdHash = sideEffects === "write" && input.requestId ? digest(input.requestId) : null;
    const normalized = normalizeJsonInput(input.input ?? null, MAX_INPUT_BYTES);
    if (!normalized.ok) return await denied(normalized);
    const validation = this.validateInput(operation, normalized.value.input);
    if (!validation.ok) return await denied(validation);
    const constrained = enforceConstraints(normalized.value.input, activePolicy.constraints);
    if (!constrained.ok) return await denied(constrained);

    const stored = this.access.createOrGetInvocation({
      id: invocationId,
      appId,
      connectionId: input.connectionId,
      identity: input.identity,
      operation: input.operation,
      requestIdHash,
      inputHash: digest(normalized.value.canonical),
      input: normalized.value.input,
      sideEffects,
      accessRevision: activePolicy.revision,
    });
    if (!stored.created)
      return this.duplicate(stored.invocation, normalized.value.canonical, input);

    const actionName = actionFor(sideEffects, activePolicy.approval);
    if (activePolicy.approval === "required") {
      const pending = await this.access.transitionInvocation(
        invocationId,
        ["ready"],
        "pending_approval",
      );
      if (!pending) {
        return failure("request_in_progress", "The request is already in progress.", true);
      }
    }
    let result;
    try {
      result = await this.actionEngine.run(
        actionName,
        { invocationId },
        {
          executionId: invocationId,
          actor: context?.actor,
          channelContext: context?.channelContext,
          sharedContext: context?.sharedContext,
          sessionId: context?.sessionId,
          turnId: context?.turnId,
          agentName: context?.agentName,
          channelThreadKey: context?.channelThreadKey,
          initiator: `app:${appId}`,
          callerAppId: appId,
        },
      );
    } catch {
      return await this.finishEngineFailure(
        stored.invocation,
        activePolicy.approval === "required" ? "pending" : "not_required",
      );
    }
    if (result.status === "pending_approval") {
      await this.audit(stored.invocation, "pending", "pending_approval");
      return {
        ok: true,
        value: {
          status: "pending_approval",
          executionId: invocationId,
          approval: result.approval,
        },
      };
    }
    if (result.status !== "ok" || !isBrokerResult(result.data)) {
      return await this.finishEngineFailure(
        stored.invocation,
        activePolicy.approval === "required" ? "pending" : "not_required",
      );
    }
    return result.data;
  }

  async approvalRejected(actionName: string, args: Record<string, unknown>): Promise<void> {
    if (actionName !== APP_CONNECTION_WRITE_ACTION || typeof args.invocationId !== "string") {
      return;
    }
    const invocation = await this.access.getInvocation(args.invocationId);
    if (!invocation) return;
    const rejected = await this.access.transitionInvocation(
      invocation.id,
      ["pending_approval"],
      "rejected",
      "approval_rejected",
      true,
    );
    if (!rejected) return;
    await this.audit(invocation, "rejected", "approval_rejected");
  }

  private action(name: string, mode: BrokerActionMode, requiresApproval: boolean): Action {
    const effect = mode.startsWith("read") ? "read-only" : "write";
    return {
      config: {
        name,
        type: "system",
        description: "Run one App connection operation through the Core broker.",
        visibility: "explicit",
        complexity: "simple",
        speed: "moderate",
        reliability: "high",
        sideEffects: effect,
        requiresApproval,
      },
      execute: async (args) => {
        if (typeof args.invocationId !== "string") {
          return { status: "error", error: "Missing connection invocation id." };
        }
        const result = await this.execute(args.invocationId, mode);
        if (mode === "write") {
          if (!result.ok) return { status: "error", error: result.error.message };
          if (result.value.status === "outcome_unknown") {
            return {
              status: "error",
              error: "The provider outcome is unknown. Do not retry this request.",
            };
          }
        }
        return { status: "ok", data: result };
      },
      preview: async (args) => await this.preview(args),
    };
  }

  private async execute(
    invocationId: string,
    mode: BrokerActionMode,
  ): Promise<AppConnectionBrokerResult<AppConnectionInvokeResult>> {
    if (!this.isReady()) return brokerUnavailable();
    const expectedEffect = mode.startsWith("read") ? "read-only" : "write";
    const expectedApproval = mode === "write";
    const expectedStatus = expectedApproval ? "pending_approval" : "ready";
    const executionApproval = expectedApproval ? "approved" : "not_required";
    const invocation = await this.access.getInvocation(invocationId);
    if (!invocation || invocation.sideEffects !== expectedEffect) {
      return failure("access_denied", "The connection invocation is invalid.");
    }
    const callerAppId = actionExecutionContext.getStore()?.callerAppId;
    if (callerAppId && callerAppId !== invocation.appId) {
      return failure("access_denied", "The connection invocation belongs to another App.");
    }
    if (invocation.status !== expectedStatus) {
      return failure("access_denied", "The connection invocation is not runnable.");
    }
    const connection = this.findConnection(invocation.connectionId);
    if (!connection) {
      return await this.failUnclaimedInvocation(
        invocation,
        expectedStatus,
        executionApproval,
        "connection_not_found",
      );
    }
    const supported = this.supportedOperations(connection, invocation.identity);
    if (!supported.ok) {
      return await this.failUnclaimedInvocation(
        invocation,
        expectedStatus,
        executionApproval,
        supported.error.code,
      );
    }
    const descriptor = supported.value.find((entry) => entry.name === invocation.operation);
    if (!descriptor || descriptor.appAccess?.sideEffects !== expectedEffect) {
      return await this.failUnclaimedInvocation(
        invocation,
        expectedStatus,
        executionApproval,
        "operation_not_found",
      );
    }
    const grantBeforeClaim = await this.registry.grantOf(connection.id);
    if (!grantBeforeClaim || grantBeforeClaim.state === "unauthorized") {
      return await this.failUnclaimedInvocation(
        invocation,
        expectedStatus,
        executionApproval,
        "authorization_required",
      );
    }
    if (grantBeforeClaim.state === "degraded") {
      return await this.failUnclaimedInvocation(
        invocation,
        expectedStatus,
        executionApproval,
        "connection_unhealthy",
      );
    }
    const claimed = this.access.claimInvocationWithPolicy(
      invocation,
      expectedStatus,
      expectedApproval ? "required" : "not_required",
    );
    if (!claimed) {
      return await this.failUnclaimedInvocation(
        invocation,
        expectedStatus,
        executionApproval,
        "access_denied",
        "Connection access changed before execution.",
      );
    }
    const fail = (code: AppConnectionErrorBody["code"], retryable = false) =>
      this.failInvocation(invocation, code, retryable, executionApproval);
    const policy = await this.access.get(
      invocation.appId,
      invocation.connectionId,
      invocation.identity,
      invocation.operation,
    );
    if (!policy) return await fail("access_denied");
    const validation = this.validateInput(descriptor, invocation.input);
    if (!validation.ok) return await fail(validation.error.code);
    const constrained = enforceConstraints(invocation.input, policy.constraints);
    if (!constrained.ok) return await fail(constrained.error.code);
    const grant = await this.registry.grantOf(connection.id);
    if (!grant || grant.state === "unauthorized") {
      return await fail("authorization_required");
    }
    if (grant.state === "degraded") {
      return await fail("connection_unhealthy");
    }
    const actStatus = describeAct(connection);
    if (actStatus.state !== "available") {
      const code =
        actStatus.state === "needs_authorization"
          ? "authorization_required"
          : actStatus.state === "unhealthy"
            ? "connection_unhealthy"
            : "capability_unavailable";
      return await fail(code);
    }
    const act = connection.act;
    if (!act) return await fail("capability_unavailable");
    const live = act.operations().find((entry) => entry.name === invocation.operation);
    if (!live?.appAccess || live.appAccess.sideEffects !== expectedEffect) {
      return await fail("operation_not_found");
    }
    if (
      !this.access.isInvocationPolicyCurrent(
        invocation,
        expectedApproval ? "required" : "not_required",
      )
    ) {
      return await fail("access_denied");
    }
    try {
      const data = await act.invoke({
        operation: invocation.operation,
        input: invocation.input,
        ...(expectedEffect === "write" ? { requestId: invocation.id } : {}),
      });
      const output = serializeBounded(data ?? null, MAX_OUTPUT_BYTES);
      if (!output.ok) {
        if (expectedEffect === "read-only") return await fail("provider_error");
        await this.access.updateInvocation(invocation.id, "succeeded", null, true);
        await this.audit(invocation, executionApproval, "succeeded");
        return { ok: true, value: { status: "ok", executionId: invocation.id } };
      }
      await this.access.updateInvocation(invocation.id, "succeeded", null, true);
      await this.audit(invocation, executionApproval, "succeeded");
      return {
        ok: true,
        value: {
          status: "ok",
          executionId: invocation.id,
          ...(data === undefined || expectedApproval ? {} : { data: JSON.parse(output.value) }),
        },
      };
    } catch {
      if (expectedEffect === "write") {
        await this.access.updateInvocation(
          invocation.id,
          "outcome_unknown",
          "outcome_unknown",
          true,
        );
        await this.audit(invocation, executionApproval, "outcome_unknown");
        return { ok: true, value: { status: "outcome_unknown", executionId: invocation.id } };
      }
      return await fail("provider_error", true);
    }
  }

  private async failInvocation(
    invocation: AppConnectionInvocationRecord,
    code: AppConnectionErrorBody["code"],
    retryable = false,
    approval: "not_required" | "approved" = "not_required",
  ): Promise<AppConnectionBrokerResult<never>> {
    await this.access.updateInvocation(invocation.id, "failed", code, true);
    await this.audit(invocation, approval, code);
    return failure(code, messageFor(code), retryable);
  }

  private async failUnclaimedInvocation(
    invocation: AppConnectionInvocationRecord,
    expectedStatus: "ready" | "pending_approval",
    approval: "not_required" | "approved",
    code: AppConnectionErrorBody["code"],
    message = messageFor(code),
  ): Promise<AppConnectionBrokerResult<never>> {
    const failed = await this.access.transitionInvocation(
      invocation.id,
      [expectedStatus],
      "failed",
      code,
      true,
    );
    if (!failed) return failure("access_denied", "The connection invocation is not runnable.");
    await this.audit(invocation, approval, code);
    return failure(code, message);
  }

  private async preview(args: Record<string, unknown>) {
    const invocation =
      typeof args.invocationId === "string"
        ? await this.access.getInvocation(args.invocationId)
        : null;
    if (!invocation) {
      return {
        kind: "generic" as const,
        title: "Allow App connection operation",
        summary: "An App wants to use a connection.",
      };
    }
    const connection = this.findConnection(invocation.connectionId);
    const operation = connection ? this.supportedOperations(connection, invocation.identity) : null;
    const descriptor = operation?.ok
      ? operation.value.find((entry) => entry.name === invocation.operation)
      : null;
    const declared = descriptor?.appAccess?.approvalPreview;
    const fields = [
      { label: "App", value: invocation.appId },
      { label: "Connection", value: connection?.label ?? invocation.connectionId },
      { label: "Identity", value: invocation.identity },
      { label: "Operation", value: invocation.operation },
      ...(declared?.fields ?? []).slice(0, 8).map((field) => {
        const resolved = resolvePointer(invocation.input, field.inputPointer);
        return {
          label: clip(field.label, 80),
          value: resolved.found ? previewValue(resolved.value) : "Unavailable",
        };
      }),
    ];
    return {
      kind: "generic" as const,
      title: "Allow App connection operation",
      summary: clip(
        declared?.summary ?? `${invocation.appId} wants to run ${invocation.operation}.`,
        240,
      ),
      fields,
    };
  }

  private duplicate(
    invocation: AppConnectionInvocationRecord,
    serializedInput: string,
    input: { connectionId: string; identity: string; operation: string },
  ): AppConnectionBrokerResult<AppConnectionInvokeResult> {
    if (
      invocation.connectionId !== input.connectionId ||
      invocation.identity !== input.identity ||
      invocation.operation !== input.operation ||
      invocation.inputHash !== digest(serializedInput)
    ) {
      return failure("request_id_conflict", "The requestId is bound to another request.");
    }
    if (invocation.status === "outcome_unknown") {
      return { ok: true, value: { status: "outcome_unknown", executionId: invocation.id } };
    }
    if (invocation.status === "pending_approval") {
      return failure("request_in_progress", "The original request is awaiting approval.");
    }
    if (invocation.status === "ready" || invocation.status === "running") {
      return failure("request_in_progress", "The original request is still in progress.", true);
    }
    if (
      invocation.status === "succeeded" ||
      invocation.status === "failed" ||
      invocation.status === "rejected"
    ) {
      return {
        ok: true,
        value: {
          status: "duplicate",
          executionId: invocation.id,
          outcome: invocation.status === "succeeded" ? "succeeded" : "failed",
          ...(invocation.errorCode
            ? { errorCode: invocation.errorCode as AppConnectionErrorBody["code"] }
            : {}),
        },
      };
    }
    return failure("outcome_unknown", "The original request has not reached a final outcome.");
  }

  private supportedOperations(
    connection: Connection,
    identity: string,
  ): AppConnectionBrokerResult<readonly OperationDescriptor[]> {
    return appAccessibleOperations(this.registry, connection, identity);
  }

  private async finishEngineFailure(
    invocation: AppConnectionInvocationRecord,
    approval: "not_required" | "pending",
  ): Promise<AppConnectionBrokerResult<AppConnectionInvokeResult>> {
    const current = await this.access.getInvocation(invocation.id);
    if (
      invocation.sideEffects === "write" &&
      (current?.status === "running" || current?.status === "outcome_unknown")
    ) {
      if (current.status === "running") {
        await this.access.transitionInvocation(
          invocation.id,
          ["running"],
          "outcome_unknown",
          "outcome_unknown",
          true,
        );
        await this.audit(invocation, approval, "outcome_unknown");
      }
      return { ok: true, value: { status: "outcome_unknown", executionId: invocation.id } };
    }
    if (invocation.sideEffects === "write" && current?.status === "succeeded") {
      return { ok: true, value: { status: "ok", executionId: invocation.id } };
    }
    const code = invocation.sideEffects === "write" ? "capability_unavailable" : "provider_error";
    const failed = await this.access.transitionInvocation(
      invocation.id,
      ["ready", "pending_approval", "running"],
      "failed",
      code,
      true,
    );
    if (failed) await this.audit(invocation, approval, code);
    return failure(
      code,
      "The connection operation could not complete.",
      invocation.sideEffects === "read-only",
    );
  }

  private validateInput(
    operation: OperationDescriptor,
    input: unknown,
  ): AppConnectionBrokerResult<true> {
    let validator = this.validators.get(operation.inputSchema);
    if (!validator) {
      try {
        validator = this.ajv.compile(operation.inputSchema);
        this.validators.set(operation.inputSchema, validator);
      } catch {
        return failure("invalid_input", "The operation has an invalid input schema.");
      }
    }
    if (!validator(input)) {
      return failure("invalid_input", "The input does not satisfy the operation schema.");
    }
    return { ok: true, value: true };
  }

  private describeIdentity(connection: Connection, identity: string, grant: GrantValue) {
    let profile: ProfileDisplay | undefined;
    if (grant.profile) {
      const revive = this.registry.getDescriptor(connection.connectionKind)?.reviveProfile;
      if (!revive) return failure("identity_not_found", "The identity has no safe profile.");
      try {
        profile = revive(grant.profile);
      } catch {
        return failure("identity_not_found", "The identity profile is invalid.");
      }
    }
    return {
      ok: true as const,
      value: {
        name: identity,
        state:
          grant.state === "authorized"
            ? ("authorized" as const)
            : grant.state === "degraded"
              ? ("unhealthy" as const)
              : ("needs_authorization" as const),
        ...(profile ? { profile: compactProfile(profile) } : {}),
      },
    };
  }

  private findConnection(id: string): Connection | null {
    return this.registry.all().find((connection) => connection.id === id) ?? null;
  }

  private async audit(
    invocation: AppConnectionInvocationRecord,
    approval: "not_required" | "pending" | "approved" | "rejected",
    status: string,
  ): Promise<void> {
    await this.access.appendAudit({
      appId: invocation.appId,
      connectionId: invocation.connectionId,
      identity: invocation.identity,
      operation: invocation.operation,
      accessRevision: invocation.accessRevision,
      approval,
      executionId: invocation.id,
      requestIdHash: invocation.requestIdHash,
      status,
    });
  }

  private takeInvokeSlot(appId: string): { allowed: boolean; auditDenial: boolean } {
    const now = this.now();
    const window = this.invokeWindows.get(appId);
    if (!window || now - window.startedAt >= this.rateWindowMs) {
      this.invokeWindows.set(appId, { startedAt: now, count: 1, denialAudited: false });
      return { allowed: true, auditDenial: false };
    }
    if (window.count >= this.invokeLimit) {
      if (window.denialAudited) return { allowed: false, auditDenial: false };
      window.denialAudited = true;
      return { allowed: false, auditDenial: true };
    }
    window.count += 1;
    return { allowed: true, auditDenial: false };
  }
}

export function appAccessibleOperations(
  registry: Pick<ConnectionRegistry, "getDescriptor">,
  connection: Pick<Connection, "connectionKind">,
  identity: string,
): AppConnectionBrokerResult<readonly OperationDescriptor[]> {
  const descriptor = registry.getDescriptor(connection.connectionKind);
  if (!descriptor?.capabilities.actor) {
    return failure("capability_unavailable", "This connection cannot act.");
  }
  if (descriptor.grant !== identity) {
    return failure("identity_not_found", "The identity cannot be isolated for App access.");
  }
  const operations = descriptor.capabilities.actor.operations ?? [];
  return {
    ok: true,
    value: operations.filter(
      (operation) =>
        operation.appAccess &&
        (operation.appAccess.sideEffects === "read-only" ||
          operation.appAccess.approvalPreview !== undefined),
    ),
  };
}

function summary(connection: Connection, identity: string) {
  return {
    connectionId: connection.id,
    connectionKind: connection.connectionKind,
    label: connection.label,
    identity,
    health:
      connection.state() === "working"
        ? ("working" as const)
        : connection.state() === "broken"
          ? ("broken" as const)
          : ("not_connected" as const),
  };
}

function actionFor(
  sideEffects: "read-only" | "write",
  approval: "required" | "not_required",
): string {
  if (sideEffects === "read-only") {
    return READ_ACTION;
  }
  return approval === "required" ? APP_CONNECTION_WRITE_ACTION : APPROVED_WRITE_ACTION;
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return clip(value, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    return clip(JSON.stringify(canonicalJson(value)) ?? "Unavailable", 500);
  } catch {
    return "Unavailable";
  }
}

function describeAct(connection: Connection): AppConnectionDescription["act"] {
  const status = connection.status().act;
  if (status.state === "unsupported") return { state: "unsupported" };
  if (status.state === "needs-auth") {
    return { state: "needs_authorization", reason: "The required grant is not authorized." };
  }
  if (!connection.act) return { state: "unhealthy", reason: "The capability is not live." };
  return { state: "available" };
}

function compactProfile(profile: ProfileDisplay) {
  return {
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(profile.handle ? { handle: profile.handle } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

function isActive(policy: AppConnectionAccessRecord, now = new Date()): boolean {
  return !policy.revokedAt && (!policy.expiresAt || policy.expiresAt > now);
}

function policyMatchesGrant(policy: AppConnectionAccessRecord, grant: GrantValue | null): boolean {
  return Boolean(
    grant &&
      ((grant.grantEpoch && policy.grantEpoch === grant.grantEpoch) ||
        (grant.state === "unauthorized" && !grant.grantEpoch)),
  );
}

function validRequestId(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 200;
}

function validKey(value: string): boolean {
  return value.length >= 1 && value.length <= 200;
}

function auditKey(value: string): string {
  return validKey(value) ? value : "<invalid>";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeJsonInput(
  value: unknown,
  limit: number,
): AppConnectionBrokerResult<{ input: unknown; canonical: string }> {
  const serialized = serializeBounded(value, limit);
  if (!serialized.ok) return serialized;
  try {
    const input: unknown = JSON.parse(serialized.value);
    const canonical = JSON.stringify(canonicalJson(input));
    if (canonical === undefined) {
      return failure("invalid_input", "The value is not JSON serializable.");
    }
    return { ok: true, value: { input, canonical } };
  } catch {
    return failure("invalid_input", "The value is not JSON serializable.");
  }
}

function serializeBounded(value: unknown, limit: number): AppConnectionBrokerResult<string> {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > limit) {
      return failure("invalid_input", "The value is too large or not JSON serializable.");
    }
    return { ok: true, value: serialized };
  } catch {
    return failure("invalid_input", "The value is not JSON serializable.");
  }
}

function canonicalJson(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) throw new TypeError("circular input");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry, seen));
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, canonicalJson(entry, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

function enforceConstraints(
  input: unknown,
  constraints: AppConnectionResourceConstraint[],
): AppConnectionBrokerResult<true> {
  for (const constraint of constraints) {
    const resolved = resolvePointer(input, constraint.inputPointer);
    if (!resolved.found || !isConstraintValue(resolved.value)) {
      return failure(
        "resource_unresolved",
        `The resource at ${constraint.inputPointer} cannot be determined.`,
      );
    }
    if (!constraint.allowedValues.includes(resolved.value)) {
      return failure("resource_denied", "The operation targets a resource outside its grant.");
    }
  }
  return { ok: true, value: true };
}

function resolvePointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value };
  if (!pointer.startsWith("/")) return { found: false };
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null || !(key in current)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function isConstraintValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parsePage(input: {
  cursor?: string;
  limit?: number;
}): AppConnectionBrokerResult<{ after: string; limit: number }> {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return failure("invalid_input", `limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (!input.cursor) return { ok: true, value: { after: "", limit } };
  if (input.cursor.length > 1024) return failure("invalid_input", "The cursor is invalid.");
  try {
    const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
    if (!decoded) throw new Error("empty");
    return { ok: true, value: { after: decoded, limit } };
  } catch {
    return failure("invalid_input", "The cursor is invalid.");
  }
}

function paginateOperations(
  values: AppConnectionOperation[],
  page: { after: string; limit: number },
): AppConnectionOperationsPage {
  const filtered = values.filter((value) => value.name > page.after);
  const operations = filtered.slice(0, page.limit);
  return {
    operations,
    ...(filtered.length > operations.length
      ? { nextCursor: Buffer.from(operations.at(-1)!.name).toString("base64url") }
      : {}),
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isBrokerResult(
  value: unknown,
): value is AppConnectionBrokerResult<AppConnectionInvokeResult> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

function messageFor(code: AppConnectionErrorBody["code"]): string {
  const messages: Record<AppConnectionErrorBody["code"], string> = {
    access_denied: "The App is not allowed to run this operation.",
    connection_not_found: "The connection is unavailable.",
    identity_not_found: "The identity is unavailable.",
    operation_not_found: "The operation is unavailable.",
    capability_unavailable: "The connection cannot run operations.",
    authorization_required: "The connection needs authorization.",
    connection_unhealthy: "The connection is unhealthy.",
    invalid_input: "The operation input is invalid.",
    resource_denied: "The operation targets a resource outside its grant.",
    resource_unresolved: "The operation resource cannot be determined.",
    request_id_required: "The write operation requires a request id.",
    request_id_conflict: "The request id belongs to another request.",
    request_in_progress: "The original request is still in progress.",
    rate_limited: "The App connection rate limit was reached.",
    approval_rejected: "The guardian rejected the operation.",
    outcome_unknown: "The write outcome is unknown and will not be retried.",
    provider_error: "The connection provider rejected the operation.",
  };
  return messages[code];
}
