import { describe, expect, it } from "@rstest/core";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { createActionEngineRepos, createTestDb } from "../test/db.js";
import { ConnectionRegistry } from "./registry.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import { AppConnectionAccessRepository } from "./app-connection-access.js";
import { AppConnectionBroker } from "./app-connections.js";
import { feishu, type FeishuDescriptorDeps } from "./kinds/feishu/index.js";
const operation = "feishu.document.read";
function harness(request?: FeishuDescriptorDeps["request"]) {
  const { db, close } = createTestDb();
  const calls: Array<{ bot: string; documentId: string }> = [];
  let gate: Promise<void> | undefined;
  let entered = () => {};
  let reply: unknown = { code: 0, data: { content: "SYNTHETIC_DOCUMENT_BODY" } };
  const { descriptor: full } = feishu({
    request,
    chatSettings: {} as never,
    pressed: async () => false,
    listAgents: () => [],
    documentRequest: async (material, documentId) => {
      calls.push({ bot: material.appId, documentId });
      entered();
      await gate;
      return reply;
    },
  });
  if (!full) throw new Error("Expected Feishu descriptor");
  const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
  registry.register({ ...full, capabilities: { actor: full.capabilities.actor } });
  const access = new AppConnectionAccessRepository(db);
  const actions = new ActionRegistryImpl();
  const engine = new ActionEngine(actions, createActionEngineRepos(db), { processRole: "worker" });
  const broker = new AppConnectionBroker(registry, access, engine);
  broker.registerActions(actions);
  const connect = async (bot: string, another = false) => {
    const connection = another
      ? await registry.connectAnother("feishu", bot)
      : await registry.connect("feishu", bot);
    await registry.giveGrant(
      "feishu",
      connection.id,
      "app",
      {
        material: { appId: bot, appSecret: "synthetic-only", domain: "feishu" },
        expiresAt: "never",
      },
      { appId: bot, domain: "feishu" },
    );
    return connection;
  };
  const grant = async (
    appId: string,
    connectionId: string,
    documentId: string,
    expiresAt?: Date,
  ) => {
    const current = await registry.grantOf(connectionId);
    await access.put({
      appId,
      connectionId,
      identity: "app",
      operation,
      sideEffects: "read-only",
      approval: "not_required",
      grantEpoch: current!.grantEpoch!,
      constraints: [{ inputPointer: "/documentId", allowedValues: [documentId] }],
      expiresAt,
    });
  };
  return {
    db,
    actions,
    close,
    registry,
    access,
    broker,
    calls,
    connect,
    grant,
    holdReads: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { started, release };
    },
    setReply: (value: unknown) => {
      reply = value;
    },
  };
}
describe("Feishu document access through the App gateway", () => {
  it("shares one operation across independently authorized apps without sharing their grants", async () => {
    const h = harness();
    try {
      const bot = await h.connect("cli_botA");
      const input = {
        connectionId: bot.id,
        identity: "app",
        operation,
        input: { documentId: "DocumentA" },
      };
      expect(await h.broker.forApp("app-a").list()).toEqual({ connections: [] });
      await expect(h.broker.forApp("app-a").invoke(input)).rejects.toThrow();
      expect(h.calls).toHaveLength(0);
      await h.grant("app-a", bot.id, "DocumentA");
      expect(await h.broker.forApp("app-a").invoke(input)).toMatchObject({
        status: "ok",
        data: { content: "SYNTHETIC_DOCUMENT_BODY" },
      });
      await expect(h.broker.forApp("app-b").invoke(input)).rejects.toThrow();
      await h.grant("app-b", bot.id, "DocumentA");
      expect(await h.broker.forApp("app-b").invoke(input)).toMatchObject({ status: "ok" });
      await h.access.revoke("app-a", bot.id, "app", operation);
      await expect(h.broker.forApp("app-a").invoke(input)).rejects.toThrow();
      expect(await h.broker.forApp("app-b").invoke(input)).toMatchObject({ status: "ok" });
      expect(h.calls).toHaveLength(3);
      expect(JSON.stringify(await h.access.listAuditForApp("app-a", 0, 100))).not.toContain(
        "SYNTHETIC_DOCUMENT_BODY",
      );
    } finally {
      await h.registry.stopAll();
      h.close();
    }
  });
  it("rejects another document, another bot, expired policies and a replaced provider grant before provider reads", async () => {
    const h = harness();
    try {
      const bot = await h.connect("cli_botA");
      const other = await h.connect("cli_botB", true);
      await h.grant("app-a", bot.id, "DocumentA");
      const base = {
        connectionId: bot.id,
        identity: "app",
        operation,
        input: { documentId: "DocumentA" },
      };
      for (const input of [
        { ...base, input: { documentId: "DocumentB" } },
        { ...base, connectionId: other.id },
        { ...base, identity: "user" },
        { ...base, operation: "raw.http" },
      ])
        await expect(h.broker.forApp("app-a").invoke(input)).rejects.toThrow();
      await h.grant("app-a", bot.id, "DocumentA", new Date(Date.now() - 1000));
      await expect(h.broker.forApp("app-a").invoke(base)).rejects.toThrow();
      await h.grant("app-a", bot.id, "DocumentA");
      await h.registry.giveGrant(
        "feishu",
        bot.id,
        "app",
        {
          material: { appId: "cli_botA", appSecret: "synthetic-replacement", domain: "feishu" },
          expiresAt: "never",
        },
        { appId: "cli_botA" },
      );
      await expect(h.broker.forApp("app-a").invoke(base)).rejects.toThrow();
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.registry.stopAll();
      h.close();
    }
  });
  it("keeps provider permission failures distinct and does not include raw provider output", async () => {
    const h = harness();
    try {
      const bot = await h.connect("cli_botA");
      await h.grant("app-a", bot.id, "DocumentA");
      h.setReply({ code: 99991672, msg: "SYNTHETIC_PRIVATE_MESSAGE" });
      await expect(
        h.broker.forApp("app-a").invoke({
          connectionId: bot.id,
          identity: "app",
          operation,
          input: { documentId: "DocumentA" },
        }),
      ).rejects.toMatchObject({
        detail: {
          code: "provider_error",
          reason: "provider_scope_required",
          message: "The connection provider rejected the operation.",
          retryable: false,
        },
      });
    } finally {
      await h.registry.stopAll();
      h.close();
    }
  });
  it("discards an in-flight read result if the app grant is revoked before completion", async () => {
    const h = harness();
    try {
      const bot = await h.connect("cli_botA");
      await h.grant("app-a", bot.id, "DocumentA");
      const held = h.holdReads();
      const pending = h.broker.forApp("app-a").invoke({
        connectionId: bot.id,
        identity: "app",
        operation,
        input: { documentId: "DocumentA" },
      });
      await held.started;
      await h.access.revoke("app-a", bot.id, "app", operation);
      held.release();
      await expect(pending).rejects.toMatchObject({ detail: { code: "access_denied" } });
    } finally {
      await h.registry.stopAll();
      h.close();
    }
  });
});

