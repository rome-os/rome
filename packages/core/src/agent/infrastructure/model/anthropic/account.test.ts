import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, rs } from "@rstest/core";
import type { ModelAccountUsage } from "../../../domain/model-account.js";
import { USAGE_REFUSAL_HOLD_MS } from "../refused-turn.js";
import { ClaudeAccount } from "./account.js";
import * as refusedCredential from "./refused-credential.js" with { rstest: "importActual" };

const { clearStoredMark } = rs.hoisted(() => ({ clearStoredMark: rs.fn() }));

// The real mark is a file in the home folder of whoever runs these tests.
rs.mock("./refused-credential.js", () => ({
  ...refusedCredential,
  clearClaudeAuthRevoked: rs.fn(),
  clearStoredAnthropicCompatibleAuthRevoked: clearStoredMark,
  isAnthropicAuthRevoked: async () => false,
  isAnthropicCompatibleAuthRevoked: async () => false,
}));

const usage = (usedPercent: number) => ({
  checkedAt: "2026-11-07T00:00:00.000Z",
  source: "test",
  fiveHour: { usedPercent },
});

describe("ClaudeAccount", () => {
  it("reads an environment credential as an available account the provider bills per use", async () => {
    const readUsage = rs.fn(async () => usage(100));
    const account = new ClaudeAccount({ env: { ANTHROPIC_API_KEY: "sk" }, readUsage });
    await expect(account.report()).resolves.toEqual({
      state: "available",
      account: {
        loggedIn: true,
        authMethod: "environment",
        accountType: "API key",
        usageLimited: false,
      },
    });
    // Such an account has no usage windows, so none is read.
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("reports the CLI's login as a subscription, with the refused turns it saw", async () => {
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
      readUsage: async () => usage(10),
      now: () => now,
    });
    const changed = rs.fn();
    account.onChanged(changed);
    await expect(account.report()).resolves.toEqual({
      state: "available",
      account: { loggedIn: true, authMethod: "oauth", usageLimited: true },
      usage: usage(10),
    });

    account.refusedTurn({ kind: "usage", until: "2026-11-07T05:00:00.000Z" });
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(account.report()).resolves.toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: "2026-11-07T05:00:00.000Z",
    });

    // With no stated end, the refusal ends five hours after it was seen.
    account.refusedTurn({ kind: "usage" });
    await expect(account.report()).resolves.toMatchObject({
      usageLimitUntil: "2026-11-07T05:00:00.000Z",
    });

    // A usage read in the hold after the refusal describes the account before
    // the refused turn, so it cannot end the refusal. One after the hold does.
    now += USAGE_REFUSAL_HOLD_MS;
    await expect(account.report()).resolves.toMatchObject({ state: "available" });
  });

  it("drops a refusal once its end has passed, however often it is read", async () => {
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
      readUsage: async () => null,
      now: () => now,
    });
    account.refusedTurn({ kind: "usage" });
    now += 3 * 60 * 60 * 1000;
    await expect(account.report()).resolves.toMatchObject({
      usageLimitUntil: "2026-11-07T05:00:00.000Z",
    });
    now += 2 * 60 * 60 * 1000;
    await expect(account.report()).resolves.toMatchObject({ state: "available" });
  });

  it("lets no read that began before a refusal clear it", async () => {
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    let answer: ((value: ModelAccountUsage) => void) | undefined;
    const pending = new Promise<ModelAccountUsage>((resolve) => {
      answer = resolve;
    });
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
      readUsage: () => pending,
      now: () => now,
    });
    const read = account.report();
    now += USAGE_REFUSAL_HOLD_MS * 2;
    account.refusedTurn({ kind: "usage" });
    answer?.(usage(10));
    await expect(read).resolves.toMatchObject({ state: "usage_limit_reached" });
  });

  it("keeps a refused turn through a usage read that shows no capacity", async () => {
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true }),
      readUsage: async () => usage(100),
      now: () => Date.now() - USAGE_REFUSAL_HOLD_MS,
    });
    account.refusedTurn({ kind: "usage" });
    await expect(account.report()).resolves.toMatchObject({
      state: "usage_limit_reached",
    });
  });

  it("carries a limit through a usage read that fails, and reports the failure", async () => {
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    const resetsAt = "2026-11-07T01:00:00.000Z";
    const reads = [
      { ...usage(100), fiveHour: { usedPercent: 100, resetsAt } },
      { checkedAt: "2026-11-07T00:30:00.000Z", source: "test", error: "HTTP 429" },
    ];
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
      readUsage: async () => reads.shift() ?? null,
      now: () => now,
    });
    await expect(account.report()).resolves.toMatchObject({ usageLimitUntil: resetsAt });
    now += 30 * 60 * 1000;
    await expect(account.report()).resolves.toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: resetsAt,
      usage: { error: "HTTP 429" },
    });
  });

  it("reports a usage read that throws as an error read, not a failed account", async () => {
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
      readUsage: async () => {
        throw new Error("gone");
      },
    });
    await expect(account.report()).resolves.toMatchObject({
      state: "available",
      usage: { error: "gone" },
    });
  });

  it("reports a refused credential as expired when the CLI cannot be read, else fails the read", async () => {
    let revoked = true;
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => {
        throw new Error("claude timed out");
      },
      readCredentialRevoked: async () => revoked,
    });
    await expect(account.report()).resolves.toMatchObject({ state: "expired" });
    revoked = false;
    await expect(account.report()).rejects.toThrow("claude timed out");
  });

  it("still reports a held refusal when the CLI cannot be read", async () => {
    let fail = false;
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => {
        if (fail) throw new Error("claude timed out");
        return { loggedIn: true, authMethod: "oauth" };
      },
      readUsage: async () => null,
      readCredentialRevoked: async () => false,
    });
    await expect(account.report()).resolves.toMatchObject({ state: "available" });
    account.refusedTurn({ kind: "usage" });
    fail = true;
    await expect(account.report()).resolves.toMatchObject({
      state: "usage_limit_reached",
      account: { loggedIn: true, authMethod: "oauth" },
    });
  });

  it("holds a refusal no longer than the window reset it reported", async () => {
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    const resetsAt = "2026-11-07T01:00:00.000Z";
    const reads = [
      { ...usage(100), fiveHour: { usedPercent: 100, resetsAt } },
      { checkedAt: "2026-11-07T01:30:00.000Z", source: "test", error: "HTTP 429" },
    ];
    const account = new ClaudeAccount({
      env: {},
      readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
      readUsage: async () => reads.shift() ?? null,
      now: () => now,
    });
    account.refusedTurn({ kind: "usage" });
    await expect(account.report()).resolves.toMatchObject({ usageLimitUntil: resetsAt });
    // After the reset, a usage read that fails does not bring the refusal back.
    now = Date.parse(resetsAt) + 30 * 60 * 1000;
    await expect(account.report()).resolves.toMatchObject({ state: "available" });
  });

  it("fails a logout the CLI refused, whatever it printed", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "rome-claude-account-"));
    const originalPath = process.env.PATH;
    try {
      await fs.writeFile(
        join(dir, "claude"),
        ["#!/bin/sh", "echo 'not signed in'", "exit 1"].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${dir}:${originalPath ?? ""}`;
      const account = new ClaudeAccount({ env: {} });
      await expect(account.revoke()).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  describe("stored credential", () => {
    const credential = { provider: "deepseek", apiKey: "k", updatedAt: "2026-11-07" } as const;
    const settings = () => {
      const values = new Map<string, unknown>();
      return {
        get: async <T>(key: string) => (values.get(key) ?? null) as T | null,
        set: async (key: string, value: unknown) => void values.set(key, value),
        delete: async (key: string) => values.delete(key),
      };
    };

    it("becomes the login when stored, tells the account, and goes when removed", async () => {
      const account = new ClaudeAccount({
        env: {},
        settingsRepo: settings() as never,
        readCliStatus: async () => ({ loggedIn: false }),
      });
      const changed = rs.fn();
      account.onChanged(changed);

      await account.storeCredential(credential as never);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(clearStoredMark).toHaveBeenCalledTimes(1);
      expect(await account.status()).toMatchObject({
        authMethod: "stored-compatible",
        usageLimited: false,
      });
      expect(await account.storedCredential()).toMatchObject({
        credential: { provider: "deepseek" },
        expired: false,
      });

      await account.removeCredential();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(clearStoredMark).toHaveBeenCalledTimes(2);
      expect(await account.storedCredential()).toBeNull();
      expect(await account.status()).toMatchObject({ loggedIn: false });
    });

    it("cannot store without settings", async () => {
      const account = new ClaudeAccount({ env: {} });
      await expect(account.storeCredential(credential as never)).rejects.toThrow("no settings");
    });
  });
});
