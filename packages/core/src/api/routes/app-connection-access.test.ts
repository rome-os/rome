import { describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { createTestDb } from "../../test/helpers.js";
import { AppConnectionAccessRepository } from "../../db/repositories/app-connection-access.js";
import { runWithSessionActor, type SessionActor } from "../../lib/session-actor.js";
import type { ApiDeps } from "../deps.js";
import { appConnectionAccessRoutes } from "./app-connection-access.js";

const sameOrigin = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

function makeApp(
  options: {
    appEnabled?: () => boolean;
    getGrant?: () => Promise<{
      state: "authorized";
      grantedAt: Date;
      grantEpoch: string;
    }>;
  } = {},
) {
  const { db, close } = createTestDb();
  const access = new AppConnectionAccessRepository(db);
  const connection = {
    id: "connection-1",
    connectionKind: "fake-docs",
  };
  const descriptor = {
    grant: "account",
    capabilities: {
      actor: {
        operations: [
          {
            name: "documents.get",
            description: "Read a document.",
            inputSchema: { type: "object" },
            appAccess: { sideEffects: "read-only" },
          },
          {
            name: "documents.create",
            description: "Create a document.",
            inputSchema: { type: "object" },
            appAccess: {
              sideEffects: "write",
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
      getDescriptor: (kind: string) => (kind === "fake-docs" ? descriptor : null),
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

  it("requires guardian identity for policy and audit routes", async () => {
    const { request, close } = makeApp();
    try {
      const visitor = {
        kind: "visitor",
        accountId: "visitor-1",
        email: "visitor@example.com",
      } as const;
      expect((await request("/app-connection-access/notes", undefined, visitor)).status).toBe(403);
      expect(
        (
          await request(
            "/app-connection-access/notes/connection-1/account/documents.get",
            {
              method: "PUT",
              headers: sameOrigin,
              body: JSON.stringify({ approval: "not_required", constraints: [] }),
            },
            visitor,
          )
        ).status,
      ).toBe(403);
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
