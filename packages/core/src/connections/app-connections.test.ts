import { createHash } from "node:crypto";
import { describe, expect, it, rs } from "@rstest/core";
import { eq, inArray } from "drizzle-orm";
import type { ChatId } from "@rome-os/app-runtime";
import { ActionEngine } from "../actions/engine.js";
import { sendApprovalCard } from "../actions/approval-card.js";
import { ApprovalHandler } from "../actions/approval-handler.js";
import type { BackendSessionTask } from "../actions/backend-turn.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { createRomeAppContext, type RomeAppRuntimeServices } from "../apps/context.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ResolvedApp } from "../apps/state.js";
import { AppConnectionAccessRepository } from "../db/repositories/app-connection-access.js";
import { appConnectionAccess, appConnectionInvocations, connectionGrants } from "../db/schema.js";
import { createActionEngineRepos, createTestDb } from "../test/helpers.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import { ConnectionRegistry } from "./registry.js";
import type { ConnectionDescriptor, OperationCall, OperationDescriptor } from "./types.js";
import {
  AppConnectionBroker,
  createAppConnectionAccessLifecycle,
  reconcileAppConnectionAccess,
} from "./app-connections.js";

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
    isReady?: () => boolean;
  } = {},
) {
  const { db, close } = createTestDb();
  const invocations: Array<{ connectionId: string; call: OperationCall }> = [];
  const actorOperations = options.operations ?? operations;
  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-docs",
    grant: "account",
    auth: {
      async obtain() {
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
              if ((call.input as { documentId?: string })?.documentId === "typed-output") {
                return { fetchedAt: new Date("2026-10-26T00:00:00.000Z") };
              }
              return { secretResult: "not-for-audit", operation: call.operation };
            },
          };
        },
      },
    },
  };
  const registry = new ConnectionRegistry({
    repository: new DrizzleConnectionsRepository(db),
  });
  registry.register(descriptor);
  const access = new AppConnectionAccessRepository(db);
  const actionRegistry = new ActionRegistryImpl();
  const approvalRequests: Array<{ preview?: unknown }> = [];
  const approvalMessages: unknown[] = [];
  const engineRepos = createActionEngineRepos(db);
  const engine = new ActionEngine(actionRegistry, engineRepos, {
    processRole: "worker",
    onApprovalCreated: async (request) => {
      approvalRequests.push(request);
      await sendApprovalCard(
        {
          list: async () => [{ name: "webchat", sendable: true }],
          send: async (_channel: string, chatId: ChatId, message: unknown) => {
            approvalMessages.push(message);
            return { messageId: "approval-message", chatId };
          },
        } as never,
        request,
      );
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
    approvals: engineRepos.approvals,
    journal: engineRepos.journal,
    engine,
    broker,
    invocations,
    approvalRequests,
    approvalMessages,
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
  await h.registry.giveGrant(
    "fake-docs",
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
    sideEffects?: "read-only" | "write";
    approval?: "required" | "not_required";
    constraints?: Array<{ inputPointer: string; allowedValues: string[] }>;
    expiresAt?: Date;
  },
) {
  const currentGrant = await h.registry.grantOf(input.connectionId);
  if (!currentGrant?.grantEpoch) throw new Error("expected granted connection");
  const sideEffects =
    input.sideEffects ??
    h.registry
      .all()
      .find((connection) => connection.id === input.connectionId)
      ?.act?.operations()
      .find((operation) => operation.name === input.operation)?.appAccess?.sideEffects;
  if (!sideEffects) throw new Error("expected App-accessible operation");
  return await h.access.put({
    appId: input.appId,
    connectionId: input.connectionId,
    identity: "account",
    operation: input.operation,
    sideEffects,
    approval: input.approval ?? "not_required",
    constraints: input.constraints ?? [],
    expiresAt: input.expiresAt,
    grantEpoch: currentGrant.grantEpoch,
  });
}

describe("App connection broker", () => {
  it("stays unavailable until startup reconciliation succeeds", async () => {
    let ready = false;
    const h = harness({ isReady: () => ready });
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      const facade = h.broker.forApp("app-a");
      await expect(facade.list()).rejects.toMatchObject({
        detail: { code: "capability_unavailable", retryable: false },
      });
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc" },
        }),
      ).rejects.toMatchObject({ detail: { code: "capability_unavailable" } });
      expect(h.invocations).toHaveLength(0);

      ready = true;
      expect((await facade.list()).connections).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("isolates two Apps and two connections, and denies by default", async () => {
    const h = harness();
    try {
      const first = await connect(h, "first");
      const second = await connect(h, "second", true);
      await grant(h, { appId: "app-a", connectionId: first.id, operation: "documents.get" });
      await grant(h, { appId: "app-b", connectionId: second.id, operation: "documents.get" });

      expect(await h.broker.forApp("app-c").list()).toEqual({ connections: [] });
      expect((await h.broker.forApp("app-a").list()).connections).toEqual([
        expect.objectContaining({ connectionId: first.id, label: "first", identity: "account" }),
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

  it("describes the same grant snapshot that made the connection visible", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "original");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      const getGrant = h.registry.grantOf.bind(h.registry);
      rs.spyOn(h.registry, "grantOf").mockImplementationOnce(async (connectionId) => {
        const authorized = await getGrant(connectionId);
        await h.registry.giveGrant(
          "fake-docs",
          connection.id,
          "account",
          { material: { token: "replacement" }, expiresAt: "never" },
          { displayName: "replacement" },
        );
        return authorized;
      });

      await expect(
        h.broker.forApp("app-a").describe({
          connectionId: connection.id,
          identity: "account",
        }),
      ).resolves.toMatchObject({ identity: { profile: { displayName: "original" } } });
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

  it("preserves provider toJSON values in read results", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });

      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "typed-output" },
        }),
      ).resolves.toMatchObject({
        status: "ok",
        data: { fetchedAt: "2026-10-26T00:00:00.000Z" },
      });
    } finally {
      h.close();
    }
  });

  it("forwards only allowed origin context into the Action engine", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      const run = rs.spyOn(h.engine, "run");
      await h.broker.invoke(
        "app-a",
        {
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc-1" },
        },
        {
          sessionId: "session-1",
          replayJournal: [{ status: "pending_approval" }],
          replayRootExecutionId: "forged-root",
        } as never,
      );

      expect(run.mock.calls[0]![2]).toMatchObject({
        executionId: run.mock.calls[0]![1].invocationId,
        sessionId: "session-1",
        initiator: "app:app-a",
        callerAppId: "app-a",
      });
      expect(run.mock.calls[0]![2]).not.toHaveProperty("replayJournal");
      expect(run.mock.calls[0]![2]).not.toHaveProperty("replayRootExecutionId");
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
      const approval = await h.approvals.findById(result.approval.approvalId);
      expect(approval?.payload).toMatchObject({ preview: h.approvalRequests[0]?.preview });
      expect(JSON.stringify(approval?.payload)).not.toContain("secret-input");
      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-0001",
          input: { body: "secret-input", title: "Bound", workspaceId: "one" },
        }),
      ).rejects.toMatchObject({ detail: { code: "request_in_progress", retryable: false } });
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
      expect(JSON.stringify(executed)).not.toContain("not-for-audit");
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
        status: "error",
        error: expect.stringContaining("not runnable"),
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
        status: "error",
        error: expect.stringContaining("not runnable"),
      });
      expect(h.invocations).toHaveLength(1);
      expect(await h.access.getInvocation(second.executionId)).toMatchObject({
        status: "rejected",
        errorCode: "access_denied",
        input: null,
      });
    } finally {
      h.close();
    }
  });

  it("rejects an outstanding invocation when its access policy is replaced", async () => {
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
        requestId: "request-replaced-policy",
        input: { workspaceId: "one", title: "Old policy", body: "private" },
      } as const;
      const pending = await h.broker.forApp("app-a").invoke(request);
      if (pending.status !== "pending_approval") throw new Error("expected approval");

      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        approval: "not_required",
      });

      expect(await h.broker.forApp("app-a").invoke(request)).toEqual({
        status: "duplicate",
        executionId: pending.executionId,
        outcome: "failed",
        errorCode: "access_denied",
      });
      expect(await h.access.getInvocation(pending.executionId)).toMatchObject({
        status: "rejected",
        errorCode: "access_denied",
        input: null,
      });
      expect(
        await h.actionRegistry
          .get("core:app_connection_write")!
          .execute({ invocationId: pending.executionId }),
      ).toMatchObject({ status: "error", error: expect.stringContaining("not runnable") });
      expect(await h.access.listAuditForApp("app-a")).toContainEqual(
        expect.objectContaining({
          approval: "rejected",
          executionId: pending.executionId,
          status: "access_denied",
        }),
      );
      expect(h.invocations).toHaveLength(0);
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
        {
          ...origin,
          executionId: expect.any(String),
          initiator: "app:app-a",
          callerAppId: "app-a",
        },
      );
      expect(run.mock.calls[0]![2]?.executionId).toBe(run.mock.calls[0]![1].invocationId);
      expect(h.approvalMessages).toEqual([
        expect.objectContaining({
          parts: [
            expect.objectContaining({
              type: "approval_card",
              preview: expect.objectContaining({
                title: "Allow App connection operation",
                summary: "Create a document.",
              }),
            }),
          ],
        }),
      ]);
    } finally {
      h.close();
    }
  });

  it("keeps approved provider output out of replay and handles rejection through ApprovalHandler", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        approval: "required",
      });
      const prompts: string[] = [];
      const emitted: unknown[] = [];
      const handler = new ApprovalHandler(
        h.approvals,
        h.journal,
        h.engine,
        {
          async *run(params) {
            prompts.push(params.prompt);
          },
        },
        {
          runBackendSessionTask: async (
            _channel: string,
            _threadId: string,
            task: BackendSessionTask,
          ) => {
            await task({
              emit: async (message: unknown) => {
                emitted.push(message);
              },
            });
          },
        } as never,
        undefined,
        h.broker,
      );
      const origin = {
        channelContext: { channel: "webchat", threadId: "thread-1" },
        sessionId: "session-1",
        agentName: "main",
        channelThreadKey: "webchat:thread-1",
      };
      const invoke = async (requestId: string) =>
        await h.broker.invoke(
          "app-a",
          {
            connectionId: connection.id,
            identity: "account",
            operation: "documents.create",
            requestId,
            input: { workspaceId: "one", title: "Replay", body: "private" },
          },
          origin,
        );

      const approved = await invoke("request-approved-through-handler");
      if (!approved.ok || approved.value.status !== "pending_approval") {
        throw new Error("expected approval");
      }
      const approvedRow = await h.approvals.findById(approved.value.approval.approvalId);
      const approvedPayload = approvedRow!.payload as { rootExecutionId: string };
      await h.approvals.resolvePending(approved.value.approval.approvalId, "approve", "guardian");
      await handler.onApproved(approved.value.approval.approvalId);

      expect(
        JSON.stringify(await h.journal.loadJournal(approvedPayload.rootExecutionId)),
      ).not.toContain("not-for-audit");
      expect(JSON.stringify(emitted)).not.toContain("not-for-audit");
      expect(JSON.stringify(prompts)).not.toContain("not-for-audit");
      expect(await h.access.getInvocation(approved.value.executionId)).toMatchObject({
        status: "succeeded",
        input: null,
      });

      const rejected = await invoke("request-rejected-through-handler");
      if (!rejected.ok || rejected.value.status !== "pending_approval") {
        throw new Error("expected approval");
      }
      await h.approvals.resolvePending(rejected.value.approval.approvalId, "reject", "guardian");
      await handler.onRejected(rejected.value.approval.approvalId);
      expect(await h.access.getInvocation(rejected.value.executionId)).toMatchObject({
        status: "rejected",
        errorCode: "approval_rejected",
        input: null,
      });

      const denied = await invoke("request-denied-after-approval");
      if (!denied.ok || denied.value.status !== "pending_approval") {
        throw new Error("expected approval");
      }
      await h.access.revoke("app-a", connection.id, "account", "documents.create");
      await h.approvals.resolvePending(denied.value.approval.approvalId, "approve", "guardian");
      await handler.onApproved(denied.value.approval.approvalId);
      expect(prompts.at(-1)).toContain("failed with error");
      expect(prompts.at(-1)).not.toContain("executed successfully");
      expect(emitted).toContainEqual(
        expect.objectContaining({ type: "tool_result", isError: true }),
      );
      expect(await h.access.getInvocation(denied.value.executionId)).toMatchObject({
        status: "rejected",
        errorCode: "access_denied",
        input: null,
      });
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
      await h.registry.giveGrant(
        "fake-docs",
        connection.id,
        "account",
        { material: { token: "replacement" }, expiresAt: "never" },
        { displayName: "docs" },
      );
      expect(await facade.list()).toEqual({ connections: [] });
      const invocationCount = (await h.db.select().from(appConnectionInvocations)).length;
      await expect(
        facade.invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.get",
          input: { workspaceId: "one", documentId: "doc" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      expect(await h.db.select().from(appConnectionInvocations)).toHaveLength(invocationCount);
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

  it("rechecks the policy after claiming and immediately before provider I/O", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      const getGrant = h.registry.grantOf.bind(h.registry);
      rs.spyOn(h.registry, "grantOf").mockImplementationOnce(async (connectionId) => {
        const current = await getGrant(connectionId);
        await h.access.revoke("app-a", connection.id, "account", "documents.create");
        return current;
      });

      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-revoked-before-provider",
          input: { workspaceId: "one", title: "Must not run", body: "private" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      expect(h.invocations).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("reports a grant degraded while approval was pending as unhealthy", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
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
        requestId: "request-degraded-during-approval",
        input: { workspaceId: "one", title: "Must not run", body: "private" },
      });
      if (pending.status !== "pending_approval") throw new Error("expected approval");
      const claim = h.access.claimInvocationWithPolicy.bind(h.access);
      rs.spyOn(h.access, "claimInvocationWithPolicy").mockImplementationOnce(
        (invocation, expectedStatus, approval, now) => {
          h.db
            .update(connectionGrants)
            .set({ state: "degraded" })
            .where(eq(connectionGrants.custody, connection.id))
            .run();
          return claim(invocation, expectedStatus, approval, now);
        },
      );

      const approvalAction = h.actionRegistry.get("core:app_connection_write")!;
      await expect(
        approvalAction.execute({ invocationId: pending.executionId }),
      ).resolves.toMatchObject({
        status: "error",
        error: "The connection is unhealthy.",
      });
      expect(h.invocations).toHaveLength(0);
      expect(await h.access.getInvocation(pending.executionId)).toMatchObject({
        status: "failed",
        errorCode: "connection_unhealthy",
        input: null,
      });
    } finally {
      h.close();
    }
  });

  it("denies a policy created for a different side-effect classification", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
        sideEffects: "read-only",
      });

      await expect(
        h.broker.forApp("app-a").operations({
          connectionId: connection.id,
          identity: "account",
        }),
      ).resolves.toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({ name: "documents.create", access: "not_granted" }),
        ]),
      });

      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-reclassified-operation",
          input: { workspaceId: "one", title: "Must not run", body: "private" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      expect(h.invocations).toHaveLength(0);
      expect(await h.db.select().from(appConnectionInvocations)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("makes the execution claim conditional on the granted side-effect classification", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      const policy = await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      const stored = h.access.createOrGetInvocation({
        id: "reclassified-invocation",
        appId: "app-a",
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestIdHash: createHash("sha256").update("reclassified-request").digest("hex"),
        inputHash: createHash("sha256").update("input").digest("hex"),
        input: { workspaceId: "one", title: "Must not run", body: "private" },
        sideEffects: "write",
        accessRevision: policy.revision,
      }).invocation;
      h.db
        .update(appConnectionAccess)
        .set({ sideEffects: "read-only" })
        .where(eq(appConnectionAccess.appId, "app-a"))
        .run();

      expect(h.access.claimInvocationWithPolicy(stored, "ready", "not_required")).toBe(false);
      expect(await h.access.getInvocation(stored.id)).toMatchObject({ status: "ready" });
    } finally {
      h.close();
    }
  });

  it("rejects a grant degraded between the execution checks and provider I/O", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      const isCurrent = h.access.isInvocationPolicyCurrent.bind(h.access);
      rs.spyOn(h.access, "isInvocationPolicyCurrent").mockImplementationOnce(
        (invocation, approval, now) => {
          h.db
            .update(connectionGrants)
            .set({ state: "degraded" })
            .where(eq(connectionGrants.custody, connection.id))
            .run();
          return isCurrent(invocation, approval, now);
        },
      );

      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-degraded-before-provider",
          input: { workspaceId: "one", title: "Must not run", body: "private" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      expect(h.invocations).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("makes the execution claim conditional on the current policy revision", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      const claim = h.access.claimInvocationWithPolicy.bind(h.access);
      rs.spyOn(h.access, "claimInvocationWithPolicy").mockImplementationOnce(
        (invocation, expectedStatus, approval, now) => {
          h.db
            .update(appConnectionAccess)
            .set({ revokedAt: new Date(), revision: 2, updatedAt: new Date() })
            .where(eq(appConnectionAccess.appId, "app-a"))
            .run();
          return claim(invocation, expectedStatus, approval, now);
        },
      );

      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-revoked-before-claim",
          input: { workspaceId: "one", title: "Must not claim", body: "private" },
        }),
      ).rejects.toMatchObject({ detail: { code: "access_denied" } });
      expect(h.invocations).toHaveLength(0);
      const [stored] = await h.db.select().from(appConnectionInvocations);
      expect(stored).toMatchObject({ status: "failed", errorCode: "access_denied", input: null });
      expect(await h.access.listAuditForApp("app-a")).toContainEqual(
        expect.objectContaining({ executionId: stored!.id, status: "access_denied" }),
      );
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-revoked-before-claim",
          input: { workspaceId: "one", title: "Must not claim", body: "private" },
        }),
      ).resolves.toMatchObject({ status: "duplicate", outcome: "failed" });
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

  it("hashes and invokes the persisted JSON form of input values", async () => {
    const jsonWrite: OperationDescriptor = {
      name: "payloads.create",
      description: "Create one flexible payload.",
      inputSchema: {
        type: "object",
        properties: { payload: {} },
        required: ["payload"],
        additionalProperties: false,
      },
      appAccess: {
        sideEffects: "write",
        approvalPreview: { summary: "Create a flexible payload." },
      },
    };
    const h = harness({ operations: [...operations, jsonWrite] });
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: jsonWrite.name,
      });
      const facade = h.broker.forApp("app-a");
      const request = {
        connectionId: connection.id,
        identity: "account",
        operation: jsonWrite.name,
        requestId: "request-date-payload",
      } as const;

      await expect(
        facade.invoke({
          ...request,
          input: { payload: new Date("2026-10-26T00:00:00.000Z") },
        }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(h.invocations[0]?.call.input).toEqual({
        payload: "2026-10-26T00:00:00.000Z",
      });
      await expect(
        facade.invoke({
          ...request,
          input: { payload: new Date("2026-10-27T00:00:00.000Z") },
        }),
      ).rejects.toMatchObject({ detail: { code: "request_id_conflict" } });
    } finally {
      h.close();
    }
  });

  it("recovers unstarted and uncertain crash-orphaned writes", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      const policy = await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      const requestId = "request-running-write";
      const input = { workspaceId: "one", title: "Running", body: "private" };
      h.access.createOrGetInvocation({
        id: "running-write",
        appId: "app-a",
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestIdHash: createHash("sha256").update(requestId).digest("hex"),
        inputHash: createHash("sha256")
          .update(JSON.stringify({ body: "private", title: "Running", workspaceId: "one" }))
          .digest("hex"),
        input,
        sideEffects: "write",
        accessRevision: policy.revision,
      });
      await h.access.transitionInvocation("running-write", ["ready"], "running");
      const readyRequestId = "request-ready-write";
      const readyInput = { workspaceId: "one", title: "Ready", body: "private" };
      h.access.createOrGetInvocation({
        id: "ready-write",
        appId: "app-a",
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestIdHash: createHash("sha256").update(readyRequestId).digest("hex"),
        inputHash: createHash("sha256")
          .update(JSON.stringify({ body: "private", title: "Ready", workspaceId: "one" }))
          .digest("hex"),
        input: readyInput,
        sideEffects: "write",
        accessRevision: policy.revision,
      });
      for (const id of ["active-pending-write", "orphaned-pending-write"]) {
        h.access.createOrGetInvocation({
          id,
          appId: "app-a",
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestIdHash: createHash("sha256").update(id).digest("hex"),
          inputHash: createHash("sha256").update(`${id}-input`).digest("hex"),
          input: { workspaceId: "one", title: id, body: "private" },
          sideEffects: "write",
          accessRevision: policy.revision,
        });
        await h.access.transitionInvocation(id, ["ready"], "pending_approval");
      }
      const request = {
        connectionId: connection.id,
        identity: "account",
        operation: "documents.create",
        requestId,
        input,
      } as const;

      await expect(h.broker.forApp("app-a").invoke(request)).rejects.toMatchObject({
        detail: { code: "request_in_progress", retryable: true },
      });
      expect(await h.access.recoverInterruptedInvocations(["active-pending-write"])).toBe(3);
      expect(await h.broker.forApp("app-a").invoke(request)).toEqual({
        status: "outcome_unknown",
        executionId: "running-write",
      });
      expect(
        await h.broker.forApp("app-a").invoke({
          ...request,
          requestId: readyRequestId,
          input: readyInput,
        }),
      ).toEqual({
        status: "duplicate",
        executionId: "ready-write",
        outcome: "failed",
        errorCode: "capability_unavailable",
      });
      expect(await h.access.getInvocation("running-write")).toMatchObject({
        status: "outcome_unknown",
        input: null,
      });
      expect(await h.access.getInvocation("ready-write")).toMatchObject({
        status: "failed",
        input: null,
      });
      expect(await h.access.getInvocation("active-pending-write")).toMatchObject({
        status: "pending_approval",
        input: expect.any(Object),
      });
      expect(await h.access.getInvocation("orphaned-pending-write")).toMatchObject({
        status: "failed",
        errorCode: "capability_unavailable",
        input: null,
      });
      const recoveryAudit = (await h.access.listAuditForApp("app-a")).map((entry) => ({
        approval: entry.approval,
        executionId: entry.executionId,
        requestIdHash: entry.requestIdHash,
        status: entry.status,
      }));
      expect(recoveryAudit).toHaveLength(3);
      expect(recoveryAudit).toEqual(
        expect.arrayContaining([
          {
            approval: "not_required",
            executionId: "running-write",
            requestIdHash: createHash("sha256").update(requestId).digest("hex"),
            status: "outcome_unknown",
          },
          {
            approval: "not_required",
            executionId: "ready-write",
            requestIdHash: createHash("sha256").update(readyRequestId).digest("hex"),
            status: "capability_unavailable",
          },
          {
            approval: "pending",
            executionId: "orphaned-pending-write",
            requestIdHash: createHash("sha256").update("orphaned-pending-write").digest("hex"),
            status: "capability_unavailable",
          },
        ]),
      );
    } finally {
      h.close();
    }
  });

  it("does not deduplicate read operations when a requestId is supplied", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      const request = {
        connectionId: connection.id,
        identity: "account",
        operation: "documents.get",
        requestId: "logical-task-id",
        input: { workspaceId: "one", documentId: "doc" },
      } as const;

      expect(await h.broker.forApp("app-a").invoke(request)).toMatchObject({
        status: "ok",
        data: { operation: "documents.get" },
      });
      expect(await h.broker.forApp("app-a").invoke(request)).toMatchObject({
        status: "ok",
        data: { operation: "documents.get" },
      });
      expect(h.invocations).toHaveLength(2);
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

      expect(await h.access.pruneExpiredData(new Date(Date.now() + 1_000))).toEqual({
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
      h.access.createOrGetInvocation({
        id: "stale-running",
        appId: "idle-app",
        connectionId: "connection",
        identity: "account",
        operation: "documents.create",
        requestIdHash: "running-request-hash",
        inputHash: "running-input-hash",
        input: { body: "private" },
        sideEffects: "write",
        accessRevision: 1,
      });
      await h.access.transitionInvocation("stale-running", ["ready"], "running");
      await h.db
        .update(appConnectionInvocations)
        .set({ updatedAt: new Date(0) })
        .where(inArray(appConnectionInvocations.id, ["stale-pending", "stale-running"]));

      await h.access.pruneExpiredData(new Date(1_000));

      expect(await h.access.getInvocation("stale-pending")).toMatchObject({
        status: "rejected",
        errorCode: "access_denied",
        input: null,
      });
      expect(await h.access.getInvocation("stale-running")).toMatchObject({
        status: "outcome_unknown",
        errorCode: "outcome_unknown",
        input: null,
      });
      expect(await h.access.listAuditForApp("idle-app")).toEqual([
        expect.objectContaining({
          executionId: "stale-pending",
          approval: "pending",
          status: "access_denied",
        }),
        expect.objectContaining({
          executionId: "stale-running",
          approval: "not_required",
          status: "outcome_unknown",
        }),
      ]);
    } finally {
      h.close();
    }
  });

  it("prunes completed read invocation rows without waiting for retention", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.get",
      });
      const result = await h.broker.forApp("app-a").invoke({
        connectionId: connection.id,
        identity: "account",
        operation: "documents.get",
        input: { workspaceId: "one", documentId: "doc" },
      });
      if (result.status !== "ok") throw new Error("expected success");

      expect(await h.access.pruneExpiredData(new Date(0))).toEqual({
        invocations: 1,
        audits: 0,
      });
      expect(await h.access.getInvocation(result.executionId)).toBeNull();
      expect(await h.access.listAuditForApp("app-a")).toHaveLength(1);
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

  it("does not report an unclaimed write as having an unknown outcome", async () => {
    const h = harness();
    try {
      const connection = await connect(h, "docs");
      await grant(h, {
        appId: "app-a",
        connectionId: connection.id,
        operation: "documents.create",
      });
      rs.spyOn(h.engine, "run").mockRejectedValueOnce(new Error("engine unavailable"));

      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: connection.id,
          identity: "account",
          operation: "documents.create",
          requestId: "request-engine-unavailable",
          input: { workspaceId: "one", title: "Not sent", body: "private" },
        }),
      ).rejects.toMatchObject({ detail: { code: "capability_unavailable", retryable: false } });
      expect(h.invocations).toHaveLength(0);
      const [stored] = await h.db.select().from(appConnectionInvocations);
      expect(stored).toMatchObject({
        status: "failed",
        errorCode: "capability_unavailable",
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

      await grant(h, {
        appId: "orphaned-app",
        connectionId: connection.id,
        operation: "documents.get",
      });
      await grant(h, {
        appId: "enabled-broken-app",
        connectionId: connection.id,
        operation: "documents.get",
      });
      await reconcileAppConnectionAccess(
        {
          get: (appId) => (appId === "enabled-broken-app" ? { enabled: true } : null),
        },
        h.access,
      );
      expect(await h.access.listActiveForApp("orphaned-app")).toHaveLength(0);
      expect(await h.access.listActiveForApp("enabled-broken-app")).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});
