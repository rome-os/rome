import { describe, expect, it, rs } from "@rstest/core";
import {
  ACCOUNT_KINDS,
  GUARDIAN_OWN_KINDS,
} from "../../../../../rome_apps/dream/src/lib/chat-activity.js";
import { BUILTIN_ACCOUNT_LINKS } from "../../test/db.js";
import { feishu, type FeishuDescriptorDeps } from "../kinds/feishu/index.js";
import { linkedin, type LinkedInDescriptorDeps } from "../kinds/linkedin/index.js";
import { wechatUser } from "../kinds/wechat-user/index.js";
import type { WechatUserRuntime } from "../kinds/wechat-user/wechat-user.js";
import type { ConnectionRegistry } from "../registry.js";
import type { ConnectionDescriptor, RuntimeKit } from "../types.js";
import { type BuiltinConnectionDeps, registerBuiltinConnections } from "./index.js";

/**
 * Registers what boot registers: the built-in kinds, then each kind the wiring
 * mounts on its own. A kind that moves to connections/kinds/ joins the list
 * here too, so the checks over every kind keep covering it.
 */
function registerEveryKind(registry: ConnectionRegistry): void {
  registerBuiltinConnections(registry, {
    listAgents: () => [],
    slackApp: { api: {}, cloud: {}, openMailbox: () => ({ stop() {} }), copy: {} },
  } as unknown as BuiltinConnectionDeps);
  const mounted = [
    feishu({ listAgents: () => [] } as unknown as FeishuDescriptorDeps),
    linkedin({} as unknown as LinkedInDescriptorDeps),
    wechatUser({ runtime: {} as WechatUserRuntime, guardianOnly: (_c, next) => next() }),
  ];
  for (const kind of mounted) {
    if (kind.descriptor) registry.register(kind.descriptor);
  }
}

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

  // A bot takes an agent as its own account and the guardian's signed-in
  // account as a delegate; Dream and the test fixtures keep their own lists of
  // these kinds, so all three must agree.
  it("declares the kind of link for exactly the kinds that take an agent", () => {
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.connectionKind, descriptor),
    } as unknown as ConnectionRegistry;

    registerEveryKind(registry);

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
      slack_app: "own_account",
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

    registerEveryKind(registry);

    const unnamed = [...registered.values()]
      .filter((descriptor) => !descriptor.accountIdOf)
      .map((descriptor) => descriptor.connectionKind);
    expect(unnamed).toEqual([]);
  });
});
