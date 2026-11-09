import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ModelAccount } from "../domain/model-account.js";
import type { ModelAccountReport } from "../domain/model-account-report.js";
import { createModelAccounts, RESET_GRACE_MS } from "./model-accounts.js";

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

describe("createModelAccounts reading at the end of a usage limit", () => {
  const HOUR = 60 * 60 * 1000;
  const start = Date.parse("2026-11-07T00:00:00.000Z");
  const limitedFor = (ms: number): ModelAccountReport => ({
    state: "usage_limit_reached",
    usageLimitUntil: new Date(start + ms).toISOString(),
    account: { loggedIn: true },
  });
  const tick = (ms: number) => rs.advanceTimersByTimeAsync(ms);

  function setup(initial: ModelAccountReport, startRefresh = false) {
    rs.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    rs.setSystemTime(start);
    const codex = fakeAccount(initial);
    const accounts = createModelAccounts({
      accounts: { openai: codex.account },
      startRefresh,
      refreshIntervalMs: null,
      now: () => new Date(Date.now()),
    });
    return { codex, accounts };
  }
  afterEach(() => {
    rs.useRealTimers();
  });

  it("reads the account a grace after the stated end, not at it", async () => {
    const { codex, accounts } = setup(limitedFor(HOUR));
    await accounts.refresh();
    const reads = codex.reads();
    const changes: string[] = [];
    accounts.onChanged((_provider, change) => changes.push(change));

    await tick(HOUR);
    expect(codex.reads()).toBe(reads);
    await tick(RESET_GRACE_MS - 1);
    expect(codex.reads()).toBe(reads);
    codex.set(available);
    await tick(1);

    expect(codex.reads()).toBe(reads + 1);
    expect(changes).toEqual(["refreshed"]);
    expect(accounts.read().openai?.state).toBe("available");
    expect(rs.getTimerCount()).toBe(0);
    accounts.close();
  });

  it("arms again when a read moves the end, and not for the old time", async () => {
    const { codex, accounts } = setup(limitedFor(HOUR));
    await accounts.refresh();
    expect(rs.getTimerCount()).toBe(1);
    codex.set(limitedFor(3 * HOUR));
    await accounts.refresh();
    expect(rs.getTimerCount()).toBe(1);

    const reads = codex.reads();
    await tick(HOUR + RESET_GRACE_MS);
    expect(codex.reads()).toBe(reads);
    await tick(2 * HOUR);
    expect(codex.reads()).toBe(reads + 1);
    accounts.close();
  });

  it("arms nothing for an available provider or an end that has passed, and drops the timer once it clears", async () => {
    const { codex, accounts } = setup(available);
    await accounts.refresh();
    expect(rs.getTimerCount()).toBe(0);
    codex.set(limitedFor(-HOUR));
    await accounts.refresh();
    expect(rs.getTimerCount()).toBe(0);
    codex.set(limitedFor(HOUR));
    await accounts.refresh();
    expect(rs.getTimerCount()).toBe(1);
    codex.set(available);
    await accounts.refresh();
    expect(rs.getTimerCount()).toBe(0);
    accounts.close();
  });

  it("reaches an end more than 24.8 days away in steps, without firing at once", async () => {
    const maxTimer = 2 ** 31 - 1;
    const { codex, accounts } = setup(limitedFor(40 * 24 * HOUR));
    await accounts.refresh();
    const reads = codex.reads();

    await tick(maxTimer - 1);
    expect(codex.reads()).toBe(reads);
    await tick(1);
    // The step reads the account, which still reports the limit, and the rest is armed.
    expect(codex.reads()).toBe(reads + 1);
    expect(rs.getTimerCount()).toBe(1);

    await tick(40 * 24 * HOUR + RESET_GRACE_MS - maxTimer);
    expect(codex.reads()).toBe(reads + 2);
    accounts.close();
  });

  it("goes on in steps when a read fails, and stops once the end has passed", async () => {
    const maxTimer = 2 ** 31 - 1;
    const { codex, accounts } = setup(limitedFor(40 * 24 * HOUR));
    await accounts.refresh();
    const reads = codex.reads();
    const report = codex.account.report as ReturnType<typeof rs.fn>;

    report.mockRejectedValueOnce(new Error("down"));
    await tick(maxTimer);
    expect(codex.reads()).toBe(reads + 1);
    expect(rs.getTimerCount()).toBe(1);

    report.mockRejectedValueOnce(new Error("down"));
    await tick(40 * 24 * HOUR + RESET_GRACE_MS - maxTimer);
    expect(codex.reads()).toBe(reads + 2);
    // The end has passed and the read failed: nothing arms a read for it again.
    expect(rs.getTimerCount()).toBe(0);
    accounts.close();
  });

  it("arms nothing before the first read, and clears its timers when closed", async () => {
    const { accounts } = setup(limitedFor(HOUR));
    expect(rs.getTimerCount()).toBe(0);
    await accounts.refresh();
    expect(rs.getTimerCount()).toBe(1);
    accounts.close();
    expect(rs.getTimerCount()).toBe(0);
  });
});
