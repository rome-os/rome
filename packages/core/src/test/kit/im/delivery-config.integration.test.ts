import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { createTestDb } from "../../helpers.js";
import { ConnectionRegistry } from "../../../connections/registry.js";
import { DrizzleGrantLedger } from "../../../connections/ledger-db.js";
import { createTalkRouter } from "../../../connections/talk-router.js";
import { createFeishuDescriptor } from "../../../connections/integrations/feishu.js";
import { createWechatDescriptor } from "../../../connections/integrations/wechat.js";
import { WechatAdapter } from "../../../channels/wechat.js";
import { ConversationSettingsRepository } from "../../../conversation-settings/repository.js";
import { ConversationSettingsService } from "../../../conversation-settings/service.js";
import { PersonMappingRepository } from "../../../db/repositories/person-mapping.js";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { SettingsRepository } from "../../../db/repositories/settings.js";
import { replyDeliveryParts } from "../../../db/schema.js";
import type { DeliveryProfile } from "../../../connections/delivery/profile.js";
import { LarkApiFixture, LARK_CHAT } from "./lark.js";
import { WechatApiFixture, WECHAT_ORIGIN, WECHAT_USER } from "./wechat.js";
import { requestBarrier } from "./server.js";
import { wechatDeliveryProfile } from "../../../connections/integrations/delivery-profiles.js";

async function deliveryStack(
  platform: "feishu" | "wechat",
  defaults: Partial<DeliveryProfile> = {},
) {
  const directory = await mkdtempDisposable(join(tmpdir(), "rome-delivery-config-"));
  await writeFile(
    join(directory.path, "context_tokens.json"),
    JSON.stringify({ [WECHAT_USER]: "fixture-context" }),
  );
  const test = createTestDb();
  const Fixture = { feishu: LarkApiFixture, wechat: WechatApiFixture }[platform];
  const fixture = new Fixture();
  await fixture.start();
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(test.db) });
  const settings = new SettingsRepository(test.db);
  const conversationSettings = new ConversationSettingsService({
    repository: new ConversationSettingsRepository(test.db),
    connections: registry,
    listAgents: () => [],
  });
  registry.register(
    fixture instanceof LarkApiFixture
      ? createFeishuDescriptor({
          conversationSettings,
          personMappingRepo: new PersonMappingRepository(test.db),
          listAgents: () => [],
          createChannel: (config) => fixture.createChannel(config),
        })
      : createWechatDescriptor({
          createAdapter: (config) =>
            new WechatAdapter({ ...config, statePath: directory.path }, fixture.fetch),
        }),
  );
  const connection = await registry.connect(platform);
  const router = createTalkRouter(
    registry,
    undefined,
    settings,
    new ReplyDeliveryRepository(test.db),
    {
      coalesceMs: 0,
      operationSpacingMs: 0,
      createSpacingMs: 0,
      updateSpacingMs: 0,
      conversationSpacingMs: 0,
      ...defaults,
    },
  );
  await registry.importCredential(connection.id, platform === "feishu" ? "app" : "account", {
    material:
      fixture instanceof LarkApiFixture
        ? { appId: fixture.appId, appSecret: fixture.appSecret }
        : { token: "fixture-token", baseUrl: WECHAT_ORIGIN, accountId: "fixture-bot" },
    expiresAt: "never",
  });
  if (fixture instanceof LarkApiFixture) await fixture.untilConnected();
  else await fixture.untilPolling();
  const path = { feishu: "/open-apis/im/v1/messages", wechat: "/ilink/bot/sendmessage" }[platform];
  return {
    fixture,
    test,
    path,
    configure: (overrides: unknown) =>
      settings.set(`connection_delivery:${connection.id}`, overrides),
    run: (id: string) =>
      router.createRunDelivery(connection.id, id, {
        conversationId: { feishu: LARK_CHAT, wechat: WECHAT_USER }[platform] as ConversationId,
      }),
    texts: (): string[] =>
      fixture instanceof LarkApiFixture
        ? [...fixture.messages.values()].map((message) => JSON.parse(message.body.content).text)
        : fixture.messages.map((message) =>
            (message.item_list as Array<{ text_item: { text: string } }>)
              .map((item) => item.text_item.text)
              .join(""),
          ),
    creates: () =>
      fixture.server.calls.filter((call) => call.method === "POST" && call.path === path),
    async [Symbol.asyncDispose]() {
      await registry.stopAll();
      await fixture.close();
      test.close();
      await directory[Symbol.asyncDispose]();
    },
  };
}

