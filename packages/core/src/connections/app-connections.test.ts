import { describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { createRomeAppContext, type RomeAppRuntimeServices } from "../apps/context.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ResolvedApp } from "../apps/state.js";
import { AppConnectionAccessRepository } from "../db/repositories/app-connection-access.js";
import { appConnectionInvocations } from "../db/schema.js";
import { createActionEngineRepos, createTestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import type { ConnectionDescriptor, OperationCall, OperationDescriptor } from "./types.js";
import { AppConnectionBroker, createAppConnectionAccessLifecycle } from "./app-connections.js";

const operations: readonly OperationDescriptor[] = [
  {
    name: "documents.get",
    description: "Read one document.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" }, documentId: { type: "string" } },
      required: ["workspaceId", "documentId"],
      additionalProperties: false,
    },
    appAccess: { sideEffects: "read-only" },
  },
  {
    name: "documents.create",
    description: "Create one document.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["workspaceId", "title", "body"],
      additionalProperties: false,
    },
    appAccess: {
      sideEffects: "write",
      approvalPreview: {
        summary: "Create a document.",
        fields: [
          { label: "Workspace", inputPointer: "/workspaceId" },
          { label: "Title", inputPointer: "/title" },
        ],
      },
    },
  },
  {
    name: "raw.http",
    description: "Core-only raw request.",
    inputSchema: { type: "object" },
  },
];

function harness(
  options: {
    invokeLimit?: number;
    rateWindowMs?: number;
    now?: () => number;
    operations?: readonly OperationDescriptor[];
  } = {},
) {
  const { db, close } = createTestDb();
  const invocations: Array<{ connectionId: string; call: OperationCall }> = [];
  const actorOperations = options.operations ?? operations;
  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-docs",
    grant: "account",
    auth: {
      async confer() {
        throw new Error("not used");
      },
      async renew(credential) {
        return credential;
      },
    },
    reviveProfile: (profile) => ({
      displayName: String(profile.displayName),
      handle: undefined,
      email: undefined,
      avatarUrl: undefined,
    }),
    capabilities: {
      actor: {
        operations: actorOperations,
        build(_credential, kit) {
          return {
            operations: () => actorOperations,
            async invoke(call) {
              invocations.push({ connectionId: kit.connectionId, call });
              if ((call.input as { title?: string })?.title === "uncertain") {
                throw new Error("socket closed after send");
              }
              if ((call.input as { title?: string })?.title === "huge-output") {
                return { value: "x".repeat(1024 * 1024 + 1) };
              }
              return { secretResult: "not-for-audit", operation: call.operation };
            },
          };
        },
      },
    },
  };
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
  registry.register(descriptor);
  const access = new AppConnectionAccessRepository(db);
  const actionRegistry = new ActionRegistryImpl();
  const approvalRequests: Array<{ preview?: unknown }> = [];
  const engine = new ActionEngine(actionRegistry, createActionEngineRepos(db), {
    processRole: "worker",
    onApprovalCreated: (request) => {
      approvalRequests.push(request);
    },
  });
  const broker = new AppConnectionBroker(registry, access, engine, options);
  broker.registerActions(actionRegistry);
  return {
    db,
    close,
    registry,
    access,
    actionRegistry,
    engine,
    broker,
    invocations,
    approvalRequests,
  };
}

function appContext(appId: string, h: ReturnType<typeof harness>) {
  return createRomeAppContext(
    {
      appId,
      db: null,
      manifest: { id: appId, version: "1.0.0", description: "Test App" },
    } as unknown as ResolvedApp,
    {
      catalog: {} as AppCatalog,
      db: h.db,
      actionEngine: h.engine,
      repositories: {} as RomeAppRuntimeServices["repositories"],
    },
  );
}

async function connect(h: ReturnType<typeof harness>, label: string, another = false) {
  const connection = another
    ? await h.registry.connectAnother("fake-docs", label)
    : await h.registry.connect("fake-docs", label);
  await h.registry.importCredential(
    connection.id,
    "account",
    { material: { token: `${label}-token` }, expiresAt: "never" },
    { displayName: label },
  );
  return connection;
}

