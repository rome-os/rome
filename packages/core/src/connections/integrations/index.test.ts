import { describe, expect, it, rs } from "@rstest/core";
import type { WechatUserRuntime } from "../../channels/wechat-user.js";
import type { ConnectionRegistry } from "../registry.js";
import type { ConnectionDescriptor, RuntimeKit } from "../types.js";
import {
  type BuiltinConnectionDeps,
  registerBuiltinConnections,
  WECHAT_USER_SERVICE,
} from "./index.js";

describe("registerBuiltinConnections", () => {
  it("gives WeChat personal the client runtime boot shares with the channel list", async () => {
    const bridgeCommand = rs.fn(async () => [
      {
        username: "wxid_friend",
        displayName: "A Friend",
        type: "private",
        unread: 0,
        lastMessage: { content: "hi", createdAt: "2026-10-01T00:00:00.000Z" },
      },
    ]);
    const runtime = { bridgeCommand } as unknown as WechatUserRuntime;
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.service, descriptor),
    } as unknown as ConnectionRegistry;

    registerBuiltinConnections(registry, {
      linkedinPoll: { minIntervalMs: 60_000, maxIntervalMs: 120_000 },
      listAgents: () => [],
      wechatUserRuntime: runtime,
    } as unknown as BuiltinConnectionDeps);

    const kit = {
      connectionId: "conn-wechat-user",
      persist: async () => {},
      registerIngress: () => () => {},
    } satisfies RuntimeKit;
    const transport = registered
      .get(WECHAT_USER_SERVICE)!
      .capabilities.transport!.build(
        { session: { material: { wxid: "wxid_guardian" }, expiresAt: "never" } },
        kit,
      );
    const page = await transport.directory!.listConversations({ limit: 10 });

    expect(page.conversations.map((c) => c.ref.conversationId)).toEqual(["wxid_friend"]);
    expect(bridgeCommand).toHaveBeenCalled();
  });
  it("offers no WeChat personal connection without a runtime, so none is built twice", () => {
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.service, descriptor),
    } as unknown as ConnectionRegistry;

    registerBuiltinConnections(registry, {
      linkedinPoll: { minIntervalMs: 60_000, maxIntervalMs: 120_000 },
      listAgents: () => [],
    } as unknown as BuiltinConnectionDeps);

    expect(registered.has(WECHAT_USER_SERVICE)).toBe(false);
  });
});
