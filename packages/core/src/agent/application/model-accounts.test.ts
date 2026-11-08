import { describe, expect, it, rs } from "@rstest/core";
import type { ModelAccount } from "../domain/model-account.js";
import type { ModelAccountReport } from "../domain/model-account-report.js";
import { createModelAccounts } from "./model-accounts.js";

const readAt = new Date("2026-11-07T00:00:00.000Z");
const available: ModelAccountReport = { state: "available", account: { loggedIn: true } };
const unauthorized: ModelAccountReport = { state: "unauthorized", account: { loggedIn: false } };
const limited: ModelAccountReport = {
  state: "usage_limit_reached",
  usageLimitUntil: "2026-11-07T01:00:00.000Z",
  account: { loggedIn: true },
};

/** An account whose answers the test hands out, one read at a time. */
function fakeAccount(initial: ModelAccountReport) {
  let answer = initial;
  let hold = false;
  const pending: Array<(report: ModelAccountReport) => void> = [];
  const listeners = new Set<() => void>();
  const account: ModelAccount = {
    report: rs.fn(() => {
      if (!hold) return Promise.resolve(answer);
      return new Promise<ModelAccountReport>((resolve) => pending.push(resolve));
    }),
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {},
  };
  return {
    account,
    set(next: ModelAccountReport) {
      answer = next;
    },
    /** The account changed, as its adapter would say. */
    changed(next: ModelAccountReport) {
      answer = next;
      for (const listener of listeners) listener();
    },
    hold() {
      hold = true;
    },
    /** Answers the oldest held read. */
    release(next: ModelAccountReport) {
      hold = false;
      pending.shift()?.(next);
    },
    reads: () => (account.report as ReturnType<typeof rs.fn>).mock.calls.length,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createModelAccounts", () => {
  it("knows nothing about a provider until its account was read", async () => {
    const codex = fakeAccount(available);
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    expect(accounts.read()).toEqual({});
    await accounts.refresh();
    expect(accounts.read().openai).toBe(available);
    accounts.close();
  });

  it("reads a limit whose end has passed as available without a refresh", async () => {
    let now = readAt;
    const codex = fakeAccount(limited);
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => now,
    });
    await accounts.refresh("openai");
    expect(accounts.read().openai).toBe(limited);
    now = new Date("2026-11-07T01:00:01.000Z");
    expect(accounts.read().openai).toEqual({ state: "available", account: { loggedIn: true } });
    accounts.close();
  });

  it("runs one read per provider for refreshes asked while it is in flight", async () => {
    const codex = fakeAccount(available);
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
    });
    codex.hold();
    const first = accounts.refresh("openai");
    const second = accounts.refresh();
    codex.release(available);
    await Promise.all([first, second]);
    expect(codex.reads()).toBe(1);
    accounts.close();
  });

  it("tells listeners when the authorized state flips and after every read", async () => {
    const codex = fakeAccount(available);
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
    });
    const changes: string[] = [];
    accounts.onChanged((provider, change) => changes.push(`${provider}:${change}`));
    await accounts.refresh();
    expect(changes).toEqual(["openai:refreshed"]);
    codex.set(limited);
    await accounts.refresh();
    expect(changes).toEqual(["openai:refreshed", "openai:refreshed"]);
    codex.set(unauthorized);
    await accounts.refresh();
    expect(changes).toEqual([
      "openai:refreshed",
      "openai:refreshed",
      "openai:authorization",
      "openai:refreshed",
    ]);
    accounts.close();
  });

  it("reads an account again when it says it changed", async () => {
    const codex = fakeAccount(available);
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    await accounts.refresh();
    codex.changed(limited);
    await settle();
    expect(accounts.read().openai).toBe(limited);
    accounts.close();
  });

  it("reads once more when the account changes during a read, so the change is not lost", async () => {
    const codex = fakeAccount(available);
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    codex.hold();
    const read = accounts.refresh("openai");
    // The provider refuses a turn while the read is waiting on the account.
    codex.changed(limited);
    codex.changed(limited);
    // The read that began before the refusal answers with what it saw then.
    codex.release(available);
    await read;
    await settle();
    expect(codex.reads()).toBe(2);
    expect(accounts.read().openai).toBe(limited);
    accounts.close();
  });

  it("keeps the last answer when a read fails, and says the read settled", async () => {
    const codex = fakeAccount(available);
    const warn = rs.fn();
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      log: { info: () => {}, error: () => {}, warn },
      now: () => readAt,
    });
    await accounts.refresh();
    const changes: string[] = [];
    accounts.onChanged((provider, change) => changes.push(`${provider}:${change}`));
    (codex.account.report as ReturnType<typeof rs.fn>).mockRejectedValueOnce(new Error("down"));
    await accounts.refresh();
    expect(accounts.read().openai).toBe(available);
    expect(changes).toEqual(["openai:refreshed"]);
    expect(warn).toHaveBeenCalledWith("model account read failed", {
      provider: "openai",
      error: "down",
    });
    accounts.close();
  });
});
