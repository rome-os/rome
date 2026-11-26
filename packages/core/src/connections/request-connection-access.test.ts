import { describe, expect, it } from "@rstest/core";
import { actionExecutionContext } from "../apps/actions/context.js";
import { CallRefusal } from "../apps/actions/types.js";
import { createTestDb } from "../test/db.js";
import { AppConnectionAccessRepository } from "./app-connection-access.js";
import {
  createRequestConnectionAccessAction,
  grantConnectionAccessOperations,
  REQUEST_CONNECTION_ACCESS_ACTION,
  resolveConnectionAccessRequest,
  type RequestConnectionAccessDeps,
} from "./request-connection-access.js";

function makeFixture(
  options: {
    connections?: Array<{
      id: string;
      connectionKind: string;
      label: string;
      grantState?: "authorized" | "needs_authorization";
      grantEpoch?: string;
      actState?: "unlocked" | "locked";
    }>;
    appEnabled?: boolean;
    ready?: boolean;
  } = {},
) {
  const { db, close } = createTestDb();
  const access = new AppConnectionAccessRepository(db);
  const operations = [
    {
      name: "feishu.document.read",
      description: "Read a Feishu document.",
      inputSchema: { type: "object" },
      appAccess: { sideEffects: "read-only" as const },
    },
    {
      name: "feishu.wiki.spaces",
      description: "List Feishu wiki spaces.",
      inputSchema: { type: "object" },
      appAccess: { sideEffects: "read-only" as const },
    },
    {
      name: "feishu.document.update",
      description: "Update a Feishu document.",
      inputSchema: { type: "object" },
      appAccess: {
        sideEffects: "write" as const,
        approvalRequired: true,
        approvalPreview: {
          summary: "Update document",
          fields: [{ label: "Document", inputPointer: "/documentId" }],
        },
      },
    },
    {
      name: "feishu.internal.raw",
      description: "Core-only operation.",
      inputSchema: { type: "object" },
    },
  ];

  const conns = (
    options.connections ?? [
      {
        id: "feishu-1",
        connectionKind: "feishu",
        label: "Rome local",
        grantState: "authorized" as const,
        grantEpoch: "epoch-1",
        actState: "unlocked" as const,
      },
    ]
  ).map((c) => ({
    id: c.id,
    connectionKind: c.connectionKind,
    label: c.label,
    grantState: c.grantState ?? "authorized",
    grantEpoch: c.grantEpoch ?? "epoch-1",
    status: () => ({ act: { state: c.actState ?? "unlocked" } }),
    act:
      c.actState === "locked"
        ? undefined
        : {
            operations: () => operations,
          },
  }));

  const descriptor = {
    grant: "app",
    capabilities: { actor: { operations } },
  };

  const deps: RequestConnectionAccessDeps = {
    registry: {
      all: () => conns as never,
      getDescriptor: (kind) => (kind === "feishu" ? (descriptor as never) : null),
      grantOf: async (id) => {
        const found = conns.find((c) => c.id === id);
        if (!found) return null;
        return {
          state: found.grantState,
          grantEpoch: found.grantEpoch,
        } as never;
      },
    },
    access,
    lookupApp: (appId) =>
      appId === "lark"
        ? { id: "lark", displayName: "Lark", enabled: options.appEnabled ?? true }
        : null,
    isReady: () => options.ready ?? true,
  };

  return { deps, access, action: createRequestConnectionAccessAction(deps), close };
}

