import { describe, expect, it, rs } from "@rstest/core";
import {
  ACCOUNT_KINDS,
  GUARDIAN_OWN_KINDS,
} from "../../../../../rome_apps/dream/src/lib/chat-activity.js";
import { BUILTIN_ACCOUNT_LINKS } from "../../test/helpers.js";
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
    await expect(registered.get("google")!.auth.renew(expired)).resolves.toBe("needs-fix");
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
      .capabilities.talker!.build({ material: { wxid: "wxid_guardian" }, expiresAt: "never" }, kit);
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

  // A bot takes an agent as its own account and the guardian's signed-in
  // account as a delegate; Dream and the test fixtures keep their own lists of
  // these kinds, so all three must agree.
  it("declares the kind of link for exactly the kinds that take an agent", () => {
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

    const links = Object.fromEntries(
      [...registered.values()]
        .filter((descriptor) => descriptor.link !== undefined)
        .map((descriptor) => [descriptor.connectionKind, descriptor.link]),
    );
    expect(links).toEqual({
      feishu: "own_account",
      telegram: "own_account",
      discord: "own_account",
      slack_bot: "own_account",
      telegram_user: "delegate",
    });
    // Only a kind with a Talk can be a connected account.
    for (const kind of Object.keys(links)) {
      expect(registered.get(kind)?.capabilities.talker).toBeDefined();
    }
    expect(links).toEqual(BUILTIN_ACCOUNT_LINKS);
    expect(
      Object.keys(links)
        .filter((kind) => links[kind] === "own_account")
        .sort(),
    ).toEqual([...ACCOUNT_KINDS].sort());
    expect(
      Object.keys(links)
        .filter((kind) => links[kind] === "delegate")
        .sort(),
    ).toEqual([...GUARDIAN_OWN_KINDS].sort());
  });

  // A grant names the account it reaches, and every kind with a platform has
  // accounts (docs/domains/connections.md#grant).
  it("names the account for every kind", () => {
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

    const unnamed = [...registered.values()]
      .filter((descriptor) => !descriptor.accountIdOf)
      .map((descriptor) => descriptor.connectionKind);
    expect(unnamed).toEqual([]);
  });
});