async function grant(
  h: ReturnType<typeof harness>,
  input: {
    appId: string;
    connectionId: string;
    operation: string;
    approval?: "required" | "not_required";
    constraints?: Array<{ inputPointer: string; allowedValues: string[] }>;
    expiresAt?: Date;
  },
) {
  return await h.access.put({
    appId: input.appId,
    connectionId: input.connectionId,
    identity: "account",
    operation: input.operation,
    approval: input.approval ?? "not_required",
    constraints: input.constraints ?? [],
    expiresAt: input.expiresAt,
  });
}

describe("App connection broker", () => {
  it("isolates two Apps and two connections, and denies by default", async () => {
    const h = harness();
    try {
      const first = await connect(h, "first");
      const second = await connect(h, "second", true);
      await grant(h, { appId: "app-a", connectionId: first.id, operation: "documents.get" });
      await grant(h, { appId: "app-b", connectionId: second.id, operation: "documents.get" });

      expect(await h.broker.forApp("app-c").list()).toEqual({ connections: [] });
      expect((await h.broker.forApp("app-a").list()).connections).toEqual([
        expect.objectContaining({ connectionId: first.id, label: "first" }),
      ]);
      expect((await h.broker.forApp("app-b").list()).connections).toEqual([
        expect.objectContaining({ connectionId: second.id, label: "second" }),
      ]);
      await expect(
        h.broker.forApp("app-a").describe({ connectionId: second.id, identity: "account" }),
      ).rejects.toMatchObject({ detail: { code: "connection_not_found" } });
    } finally {
      h.close();
    }
  });

  it("shows supported versus granted operations without exposing Core-only operations", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        approval: "required",
      });
      const page = await h.broker.forApp("app-a").operations({
        connectionId: connection.id,
        identity: "account",
      });
      expect(page.operations).toEqual([
        expect.objectContaining({
          name: "documents.create",
          access: "granted",
          approval: "required",
        }),
        expect.objectContaining({
          name: "documents.get",
          access: "not_granted",
          approval: "not_required",
        }),
      ]);
      expect(page.operations.some((operation) => operation.name === "raw.http")).toBe(false);
    } finally {
      h.close();
    }
  });

  it("validates input and fails closed when a resource cannot be resolved", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
        constraints: [{ inputPointer: "/workspaceId", allowedValues: ["allowed"] }],
      });
      const facade = h.broker.forApp("app-a");
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { documentId: "doc-1" },
        }),
      ).rejects.toMatchObject({ detail: { code: "invalid_input" } });
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: { hidden: "allowed" }, documentId: "doc-1" },
        }),
      ).rejects.toMatchObject({ detail: { code: "invalid_input" } });
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "denied", documentId: "doc-1" },
        }),
      ).rejects.toMatchObject({ detail: { code: "resource_denied" } });
      expect(h.invocations).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("binds approval to the stored parameters and rechecks access on replay", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        approval: "required",
      });
      const result = await h.broker.forApp("app-a").invoke({
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId: "request-0001",
        input: { workspaceId: "one", title: "Bound", body: "secret-input" },
      });
      expect(result.status).toBe("pending_approval");
      if (result.status !== "pending_approval") throw new Error("expected approval");
      expect(h.approvalRequests[0]?.preview).toMatchObject({
        summary: "Create a document.",
        fields: [
          { label: "App", value: "app-a" },
          { label: "Connection", value: "docs" },
          { label: "Identity", value: "account" },
          { label: "Operation", value: "documents.create" },
          { label: "Workspace", value: "one" },
          { label: "Title", value: "Bound" },
        ],
      });
      expect(JSON.stringify(h.approvalRequests[0]?.preview)).not.toContain("secret-input");
      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-0001",
          input: { body: "secret-input", title: "Bound", workspaceId: "one" },
        }),
      ).rejects.toMatchObject({ detail: { code: "request_in_progress", retryable: true } });
      const bypass = await appContext("app-a", h).runAction(
        "core:app_connection_write_without_approval",
        { invocationId: result.executionId },
      );
      expect(bypass).toMatchObject({
        status: "ok",
        data: { ok: false, error: { code: "access_denied" } },
      });
      expect(h.invocations).toHaveLength(0);
      const approvalAction = h.actionRegistry.get("core:app_connection_write")!;
      const executed = await approvalAction.execute({ invocationId: result.executionId });
      expect(executed).toMatchObject({ status: "ok", data: { ok: true } });
      expect(h.invocations[0].call).toMatchObject({
        requestId: result.executionId,
        input: { workspaceId: "one", title: "Bound", body: "secret-input" },
      });
      expect(await h.access.getInvocation(result.executionId)).toMatchObject({
        status: "succeeded",
        requestIdHash: expect.not.stringContaining("request-0001"),
        input: null,
      });
      expect(await approvalAction.execute({ invocationId: result.executionId })).toMatchObject({
        status: "ok",
        data: { ok: false, error: { code: "access_denied" } },
      });
      expect(h.invocations).toHaveLength(1);

      const second = await h.broker.forApp("app-a").invoke({
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId: "request-0002",
        input: { workspaceId: "one", title: "Revoked", body: "content" },
      });
      if (second.status !== "pending_approval") throw new Error("expected approval");
      await h.access.revoke("app-a", connection.id, "account", "documents.create");
      const denied = await approvalAction.execute({ invocationId: second.executionId });
      expect(denied).toMatchObject({
        status: "ok",
        data: { ok: false, error: { code: "access_denied" } },
      });
      expect(h.invocations).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("preserves the originating session when a worker requests approval", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        approval: "required",
      });
      const run = rs.spyOn(h.engine, "run");
      const origin = {
        actor: { kind: "guardian", userId: "guardian", via: "cookie" } as const,
        channelContext: {
          channel: "webchat",
          threadId: "thread-1",
          channelUserId: "guardian",
        },
        sharedContext: { locale: "zh-CN" },
        sessionId: "session-1",
        turnId: "turn-1",
        agentName: "main",
        channelThreadKey: "webchat:thread-1",
      };

      const result = await h.broker.invoke(
        "app-a",
        {
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-with-origin",
          input: { workspaceId: "one", title: "Routed", body: "content" },
        },
        origin,
      );

      expect(result).toMatchObject({ ok: true, value: { status: "pending_approval" } });
      expect(run).toHaveBeenCalledWith(
        "core:app_connection_write",
        expect.objectContaining({ invocationId: expect.any(String) }),
        { ...origin, initiator: "app:app-a", callerAppId: "app-a" },
      );
    } finally {
      h.close();
    }
  });

  it("expires and revokes grants without leaving captured authority live", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const facade = h.broker.forApp("app-a");
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "another-account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      await connection.auth.revoke("account");
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc" },
        }),
      ).rejects.toMatchObject({ detail: { code: "authorization_required" } });
      await h.registry.importCredential(
        connection.id,
        "account",
        { material: { token: "replacement" }, expiresAt: "never" },
        { displayName: "docs" },
      );
      await h.access.revoke("app-a", connection.id, "account", "documents.get");
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
        expiresAt: new Date(Date.now() - 1),
      });
      expect(await facade.list()).toEqual({ connections: [] });
    } finally {
      h.close();
    }
  });

  it("records approval rejection and cannot resume the rejected write", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        approval: "required",
      });
      const request = {
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId: "request-rejected",
        input: { workspaceId: "one", title: "No", body: "private" },
      } as const;
      const pending = await h.broker.forApp("app-a").invoke(request);
      if (pending.status !== "pending_approval") throw new Error("expected approval");
      await h.broker.approvalRejected("core:app_connection_write", {
        invocationId: pending.executionId,
      });
      expect(await h.broker.forApp("app-a").invoke(request)).toEqual({
        status: "duplicate",
        executionId: pending.executionId,
        outcome: "failed",
        errorCode: "approval_rejected",
      });
      expect(h.invocations).toHaveLength(0);
      expect(await h.access.getInvocation(pending.executionId)).toMatchObject({
        status: "rejected",
        input: null,
      });
      expect(await h.access.listAuditForApp("app-a")).toContainEqual(
        expect.objectContaining({ approval: "rejected", status: "approval_rejected" }),
      );
    } finally {
      h.close();
    }
  });

  it("fails closed for a legacy read policy that requires deferred approval", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
        approval: "required",
      });
      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      expect(h.invocations).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("rate-limits invocations per App and resets the bounded window", async () => {
    let now = 1_000;
    const h = harness({ invokeLimit: 1, rateWindowMs: 500, now: () => now });
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      const facade = h.broker.forApp("app-a");
      const input = {
        connectionId: connection.id,
        identity: "account",
        operation: "documents.get",
        input: { workspaceId: "one", documentId: "doc" },
      } as const;
      expect(await facade.invoke(input)).toMatchObject({ status: "ok" });
      await expect(facade.invoke(input)).rejects.toMatchObject({
        detail: { code: "rate_limited", retryable: true },
      });
      await expect(facade.invoke(input)).rejects.toMatchObject({
        detail: { code: "rate_limited", retryable: true },
      });
      expect(
        (await h.access.listAuditForApp("app-a")).filter(
          (event) => event.status === "rate_limited",
        ),
      ).toHaveLength(1);
      now += 500;
      expect(await facade.invoke(input)).toMatchObject({ status: "ok" });
    } finally {
      h.close();
    }
  });

  it("requires idempotency for writes and never retries an uncertain result", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      const facade = h.broker.forApp("app-a");
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          input: { workspaceId: "one", title: "missing id", body: "body" },
        }),
      ).rejects.toMatchObject({ detail: { code: "request_id_required" } });
      const request = {
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId: "request-uncertain",
        input: { workspaceId: "one", title: "uncertain", body: "body" },
      } as const;
      expect(await facade.invoke(request)).toMatchObject({ status: "outcome_unknown" });
      expect(
        await facade.invoke({
          ...request,
          input: { body: "body", title: "uncertain", workspaceId: "one" },
        }),
      ).toMatchObject({ status: "outcome_unknown" });
      expect(h.invocations).toHaveLength(1);
      await expect(
        facade.invoke({ ...request, input: { ...request.input, body: "changed" } }),
      ).rejects.toMatchObject({ detail: { code: "request_id_conflict" } });
    } finally {
      h.close();
    }
  });

  it("records a completed write as succeeded when its output cannot be returned", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      const request = {
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId: "request-huge-output",
        input: { workspaceId: "one", title: "huge-output", body: "body" },
      } as const;
      const first = await h.broker.forApp("app-a").invoke(request);
      expect(first).toMatchObject({ status: "ok" });
      if (first.status !== "ok") throw new Error("expected success");
      expect(first).not.toHaveProperty("data");
      expect(await h.access.getInvocation(first.executionId)).toMatchObject({
        status: "succeeded",
        input: null,
      });
      expect(await h.broker.forApp("app-a").invoke(request)).toEqual({
        status: "duplicate",
        executionId: first.executionId,
        outcome: "succeeded",
      });
      expect(h.invocations).toHaveLength(1);

      expect(await h.access.pruneAppData("app-a", new Date(Date.now() + 1_000))).toEqual({
        invocations: 1,
        audits: 1,
      });
      expect(await h.access.getInvocation(first.executionId)).toBeNull();
      expect(await h.access.listAuditForApp("app-a")).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("expires abandoned pending input even when the App is idle", async () => {
    const h = harness();
    try {
      h.access.createOrGetInvocation({
        id: "stale-pending",
        appId: "idle-app",
        connectionId: "connection",
        identity: "account",
        operation: "documents.create",
        requestIdHash: "request-hash",
        inputHash: "input-hash",
        input: { body: "private" },
        sideEffects: "write",
        accessRevision: 1,
      });
      await h.access.transitionInvocation("stale-pending", ["ready"], "pending_approval");
      await h.db
        .update(appConnectionInvocations)
        .set({ updatedAt: new Date(0) })
        .where(eq(appConnectionInvocations.id, "stale-pending"));

      await h.access.pruneExpiredData(new Date(1_000));

      expect(await h.access.getInvocation("stale-pending")).toMatchObject({
        status: "rejected",
        errorCode: "access_denied",
        input: null,
      });
    } finally {
      h.close();
    }
  });

  it("finishes an invocation when the Action engine throws", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      rs.spyOn(h.engine, "run").mockRejectedValueOnce(new Error("approval storage unavailable"));
      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc" },
        }),
      ).rejects.toMatchObject({ detail: { code: "provider_error", retryable: true } });
      const [audit] = await h.access.listAuditForApp("app-a");
      expect(audit).toMatchObject({ status: "provider_error" });
      expect(await h.access.getInvocation(audit!.executionId)).toMatchObject({
        status: "failed",
        input: null,
      });
    } finally {
      h.close();
    }
  });

  it("treats a non-ok engine result after a write claim as outcome unknown", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      rs.spyOn(h.engine, "run").mockImplementationOnce(async (_name, args) => {
        await h.access.updateInvocation(String(args.invocationId), "running");
        return { status: "error", error: "persistence failed after provider execution" };
      });

      const result = await h.broker.forApp("app-a").invoke({
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId: "request-engine-error",
        input: { workspaceId: "one", title: "Maybe created", body: "body" },
      });

      expect(result).toMatchObject({ status: "outcome_unknown" });
      expect(await h.access.getInvocation(result.executionId)).toMatchObject({
        status: "outcome_unknown",
        errorCode: "outcome_unknown",
        input: null,
      });
    } finally {
      h.close();
    }
  });

  it("uses the same code-unit ordering across operation pages", async () => {
    const names = ["a_b", "a-b", "a.b", "ab", "aB"];
    const h = harness({
      operations: names.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
        appAccess: { sideEffects: "read-only" },
      })),
    });
    try {
      const connection = await connect(h, "docs");
      await grant(h, { appId: "app-a", connectionId: connection.id, operation: "a-b" });
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await h.broker.forApp("app-a").operations({
          connectionId: connection.id,
          identity: "account",
          limit: 1,
          cursor,
        });
        seen.push(...page.operations.map((operation) => operation.name));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["a-b", "a.b", "aB", "a_b", "ab"]);
    } finally {
      h.close();
    }
  });

  it("paginates deterministically and keeps audit records free of inputs and outputs", async () => {
    const h = harness();
    try {
      const first = await connect(h, "first");
      const second = await connect(h, "second", true);
      const third = await connect(h, "third", true);
      for (const connection of [first, second, third]) {
        await grant(h, {
          appId: "app-a",
          connectionId: connection.id,
          operation: "documents.get",
        });
      }
      const facade = h.broker.forApp("app-a");
      const pageOne = await facade.list({ limit: 2 });
      expect(pageOne.connections).toHaveLength(2);
      const pageTwo = await facade.list({ limit: 2, cursor: pageOne.nextCursor });
      expect(pageTwo.connections).toHaveLength(1);
      await facade.invoke({
        connectionId: first.id,
        identity: "account",
        operation: "documents.get",
        input: { workspaceId: "one", documentId: "secret-document" },
      });
      const audit = await h.access.listAuditForApp("app-a");
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain("secret-document");
      expect(JSON.stringify(audit)).not.toContain("not-for-audit");
    } finally {
      h.close();
    }
  });

  it("keeps access through transient App failures and revokes it on disable or removal", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      const lifecycle = createAppConnectionAccessLifecycle(h.access);
      await lifecycle({
        appId: "app-a",
        change: "changed",
        current: { appId: "app-a", enabled: true, state: "broken" },
      } as never);
      expect(await h.access.listActiveForApp("app-a")).toHaveLength(1);

      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        approval: "required",
      });
      const pending = await h.broker.forApp("app-a").invoke({
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId: "request-disabled-app",
        input: { workspaceId: "one", title: "Pending", body: "private" },
      });
      if (pending.status !== "pending_approval") throw new Error("expected approval");

      await lifecycle({
        appId: "app-a",
        change: "changed",
        current: { appId: "app-a", enabled: false, state: "installed" },
      } as never);
      expect(await h.access.listActiveForApp("app-a")).toHaveLength(0);
      expect(await h.access.getInvocation(pending.executionId)).toMatchObject({
        status: "rejected",
        errorCode: "access_denied",
        input: null,
      });
      expect(await h.access.listAuditForApp("app-a")).toContainEqual(
        expect.objectContaining({ executionId: pending.executionId, status: "access_denied" }),
      );

      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      await lifecycle({ appId: "app-a", change: "removed", current: null });
      expect(await h.access.listActiveForApp("app-a")).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});