describe.each([
  "feishu",
  "wechat",
] as const)("%s delivery configuration and physical parts", (platform) => {
  it.each([
    "edit",
    "blocks",
    "final",
  ] as const)("uses the connection %s mode over global final defaults", async (mode) => {
    await using stack = await deliveryStack(platform, {
      mode: "final",
      maxPartSize: 12,
      coalesceMs: 10_000,
    });
    await stack.configure({ mode, maxPartSize: 4, coalesceMs: 0, maxPendingAgeMs: 10_000 });
    const run = (await stack.run(`mode-${mode}`))!;
    try {
      run.append("中文👋A");
      if (mode !== "final") {
        await rs.waitFor(() =>
          expect(stack.texts()).toEqual(
            platform === "feishu" && mode === "edit" ? ["中文👋", "A"] : ["中文👋"],
          ),
        );
      }
      const receipts = await run.finish("中文👋AB");
      expect(stack.texts()).toEqual(["中文👋", "AB"]);
      expect(receipts).toHaveLength(2);
      expect(stack.creates()).toHaveLength(2);
      const edits = stack.fixture.server.calls.filter((call) => call.method === "PUT");
      expect(edits).toHaveLength(platform === "feishu" && mode === "edit" ? 1 : 0);
      const rows = await stack.test.db.select().from(replyDeliveryParts);
      expect(rows.map((row) => [row.sourceStart, row.sourceEnd, row.outcome])).toEqual([
        [0, 4, "accepted"],
        [4, 6, "accepted"],
      ]);
      stack.fixture.server.assertClean();
    } finally {
      await run.stop();
    }
  });

  it("applies global configuration when the connection has no overrides", async () => {
    await using stack = await deliveryStack(platform, { mode: "final", maxPartSize: 4 });
    const run = (await stack.run("global"))!;
    try {
      run.append("obsolete draft");
      await run.finish("123456");
      expect(stack.texts()).toEqual(["1234", "56"]);
      expect(stack.creates()).toHaveLength(2);
      stack.fixture.server.assertClean();
    } finally {
      await run.stop();
    }
  });

  it("coalesces block snapshots and paces physical creates", async () => {
    await using stack = await deliveryStack(platform, {
      mode: "blocks",
      maxPartSize: 4,
      coalesceMs: 50,
      createSpacingMs: 25,
    });
    const run = (await stack.run("paced"))!;
    try {
      const startedAt = Date.now();
      run.complete("old", "final", "answer");
      run.complete("abcdefghij", "final", "answer");
      await rs.waitFor(() => expect(stack.texts()).toEqual(["abcd", "efgh", "ij"]));
      await run.finish("abcdefghij");
      const calls = stack.creates();
      expect(calls).toHaveLength(3);
      expect(calls[0].startedAt - startedAt).toBeGreaterThanOrEqual(45);
      for (let index = 1; index < calls.length; index++) {
        expect(calls[index].startedAt - calls[index - 1].completedAt!).toBeGreaterThanOrEqual(22);
      }
      stack.fixture.server.assertClean();
    } finally {
      await run.stop();
    }
  });

  it("flushes completed blocks immediately instead of waiting for the coalescing timer", async () => {
    await using stack = await deliveryStack(platform, {
      mode: "blocks",
      coalesceMs: 60_000,
      maxPendingAgeMs: 60_000,
    });
    const run = (await stack.run("flush"))!;
    try {
      run.complete("ready", "final");
      await run.finish("ready");
      expect(stack.texts()).toEqual(["ready"]);
      expect(stack.creates()).toHaveLength(1);
      stack.fixture.server.assertClean();
    } finally {
      await run.stop();
    }
  });

  it("preserves Chinese, emoji and code across the configured transport boundary", async () => {
    await using stack = await deliveryStack(platform, { mode: "final" });
    const limit = { feishu: 3500, wechat: 1800 }[platform];
    const boundary = "中".repeat(limit - 2) + "👋";
    for (const [index, source] of [
      boundary.slice(0, -2) + "a",
      boundary,
      boundary + "😀\n```ts\nconst 文 = '👋';\n```",
    ].entries()) {
      const previous = stack.texts().length;
      const run = (await stack.run(`boundary-${index}`))!;
      try {
        const receipts = await run.finish(source);
        const parts = stack.texts().slice(previous);
        expect(parts).toHaveLength(index === 2 ? 2 : 1);
        expect(receipts).toHaveLength(parts.length);
        expect(parts.join("")).toBe(source);
        for (const part of parts) {
          expect(part.length).toBeLessThanOrEqual(limit);
          expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part)).toBe(false);
        }
      } finally {
        await run.stop();
      }
    }
    stack.fixture.server.assertClean();
  });

  it("honors Retry-After and sends the latest pending snapshot once", async () => {
    await using stack = await deliveryStack(platform, { mode: "blocks" });
    const barrier = requestBarrier();
    stack.fixture.server.once({
      method: "POST",
      path: stack.path,
      before: barrier.wait,
      response: {
        status: 429,
        headers: { "retry-after": "0.05" },
        body:
          platform === "feishu"
            ? { code: 99991400, msg: "limited" }
            : { ret: -1, errmsg: "limited" },
      },
    });
    const run = (await stack.run("retry"))!;
    try {
      run.complete("old", "final", "answer");
      await barrier.entered;
      run.complete("latest", "final", "answer");
      barrier.release();
      await run.finish("latest");
      expect(stack.texts()).toEqual(["latest"]);
      const calls = stack.creates();
      expect(calls).toHaveLength(2);
      expect(calls[1].startedAt - calls[0].completedAt!).toBeGreaterThanOrEqual(45);
      const rows = await stack.test.db.select().from(replyDeliveryParts);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "accepted", operation: "settle", sourceEnd: 6 });
      stack.fixture.server.assertClean();
    } finally {
      barrier.release();
      await run.stop();
    }
  });

  it.each([
    "refused",
    "disconnected",
  ] as const)("retains the accepted prefix when the next part is %s", async (fault) => {
    await using stack = await deliveryStack(platform, { mode: "blocks", maxPartSize: 4 });
    const barrier = requestBarrier();
    stack.fixture.server.once({ method: "POST", path: stack.path, before: barrier.wait });
    const run = (await stack.run(`partial-${fault}`))!;
    try {
      const pending = run.finish("abcdefgh");
      const rejected = expect(pending).rejects.toMatchObject({
        kind: fault === "refused" ? "failed" : "unknown",
        receipts: [expect.any(Object)],
      });
      await barrier.entered;
      stack.fixture.server.once({
        method: "POST",
        path: stack.path,
        ...{
          disconnected: { dropAfterAccept: true },
          refused: {
            response: {
              body: {
                feishu: { code: 230011, msg: "refused" },
                wechat: { ret: -1, errmsg: "refused" },
              }[platform],
            },
          },
        }[fault],
      });
      barrier.release();
      await rejected;
      expect(stack.texts()).toEqual(fault === "refused" ? ["abcd"] : ["abcd", "efgh"]);
      expect(stack.creates()).toHaveLength(2);
      const rows = await stack.test.db.select().from(replyDeliveryParts);
      expect(rows.map((row) => row.outcome)).toEqual([
        "accepted",
        fault === "refused" ? "failed" : "unknown",
      ]);
      expect(rows[0].receipt).not.toBeNull();
      expect(rows[1].receipt).toBeNull();
      stack.fixture.server.assertClean();
    } finally {
      barrier.release();
      await run.stop();
    }
  });

  it("rejects invalid connection overrides before sending", async () => {
    await using stack = await deliveryStack(platform);
    for (const config of [
      { maxPartSize: 100_000 },
      { maxPartSize: 1 },
      { coalesceMs: -1 },
      { formatting: "native" },
      { mode: "invalid" },
      { unknownField: true },
    ]) {
      await stack.configure(config);
      await expect(stack.run("invalid")).rejects.toThrow();
    }
    expect(stack.creates()).toHaveLength(0);
    stack.fixture.server.assertClean();
  });
});

