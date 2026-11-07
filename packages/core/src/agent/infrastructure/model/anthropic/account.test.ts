import { describe, expect, it, rs } from "@rstest/core";
import { ClaudeAccount } from "./account.js";

const usage = (usedPercent: number) => ({
  checkedAt: "2026-11-07T00:00:00.000Z",
  source: "test",
  fiveHour: { usedPercent },
});

describe("ClaudeAccount", () => {
  it("reads an environment credential as an account the provider bills per use", async () => {
    const account = new ClaudeAccount({ env: { ANTHROPIC_API_KEY: "sk" } });
    await expect(account.status()).resolves.toEqual({
      loggedIn: true,
      authMethod: "environment",
      accountType: "API key",
      usageLimited: false,
    });
  });

  it("reports the CLI's login as a subscription, with the refused turns it saw", async () => {
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
      readUsage: async () => usage(10),
    });
    const changed = rs.fn();
    account.onChanged(changed);
    await expect(account.status()).resolves.toEqual({
      loggedIn: true,
      authMethod: "oauth",
      usageLimited: true,
    });

    account.refusedTurn({ kind: "usage", until: "2026-11-07T05:00:00.000Z" });
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(account.status()).resolves.toMatchObject({
      usageLimitUntil: "2026-11-07T05:00:00.000Z",
    });

    account.refusedTurn({ kind: "usage" });
    await expect(account.status()).resolves.toMatchObject({ usageLimitUntil: null });

    // A usage read that shows capacity ends the refusal.
    await account.usage();
    await expect(account.status()).resolves.not.toHaveProperty("usageLimitUntil");
  });

  it("keeps a refused turn through a usage read that shows no capacity", async () => {
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true }),
      readUsage: async () => usage(100),
    });
    account.refusedTurn({ kind: "usage" });
    await account.usage();
    await expect(account.status()).resolves.toMatchObject({ usageLimitUntil: null });
  });

  it("returns live usage errors rather than falling back to unmaintained usage files", async () => {
    const failed = {
      checkedAt: "2026-09-28T17:00:00.000Z",
      source: "claude oauth usage",
      error: "Claude usage request failed with HTTP 429",
    };
    const account = new ClaudeAccount({ env: {}, readUsage: async () => failed });
    await expect(account.usage()).resolves.toEqual(failed);
  });

  it("tells listeners when the provider refused the credential and when it is revoked", async () => {
    const logout = rs.fn(async () => {});
    const account = new ClaudeAccount({ env: {}, logout });
    const changed = rs.fn();
    account.onChanged(changed);
    account.refusedTurn({ kind: "credential" });
    await account.revoke();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
