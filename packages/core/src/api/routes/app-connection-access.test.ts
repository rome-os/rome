import { describe, expect, it, rs } from "@rstest/core";
import {
  FEISHU_DOCUMENT_READ,
  feishuDocumentGuidance,
} from "../../connections/kinds/feishu/index.js";
import { Hono } from "hono";
import { createTestDb } from "../../test/db.js";
import { AppConnectionAccessRepository } from "../../connections/app-connection-access.js";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import type { ApiDeps } from "../deps.js";
import { appConnectionAccessRoutes } from "./app-connection-access.js";

const sameOrigin = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

function makeApp(
  options: {
    appEnabled?: () => boolean;
    checkScopes?: () => Promise<unknown>;
    staticCheck?: "read-only" | "write" | "internal";
    liveCheck?: "read-only" | "write" | "internal";
    actUnavailable?: boolean;
    connectionKind?: string;
    getGrant?: () => Promise<{
      state: "authorized";
      grantedAt: Date;
      grantEpoch: string;
    }>;
  } = {},
) {
  const { db, close } = createTestDb();
  const access = new AppConnectionAccessRepository(db);
  const descriptor = {
    grant: "account",
    documentAccessGuidance:
      options.connectionKind === "feishu"
        ? { operation: FEISHU_DOCUMENT_READ, guidance: feishuDocumentGuidance }
        : undefined,
    appAccessGuidance: options.checkScopes
      ? () => ({ consoleUrl: "https://fixture.test", scopeCheckOperation: "documents.scopes" })
      : undefined,
    capabilities: {
      actor: {
        operations: [
          ...(options.checkScopes
            ? [
                {
                  name: "documents.scopes",
                  description: "Check fixture scopes.",
                  appAccess:
                    options.staticCheck === "internal"
                      ? undefined
                      : { sideEffects: options.staticCheck ?? "read-only" },
                  inputSchema: { type: "object" },
                },
              ]
            : []),
          {
            name: "documents.get",
            description: "Read a document.",
            inputSchema: { type: "object" },
            appAccess: {
              sideEffects: "read-only",
              resourceConstraintKind: "documentIds",
              requiredScopes: ["docs.read"],
              requiredScopeGroups: [["docs.read", "docs.manage"]],
            },
          },
          {
            name: "documents.create",
            description: "Create a document.",
            inputSchema: { type: "object" },
            appAccess: {
              sideEffects: "write",
              approvalRequired: true,
              approvalPreview: {
                summary: "Create a document.",
                fields: [{ label: "Title", inputPointer: "/title" }],
              },
            },
          },
          {
            name: "raw.http",
            description: "Core only.",
            inputSchema: { type: "object" },
          },
          {
            name: "documents.unsafe-create",
            description: "Write without a safe approval preview.",
            inputSchema: { type: "object" },
            appAccess: { sideEffects: "write" },
          },
        ],
      },
    },
  };
  const connection = {
    id: "connection-1",
    connectionKind: options.connectionKind ?? "fake-docs",
    label: "Fixture Bot",
    status: () => ({ act: { state: "unlocked" } }),
    act: options.actUnavailable
      ? undefined
      : {
          operations: () =>
            descriptor.capabilities.actor.operations.map((op) =>
              op.name === "documents.scopes" && options.liveCheck
                ? {
                    ...op,
                    appAccess:
                      options.liveCheck === "internal"
                        ? undefined
                        : { sideEffects: options.liveCheck },
                  }
                : op,
            ),
          invoke: options.checkScopes,
        },
  };
  const deps = {
    db,
    appCatalog: {
      get: (appId: string) =>
        appId === "notes" || appId === "@acme/notes"
          ? {
              appId,
              enabled: options.appEnabled?.() ?? true,
              state: "installed",
              manifest: {},
            }
          : null,
    },
    connectionRegistry: {
      all: () => [connection],
      getDescriptor: (kind: string) =>
        kind === (options.connectionKind ?? "fake-docs") ? descriptor : null,
      grantOf:
        options.getGrant ??
        (async () => ({
          state: "authorized" as const,
          grantedAt: new Date("2026-10-26T00:00:00.000Z"),
          grantEpoch: "grant-1",
        })),
    },
    appConnectionAccessRepo: access,
  } as unknown as ApiDeps;
  const app = new Hono();
  app.route("/", appConnectionAccessRoutes(deps));
  const request = (
    path: string,
    init?: RequestInit,
    actor: SessionActor = { kind: "guardian", userId: "guardian", via: "cookie" },
  ) => runWithSessionActor(actor, () => app.request(path, init));
  return { request, close, access };
}