it("falls back to final for WeChat edit mode and flushes without waiting for coalescing", async () => {
  await using stack = await deliveryStack("wechat", {
    mode: "edit",
    unsupportedMode: "final",
    maxPartSize: 4,
    coalesceMs: 10_000,
  });
  const run = (await stack.run("fallback"))!;
  try {
    run.append("old preview longer than a part");
    await run.finish("answer");
    expect(stack.texts()).toEqual(["answ", "er"]);
    expect(stack.creates()).toHaveLength(2);
    stack.fixture.server.assertClean();
  } finally {
    await run.stop();
  }
});

it("paces WeChat chunks at the production default interval without editing messages", async () => {
  const defaults = wechatDeliveryProfile("wechat-default-pacing");
  await using stack = await deliveryStack("wechat", { ...defaults, maxPartSize: 4 });
  const run = (await stack.run("default-pacing"))!;
  try {
    await run.finish("abcdefghij");
    expect(stack.texts()).toEqual(["abcd", "efgh", "ij"]);
    const calls = stack.creates();
    expect(calls).toHaveLength(3);
    for (let index = 1; index < calls.length; index++) {
      expect(calls[index].startedAt - calls[index - 1].completedAt!).toBeGreaterThanOrEqual(
        Math.max(defaults.createSpacingMs, defaults.conversationSpacingMs) - 5,
      );
    }
    expect(
      stack.fixture.server.calls.filter((call) => ["PUT", "PATCH"].includes(call.method)),
    ).toHaveLength(0);
    stack.fixture.server.assertClean();
  } finally {
    await run.stop();
  }
});