it("executes a constrained Feishu write only after approval and audits the redacted result", async () => {
  const providerCalls: string[] = [];
  const h = harness(async (_, endpoint) => {
    providerCalls.push(endpoint.url);
    return { code: 0, data: { document_revision_id: 3 } };
  });
  try {
    const connection = await h.connect("cli_writer");
    const operation = "feishu.document.update";
    const request = {
      connectionId: connection.id,
      identity: "app",
      operation,
      requestId: "unique-request",
      input: { documentId: "Doc1", mode: "append", content: "private paragraphs" },
    };
    const policy = {
      appId: "notes",
      connectionId: connection.id,
      identity: "app",
      operation,
      sideEffects: "write" as const,
      constraints: [{ inputPointer: "/documentId", allowedValues: ["Doc1"] }],
      grantEpoch: (await h.registry.grantOf(connection.id))!.grantEpoch!,
    };
    const app = h.broker.forApp("notes");
    await h.access.put({ ...policy, approval: "not_required" });
    await expect(app.invoke(request)).rejects.toMatchObject({ detail: { code: "access_denied" } });
    await h.access.put({ ...policy, approval: "required" });
    await expect(
      app.invoke({ ...request, input: { ...request.input, documentId: "Other" } }),
    ).rejects.toMatchObject({ detail: { code: "resource_denied" } });
    const pending = await app.invoke(request);
    expect(pending.status).toBe("pending_approval");
    expect(providerCalls).toEqual([]);
    if (pending.status !== "pending_approval") throw new Error("Expected approval");
    const result = await h.actions
      .get("core:app_connection_write")!
      .execute({ invocationId: pending.executionId });
    expect(result).toMatchObject({ status: "ok", data: { ok: true } });
    expect(providerCalls).toEqual(["/open-apis/docx/v1/documents/Doc1/blocks/Doc1/children"]);
    const audit = await h.access.listAuditForConnection(connection.id);
    expect(audit.entries[0]).toMatchObject({
      operation,
      approval: "approved",
      status: "succeeded",
    });
    expect(JSON.stringify(audit)).not.toContain("private paragraphs");
  } finally {
    await h.registry.stopAll();
    h.close();
  }
});
