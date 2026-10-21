import { describe, expect, it, rs } from "@rstest/core";
import { LINKABLE_KINDS } from "@rome/api-types/account-agents";
import type { WechatUserRuntime } from "../../channels/wechat-user.js";
import type { ConnectionRegistry } from "../registry.js";
import type { ConnectionDescriptor, RuntimeKit } from "../types.js";
import {
  type BuiltinConnectionDeps,
  registerBuiltinConnections,
  WECHAT_USER_KIND,
} from "./index.js";

describe("registerBuiltinConnections", () => {
  it("renews through Rome Cloud only for providers Rome Cloud can refresh", async () => {
    const fetchMock = rs.fn(async () => new Response("{}", { status: 400 }));
    rs.stubGlobal("fetch", fetchMock);
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.connectionKind, descriptor),
    } as unknown as ConnectionRegistry;
    registerBuiltinConnections(registry, {
      linkedinPoll: { minIntervalMs: 60_000, maxIntervalMs: 120_000 },
      listAgents: () => [],
    } as unknown as BuiltinConnectionDeps);

    const expired = {
      material: { accessToken: "ya29.old", refreshToken: "1//refresh" },
      expiresAt: new Date(0),
    };
    // Google: Rome Cloud has no refresh for it, so renew answers at once.
    await expect(registered.get("google")!.auth.user.renew(expired)).resolves.toBe("re-confer");
    expect(fetchMock).not.toHaveBeenCalled();
    rs.unstubAllGlobals();
  });

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
        registered.set(descriptor.connectionKind, descriptor),
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
    const talker = registered
      .get(WECHAT_USER_KIND)!
      .capabilities.talker!.build(
        { session: { material: { wxid: "wxid_guardian" }, expiresAt: "never" } },
        kit,
      );
    const page = await talker.directory!.listConversations({ limit: 10 });

    expect(page.conversations.map((c) => c.ref.chatId)).toEqual(["wxid_friend"]);
    expect(bridgeCommand).toHaveBeenCalled();
  });
  it("offers no WeChat personal connection without a runtime, so none is built twice", () => {
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.connectionKind, descriptor),
    } as unknown as ConnectionRegistry;

    registerBuiltinConnections(registry, {
      linkedinPoll: { minIntervalMs: 60_000, maxIntervalMs: 120_000 },
      listAgents: () => [],
    } as unknown as BuiltinConnectionDeps);

    expect(registered.has(WECHAT_USER_KIND)).toBe(false);
  });

  // Removal on disconnect follows `accountIdOf` on a Talk, and a fresh channel
  // follows `LINKABLE_KINDS`; the two must name the same kinds.
  it("names its accounts exactly for the services an agent can be linked to", () => {
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.connectionKind, descriptor),
    } as unknown as ConnectionRegistry;

    registerBuiltinConnections(registry, {
      linkedinPoll: { minIntervalMs: 60_000, maxIntervalMs: 120_000 },
      listAgents: () => [],
      wechatUserRuntime: {} as WechatUserRuntime,
    } as unknown as BuiltinConnectionDeps);

    const naming = [...registered.values()].filter(
      (descriptor) => descriptor.capabilities.talker && descriptor.accountIdOf,
    );
    expect(naming.map((descriptor) => descriptor.connectionKind).sort()).toEqual(
      [...LINKABLE_KINDS].sort(),
    );
    // A disconnect removes the account once its grant goes, which covers every
    // grant only while the service holds one.
    for (const descriptor of naming) expect(Object.keys(descriptor.auth)).toHaveLength(1);
  });
});
