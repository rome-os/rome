import { describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { createTestDb } from "../../test/helpers.js";
import { AppConnectionAccessRepository } from "../../db/repositories/app-connection-access.js";
import type { ApiDeps } from "../deps.js";
import { appConnectionAccessRoutes } from "./app-connection-access.js";

const sameOrigin = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

function makeApp() {
  const { db, close } = createTestDb();
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
            name: "raw.http",
            description: "Core only.",
            inputSchema: { type: "object" },
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
              enabled: true,
              state: "installed",
              manifest: {},
            }
          : null,
    },
    connectionRegistry: {
      all: () => [connection],
      getDescriptor: (kind: string) => (kind === "fake-docs" ? descriptor : null),
    },
  } as unknown as ApiDeps;
  const app = new Hono();
  app.route("/", appConnectionAccessRoutes(deps));
  return { app, close, access: new AppConnectionAccessRepository(db) };
}

describe("App connection access management", () => {
  it("persists and revokes an exact App, connection, identity, and operation grant", async () => {
    const { app, close } = makeApp();
    try {
      const path = "/app-connection-access/notes/connection-1/account/documents.get";
      const put = await app.request(path, {
        method: "PUT",
        headers: sameOrigin,
        body: JSON.stringify({
          approval: "required",
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
          revision: 1,
        },
      });

      const listed = await app.request("/app-connection-access/notes");
      expect(await listed.json()).toMatchObject({ policies: [{ operation: "documents.get" }] });

      expect((await app.request(path, { method: "DELETE", headers: sameOrigin })).status).toBe(204);
      expect(await (await app.request("/app-connection-access/notes")).json()).toEqual({
        policies: [],
      });
    } finally {
      close();
    }
  });

  it("cannot grant a Core-only raw operation", async () => {
    const { app, close } = makeApp();
    try {
      const response = await app.request(
        "/app-connection-access/notes/connection-1/account/raw.http",
        {
          method: "PUT",
          headers: sameOrigin,
          body: JSON.stringify({ approval: "not_required", constraints: [] }),
        },
      );
      expect(response.status).toBe(404);
    } finally {
      close();
    }
  });

  it("accepts an encoded scoped App id", async () => {
    const { app, close } = makeApp();
    try {
      const appId = "@acme/notes";
      const path = `/app-connection-access/${encodeURIComponent(appId)}/connection-1/account/documents.get`;
      const response = await app.request(path, {
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
    const { app, close } = makeApp();
    try {
      const response = await app.request(
        "/app-connection-access/notes/connection-1/account/documents.get",
        {
          method: "PUT",
          headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
          body: JSON.stringify({ approval: "not_required", constraints: [] }),
        },
      );
      expect(response.status).toBe(403);
      expect(await (await app.request("/app-connection-access/notes")).json()).toEqual({
        policies: [],
      });
    } finally {
      close();
    }
  });

  it("pages the redacted audit trail", async () => {
    const { app, close, access } = makeApp();
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
      const first = await (await app.request("/app-connection-access/notes/audit?limit=1")).json();
      expect(first).toMatchObject({
        events: [{ executionId: "execution-1" }],
        nextCursor: 1,
      });
      const second = await (
        await app.request(`/app-connection-access/notes/audit?limit=1&cursor=${first.nextCursor}`)
      ).json();
      expect(second).toMatchObject({ events: [{ executionId: "execution-2" }] });
      expect(second).not.toHaveProperty("nextCursor");
    } finally {
      close();
    }
  });
});