it("edits every Feishu overflow part in place after a revised final snapshot", async () => {
  await using stack = await deliveryStack("feishu", { maxPartSize: 4 });
  const run = (await stack.run("revised"))!;
  try {
    run.append("中文👋abcd尾巴");
    await rs.waitFor(() => expect(stack.texts()).toEqual(["中文👋", "abcd", "尾巴"]));
    const ids = [...stack.fixture.messages.keys()];
    run.complete("汉字😀WXYZ结束", "final");
    const receipts = await run.finish("汉字😀WXYZ结束");
    expect(stack.texts()).toEqual(["汉字😀", "WXYZ", "结束"]);
    expect([...stack.fixture.messages.keys()]).toEqual(ids);
    expect(receipts.map((receipt) => receipt.messageId)).toEqual(ids);
    expect(stack.creates()).toHaveLength(3);
    expect(stack.fixture.server.calls.filter((call) => call.method === "PUT")).toHaveLength(3);
    stack.fixture.server.assertClean();
  } finally {
    await run.stop();
  }
});

it("appends an explicit WeChat correction without rewriting or replaying the accepted prefix", async () => {
  await using stack = await deliveryStack("wechat", { maxPartSize: 4 });
  const run = (await stack.run("correction"))!;
  try {
    run.append("old!tail");
    await rs.waitFor(() => expect(stack.texts()).toEqual(["old!"]));
    run.complete("NEW!tail", "final");
    const receipts = await run.finish("NEW!tail");
    expect(stack.texts()[0]).toBe("old!");
    expect(stack.texts().slice(1).join("")).toBe("Correction:\nNEW!tail");
    expect(receipts).toHaveLength(stack.texts().length);
    expect(
      stack.fixture.server.calls.filter((call) => ["PUT", "PATCH"].includes(call.method)),
    ).toHaveLength(0);
    stack.fixture.server.assertClean();
  } finally {
    await run.stop();
  }
});