describe("App connection access management", () => {
  it("persists and revokes an exact App, connection, identity, and operation grant", async () => {
    const { request, close } = makeApp();
    try {
      const path = "/app-connection-access/notes/connection-1/account/documents.get";
      const put = await request(path, {
        method: "PUT",
        headers: sameOrigin,
        body: JSON.stringify({
          approval: "not_required",
          constraints: [{ inputPointer: "/workspaceId", allowedValues: ["workspace-1"] }],
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        policy: {
          appId: "notes",
          connectionId: "connection-1",
          identity: "account",
          operation: "documents.get",
          sideEffects: "read-only",
          revision: 1,
        },
      });

      const listed = await request("/app-connection-access/notes");
      expect(await listed.json()).toMatchObject({
        policies: [{ operation: "documents.get", grantStatus: "current" }],
      });

      expect((await request(path, { method: "DELETE", headers: sameOrigin })).status).toBe(204);
      expect(await (await request("/app-connection-access/notes")).json()).toEqual({
        policies: [],
      });
    } finally {
      close();
    }
  });

  it("marks a policy stale when giving the grant again replaces its epoch", async () => {
    let grantEpoch = "grant-1";
    const { request, close } = makeApp({
      getGrant: async () => ({
        state: "authorized",
        grantedAt: new Date("2026-10-26T00:00:00.000Z"),
        grantEpoch,
      }),
    });
    try {
      const path = "/app-connection-access/notes/connection-1/account/documents.get";
      expect(
        (
          await request(path, {
            method: "PUT",
            headers: sameOrigin,
            body: JSON.stringify({ approval: "not_required", constraints: [] }),
          })
        ).status,
      ).toBe(200);

      grantEpoch = "grant-2";
      expect(await (await request("/app-connection-access/notes")).json()).toMatchObject({
        policies: [{ operation: "documents.get", grantStatus: "replaced" }],
      });
    } finally {
      close();
    }
  });

  it("cannot recreate access after concurrent App disable completes", async () => {
    let enabled = true;
    let enteredGrantLookup!: () => void;
    let releaseGrantLookup!: () => void;
    const grantLookupStarted = new Promise<void>((resolve) => {
      enteredGrantLookup = resolve;
    });
    const grantLookupReleased = new Promise<void>((resolve) => {
      releaseGrantLookup = resolve;
    });
    const { request, close, access } = makeApp({
      appEnabled: () => enabled,
      getGrant: async () => {
        enteredGrantLookup();
        await grantLookupReleased;
        return {
          state: "authorized",
          grantedAt: new Date("2026-10-26T00:00:00.000Z"),
          grantEpoch: "grant-1",
        };
      },
    });
    try {
      const pendingPut = request(
        "/app-connection-access/notes/connection-1/account/documents.get",
        {
          method: "PUT",
          headers: sameOrigin,
          body: JSON.stringify({ approval: "not_required", constraints: [] }),
        },
      );
      await grantLookupStarted;
      enabled = false;
      await access.revokeApp("notes");
      releaseGrantLookup();

      expect((await pendingPut).status).toBe(409);
      expect(await access.listActiveForApp("notes")).toEqual([]);
    } finally {
      close();
    }
  });

  it("cannot grant a Core-only raw operation", async () => {
    const { request, close } = makeApp();
    try {
      const response = await request("/app-connection-access/notes/connection-1/account/raw.http", {
        method: "PUT",
        headers: sameOrigin,
        body: JSON.stringify({ approval: "not_required", constraints: [] }),
      });
      expect(response.status).toBe(404);
    } finally {
      close();
    }
  });

  it("cannot grant a write operation without a safe approval preview", async () => {
    const { request, close } = makeApp();
    try {
      const response = await request(
        "/app-connection-access/notes/connection-1/account/documents.unsafe-create",
        {
          method: "PUT",
          headers: sameOrigin,
          body: JSON.stringify({ approval: "required", constraints: [] }),
        },
      );
      expect(response.status).toBe(404);
    } finally {
      close();
    }
  });

  it("rejects deferred approval for reads", async () => {
    const { request, close } = makeApp();
    try {
      const response = await request(
        "/app-connection-access/notes/connection-1/account/documents.get",
        {
          method: "PUT",
          headers: sameOrigin,
          body: JSON.stringify({ approval: "required", constraints: [] }),
        },
      );
      expect(response.status).toBe(400);
    } finally {
      close();
    }
  });

  it("accepts an encoded scoped App id", async () => {
    const { request, close } = makeApp();
    try {
      const appId = "@acme/notes";
      const path = `/app-connection-access/${encodeURIComponent(appId)}/connection-1/account/documents.get`;
      const response = await request(path, {
        method: "PUT",
        headers: sameOrigin,
        body: JSON.stringify({ approval: "not_required", constraints: [] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ policy: { appId } });
    } finally {
      close();
    }
  });

  it("rejects a policy mutation outside the guardian origin", async () => {
    const { request, close } = makeApp();
    try {
      const response = await request(
        "/app-connection-access/notes/connection-1/account/documents.get",
        {
          method: "PUT",
          headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
          body: JSON.stringify({ approval: "not_required", constraints: [] }),
        },
      );
      expect(response.status).toBe(403);
      expect(await (await request("/app-connection-access/notes")).json()).toEqual({
        policies: [],
      });
    } finally {
      close();
    }
  });

  it("pages the redacted audit trail", async () => {
    const { request, close, access } = makeApp();
    try {
      for (const executionId of ["execution-1", "execution-2"]) {
        await access.appendAudit({
          appId: "notes",
          connectionId: "connection-1",
          identity: "account",
          operation: "documents.get",
          approval: "not_required",
          executionId,
          status: "succeeded",
        });
      }
      const first = await (await request("/app-connection-access/notes/audit?limit=1")).json();
      expect(first).toMatchObject({
        events: [{ executionId: "execution-1" }],
        nextCursor: 1,
      });
      const second = await (
        await request(`/app-connection-access/notes/audit?limit=1&cursor=${first.nextCursor}`)
      ).json();
      expect(second).toMatchObject({ events: [{ executionId: "execution-2" }] });
      expect(second).not.toHaveProperty("nextCursor");
    } finally {
      close();
    }
  });
});

describe("Document access discovery", () => {
  it("shows safe provider guidance without inspecting scopes or exposing grant material", async () => {
    const h = makeApp({
      connectionKind: "feishu",
      getGrant: async () => ({
        state: "authorized",
        grantedAt: new Date(),
        grantEpoch: "grant-fixture",
        profile: { appId: "cli_fixture", domain: "lark" },
        credential: { material: { appSecret: "SYNTHETIC_NOT_FOR_UI" } },
      }),
    });
    try {
      const path = "/app-connection-access/notes/documents?limit=1";
      const response = await h.request(path);
      expect(response.status).toBe(200);
      const value = await response.json();
      expect(value).toMatchObject({
        connections: [
          {
            connectionId: "connection-1",
            scopeStatus: "not_checked",
            scope: "docx:document:readonly",
            supported: false,
            consoles: [{ brand: "lark", url: "https://open.larksuite.com/app/cli_fixture/auth" }],
          },
        ],
      });
      expect(JSON.stringify(value)).not.toContain("SYNTHETIC_NOT_FOR_UI");
      expect((await h.request("/app-connection-access/missing/documents")).status).toBe(404);
      expect((await h.request("/app-connection-access/notes/documents?limit=101")).status).toBe(
        400,
      );
    } finally {
      h.close();
    }
  });
});

describe("Connection-scoped App access", () => {
  const path = "/app-connection-access/connections/connection-1";
  const policy = { appId: "@acme/notes", identity: "account", operation: "documents.get" };
  const constraint = { inputPointer: "/documentId", allowedValues: ["Doc1"] };
  function put(body: object): RequestInit {
    return { method: "PUT", headers: sameOrigin, body: JSON.stringify(body) };
  }

  it("discovers operations with zero policies and manages scoped apps by connection", async () => {
    const h = makeApp();
    try {
      const empty = await (await h.request(path)).json();
      expect(empty).toMatchObject({
        connection: {
          connectionId: "connection-1",
          connectionKind: "fake-docs",
          label: "Fixture Bot",
        },
        policies: [],
        identities: [
          {
            identity: "account",
            actState: "available",
            operations: [
              {
                name: "documents.get",
                sideEffect: "read-only",
                requiredScopes: ["docs.read"],
                requiredScopeGroups: [["docs.read", "docs.manage"]],
                resourceConstraintKind: "documentIds",
              },
              {
                name: "documents.create",
                sideEffect: "write",
                approvalPreviewSummary: "Create a document.",
              },
            ],
          },
        ],
      });
      expect(
        await (
          await h.request(path + "/policies", put({ ...policy, constraints: [constraint] }))
        ).json(),
      ).toMatchObject({
        policy: {
          ...policy,
          approvalMode: "not_required",
          constraints: [constraint],
          grantStatus: "current",
          revision: 1,
        },
      });
      expect(
        (
          await h.request(
            path + "/policies",
            put({ ...policy, appId: "notes", operation: "documents.create" }),
          )
        ).status,
      ).toBe(200);
      expect((await (await h.request(path)).json()).policies).toMatchObject([
        { ...policy },
        { appId: "notes", operation: "documents.create", approvalMode: "required" },
      ]);
      for (const input of [
        { ...policy, constraints: [{ ...constraint, allowedValues: ["../Doc1"] }] },
        { ...policy, constraints: [{ ...constraint, inputPointer: "/other" }] },
        { ...policy, operation: "documents.create", constraints: [constraint] },
        { ...policy, operation: "documents.create", approvalMode: "not_required" },
        { ...policy, approvalMode: "required" },
        { ...policy, expectedRevision: -1 },
        { ...policy, expectedRevision: 1.5 },
        { ...policy, expiresAt: "2000-01-01T00:00:00Z" },
      ])
        expect((await h.request(path + "/policies", put(input))).status).toBe(400);
      expect(
        (
          await h.request(
            "/app-connection-access/notes/connection-1/account/documents.create",
            put({ approval: "not_required" }),
          )
        ).status,
      ).toBe(400);
      const del = path + "/policies/%40acme%2Fnotes/account/documents.get";
      expect((await h.request(del, { method: "DELETE" })).status).toBe(403);
      expect((await h.request(del, { method: "DELETE", headers: sameOrigin })).status).toBe(204);
      expect(
        (await h.access.listActiveForConnectionId("connection-1")).map((p) => p.appId),
      ).toEqual(["notes"]);
    } finally {
      h.close();
    }
  });

  it("rejects a stale expiry edit without restoring removed documents", async () => {
    const h = makeApp();
    try {
      const save = (expectedRevision: number, allowedValues: string[], expiresAt?: string) =>
        h.request(
          path + "/policies",
          put({
            ...policy,
            expectedRevision,
            constraints: [{ ...constraint, allowedValues }],
            expiresAt,
          }),
        );
      const original = ["A", "B"];
      expect((await save(1, original)).status).toBe(409);
      expect((await save(0, original)).status).toBe(200);
      expect((await save(0, original)).status).toBe(409);
      expect((await save(1, ["A"])).status).toBe(200);
      const stale = await save(1, original, "2099-01-01T00:00:00Z");
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: "policy_conflict",
        message: expect.any(String),
      });
      expect((await (await h.request(path)).json()).policies).toMatchObject([
        {
          revision: 2,
          constraints: [{ ...constraint, allowedValues: ["A"] }],
          expiresAt: null,
        },
      ]);

      await h.access.revoke(policy.appId, "connection-1", policy.identity, policy.operation);
      expect((await save(2, original)).status).toBe(409);
      expect((await save(0, ["A"])).status).toBe(200);
    } finally {
      h.close();
    }
  });

  it("preserves constraints from the legacy policy route through scoped edits", async () => {
    const h = makeApp();
    try {
      const extra = { inputPointer: "/workspace", allowedValues: ["internal"] };
      const original = [constraint, extra, { ...constraint, allowedValues: ["Doc1", "Doc2"] }];
      const legacy = "/app-connection-access/%40acme%2Fnotes/connection-1/account/documents.get";
      expect(
        (await h.request(legacy, put({ approval: "not_required", constraints: original }))).status,
      ).toBe(200);
      for (const constraints of [original, [extra, { ...constraint, allowedValues: ["Doc2"] }]]) {
        const response = await h.request(
          path + "/policies",
          put({ ...policy, constraints, expiresAt: "2099-01-01T00:00:00Z" }),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).policy.constraints).toEqual(constraints);
      }
      expect(
        (await h.request(path + "/policies", put({ ...policy, constraints: [constraint] }))).status,
      ).toBe(400);
    } finally {
      h.close();
    }
  });

  it("requires explicit read-only scope checks on both the static and live operations", async () => {
    for (const [staticCheck, liveCheck] of [
      ["internal", "read-only"],
      ["read-only", "internal"],
      ["write", "read-only"],
      ["read-only", "write"],
    ] as const) {
      const checkScopes = rs.fn(async () => ({ scopes: [], checkedAt: new Date().toISOString() }));
      const h = makeApp({ checkScopes, staticCheck, liveCheck });
      try {
        const response = await h.request(path + "/scopes/check", {
          method: "POST",
          headers: sameOrigin,
        });
        expect((await response.json()).status).toBe("unsupported");
        expect(checkScopes).not.toHaveBeenCalled();
      } finally {
        h.close();
      }
    }
  });

  it("checks only the declared live diagnostic and strips provider fields and thrown text", async () => {
    const checkedAt = new Date().toISOString();
    let value: unknown = {
      checkedAt,
      scopes: [{ scopeName: "docs.read", grantStatus: 1, scopeType: "tenant", raw: "SECRET" }],
      credential: "SECRET",
    };
    let calls = 0;
    const h = makeApp({
      checkScopes: async () => {
        calls++;
        if (value instanceof Error) throw value;
        return value;
      },
    });
    const check = () => h.request(path + "/scopes/check", { method: "POST", headers: sameOrigin });
    try {
      expect(
        (await (await h.request(path)).json()).identities[0].providerGuidance.scopeCheckOperation,
      ).toBe("documents.scopes");
      expect((await h.request(path + "/scopes/check", { method: "POST" })).status).toBe(403);
      expect(calls).toBe(0);
      expect(await (await check()).json()).toEqual({
        status: "checked",
        checkedAt,
        scopes: [{ scopeName: "docs.read", grantStatus: 1, scopeType: "tenant" }],
      });
      value = { scopes: "SECRET" };
      expect(await (await check()).json()).toMatchObject({
        status: "error",
        errorCode: "provider_response_invalid",
      });
      value = new Error("SECRET");
      const error = await (await check()).json();
      expect(error).toMatchObject({ status: "error", errorCode: "provider_unavailable" });
      expect(JSON.stringify(error)).not.toContain("SECRET");
    } finally {
      h.close();
    }
    for (const [options, status] of [
      [{}, "unsupported"],
      [
        {
          actUnavailable: true,
          checkScopes: async () => {
            throw new Error("unexpected");
          },
        },
        "unavailable",
      ],
    ] as const) {
      const other = makeApp(options);
      try {
        expect(
          await (
            await other.request(path + "/scopes/check", { method: "POST", headers: sameOrigin })
          ).json(),
        ).toMatchObject({ status });
      } finally {
        other.close();
      }
    }
  });

  it("pages newest-first by exclusive sequence across apps and retains filters on subsequent pages", async () => {
    const h = makeApp();
    try {
      for (const [appId, connectionId] of [
        ["notes", "connection-1"],
        ["other", "connection-1"],
        ["notes", "elsewhere"],
        ["notes", "connection-1"],
      ]) {
        await h.access.appendAudit({
          appId,
          connectionId,
          identity: "account",
          operation: "documents.get",
          executionId: "id",
          approval: "not_required",
          status: "succeeded",
        });
      }
      const first = await (await h.request(path + "/audit?limit=2")).json();
      expect(first.entries.map((row: { seq: number }) => row.seq)).toEqual([4, 2]);
      expect(first.nextBeforeSeq).toBe(2);
      expect(await (await h.request(path + "/audit?beforeSeq=2&limit=2")).json()).toMatchObject({
        entries: [{ seq: 1 }],
        nextBeforeSeq: null,
      });
      expect(await (await h.request(path + "/audit?appId=notes&beforeSeq=4")).json()).toMatchObject(
        { entries: [{ seq: 1 }], nextBeforeSeq: null },
      );
      expect((await h.request(path + "/audit?limit=101")).status).toBe(400);
      expect((await h.request(path + "/audit?beforeSeq=-1")).status).toBe(400);
    } finally {
      h.close();
    }
  });
});