describe("core:request_connection_access", () => {
  it("builds a connection_access preview for read preset by connectionKind", async () => {
    const { action, close } = makeFixture();
    try {
      expect(action.config.name).toBe(REQUEST_CONNECTION_ACCESS_ACTION);
      const preview = await action.preview!({
        appId: "lark",
        connectionKind: "feishu",
        reason: "Read your Feishu wiki spaces",
      });
      expect(preview).toMatchObject({
        kind: "connection_access",
        appId: "lark",
        appName: "Lark",
        connectionId: "feishu-1",
        connectionKind: "feishu",
        connectionLabel: "Rome local",
        identity: "app",
        preset: "read",
        reason: "Read your Feishu wiki spaces",
      });
      if (preview && preview.kind === "connection_access") {
        expect(preview.operations.map((op) => op.name)).toEqual([
          "feishu.document.read",
          "feishu.wiki.spaces",
        ]);
      }
    } finally {
      close();
    }
  });

  it("includes write operations with approvalRequired when preset is read_and_write", async () => {
    const { action, close } = makeFixture();
    try {
      const preview = await action.preview!({
        appId: "lark",
        connectionKind: "feishu",
        preset: "read_and_write",
        reason: "Read and update Feishu documents",
      });
      expect(preview?.kind).toBe("connection_access");
      if (preview && preview.kind === "connection_access") {
        expect(preview.operations).toEqual([
          {
            name: "feishu.document.read",
            sideEffect: "read-only",
            summary: "Read a Feishu document.",
          },
          {
            name: "feishu.wiki.spaces",
            sideEffect: "read-only",
            summary: "List Feishu wiki spaces.",
          },
          {
            name: "feishu.document.update",
            sideEffect: "write",
            summary: "Update a Feishu document.",
            approvalRequired: true,
          },
        ]);
      }
    } finally {
      close();
    }
  });

  it("refuses unknown operations, disabled apps, ambiguous connections, and unready state", async () => {
    const f1 = makeFixture();
    try {
      await expect(
        f1.action.preview!({
          appId: "lark",
          connectionKind: "feishu",
          preset: "custom",
          operations: ["feishu.internal.raw"],
          reason: "Try internal op",
        }),
      ).rejects.toBeInstanceOf(CallRefusal);
    } finally {
      f1.close();
    }

    const f2 = makeFixture({ appEnabled: false });
    try {
      await expect(
        f2.action.preview!({ appId: "lark", connectionKind: "feishu", reason: "Read" }),
      ).rejects.toBeInstanceOf(CallRefusal);
    } finally {
      f2.close();
    }

    const f3 = makeFixture({
      connections: [
        { id: "f1", connectionKind: "feishu", label: "Bot 1" },
        { id: "f2", connectionKind: "feishu", label: "Bot 2" },
      ],
    });
    try {
      await expect(
        f3.action.preview!({ appId: "lark", connectionKind: "feishu", reason: "Read" }),
      ).rejects.toThrow(/Multiple "feishu" connections/);
    } finally {
      f3.close();
    }

    const f4 = makeFixture({ ready: false });
    try {
      await expect(
        f4.action.preview!({ appId: "lark", connectionKind: "feishu", reason: "Read" }),
      ).rejects.toThrow(/startup reconciliation/);
    } finally {
      f4.close();
    }
  });

  it("fails closed if execute is called without approval initiator, and grants on approval", async () => {
    const { action, access, close } = makeFixture();
    try {
      const denied = await action.execute(
        { appId: "lark", connectionKind: "feishu", reason: "Read docs" },
        { emitActionEvent() {} },
      );
      expect(denied.status).toBe("error");
      expect(await access.listActiveForConnection("lark", "feishu-1")).toHaveLength(0);

      const granted = await actionExecutionContext.run(
        { executionId: "exec-1", rootExecutionId: "root-1", initiator: "approval:appr-1" },
        () =>
          action.execute(
            { appId: "lark", connectionKind: "feishu", reason: "Read docs" },
            { emitActionEvent() {} },
          ),
      );
      expect(granted).toMatchObject({
        status: "ok",
        data: {
          appId: "lark",
          connectionId: "feishu-1",
          alreadyGranted: false,
          newlyGranted: ["feishu.document.read", "feishu.wiki.spaces"],
        },
      });
      const stored = await access.listActiveForConnection("lark", "feishu-1");
      expect(stored.map((p) => p.operation).sort()).toEqual([
        "feishu.document.read",
        "feishu.wiki.spaces",
      ]);

      // Subsequent preview returns undefined and execute short-circuits as alreadyGranted
      const secondPreview = await action.preview!({
        appId: "lark",
        connectionKind: "feishu",
        reason: "Read docs again",
      });
      expect(secondPreview).toBeUndefined();

      const secondExec = await action.execute(
        { appId: "lark", connectionKind: "feishu", reason: "Read docs again" },
        { emitActionEvent() {} },
      );
      expect(secondExec).toMatchObject({
        status: "ok",
        data: { alreadyGranted: true },
      });
    } finally {
      close();
    }
  });

  it("preserves custom expiresAt written by the approval endpoint when execute runs afterward", async () => {
    const { deps, action, access, close } = makeFixture();
    try {
      const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 7 * 86_400_000);
      const resolved = await resolveConnectionAccessRequest(deps, {
        appId: "lark",
        connectionKind: "feishu",
        reason: "Temporary read access",
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const grantResult = await grantConnectionAccessOperations(deps, resolved.value, {
        expiresAt,
      });
      expect(grantResult.ok).toBe(true);

      // Action execution triggered by resolveApproval sees missingOperations === 0 and does not overwrite expiresAt
      const execResult = await actionExecutionContext.run(
        { executionId: "exec-1", rootExecutionId: "root-1", initiator: "approval:appr-1" },
        () =>
          action.execute(
            { appId: "lark", connectionKind: "feishu", reason: "Temporary read access" },
            { emitActionEvent() {} },
          ),
      );
      expect(execResult).toMatchObject({ status: "ok", data: { alreadyGranted: true } });

      const stored = await access.listActiveForConnection("lark", "feishu-1");
      expect(stored).toHaveLength(2);
      for (const policy of stored) {
        expect(policy.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
      }
    } finally {
      close();
    }
  });
});
