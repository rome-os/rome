import { describe, expect, it } from "@rstest/core";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { AppConnectionAccessRepository } from "../db/repositories/app-connection-access.js";
import { createActionEngineRepos, createTestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import type { ConnectionDescriptor, OperationCall, OperationDescriptor } from "./types.js";
import { AppConnectionBroker } from "./app-connections.js";

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
    appAccess: { sideEffects: "write" },
  },
  {
    name: "raw.http",
    description: "Core-only raw request.",
    inputSchema: { type: "object" },
  },
];

function harness(
  options: { invokeLimit?: number; rateWindowMs?: number; now?: () => number } = {},
) {
  const { db, close } = createTestDb();
  const invocations: Array<{ connectionId: string; call: OperationCall }> = [];
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
        operations,
        build(_credential, kit) {
          return {
            operations: () => operations,
            async invoke(call) {
              invocations.push({ connectionId: kit.connectionId, call });
              if ((call.input as { title?: string })?.title === "uncertain") {
                throw new Error("socket closed after send");
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
  const engine = new ActionEngine(actionRegistry, createActionEngineRepos(db), {
    processRole: "worker",
  });
  const broker = new AppConnectionBroker(registry, access, engine, options);
  broker.registerActions(actionRegistry);
  return { db, close, registry, access, actionRegistry, broker, invocations };
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
      await grant(h, { appId: "app-a", connectionId: connection.id, operation: "documents.get" });
      const page = await h.broker.forApp("app-a").operations({
        connectionId: connection.id,
        identity: "account",
      });
      expect(page.operations).toEqual([
        expect.objectContaining({ name: "documents.create", access: "not_granted" }),
        expect.objectContaining({ name: "documents.get", access: "granted" }),
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
      const approvalAction = h.actionRegistry.get("core:app_connection_write")!;
      const executed = await approvalAction.execute({ invocationId: result.executionId });
      expect(executed).toMatchObject({ status: "ok", data: { ok: true } });
      expect(h.invocations[0].call).toMatchObject({
        requestId: result.executionId,
        input: { workspaceId: "one", title: "Bound", body: "secret-input" },
      });
      expect(await h.access.getInvocation(result.executionId)).toMatchObject({
        requestIdHash: expect.not.stringContaining("request-0001"),
        input: null,
      });

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
});
