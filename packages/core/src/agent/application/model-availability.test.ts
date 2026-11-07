import { describe, expect, it, rs } from "@rstest/core";
import type { ModelAccount } from "../domain/model-account.js";
import type { ProviderAvailability } from "../domain/provider-availability.js";
import { createModelAvailability } from "./model-availability.js";

const readAt = new Date("2026-11-07T00:00:00.000Z");
const available: ProviderAvailability = { state: "available", account: { loggedIn: true } };
const unauthorized: ProviderAvailability = { state: "unauthorized", account: { loggedIn: false } };
const limited: ProviderAvailability = {
  state: "usage_limit_reached",
  usageLimitUntil: "2026-11-07T01:00:00.000Z",
  account: { loggedIn: true },
};

/** An account whose answers the test hands out, one read at a time. */
function fakeAccount(initial: ProviderAvailability) {
  let answer = initial;
  let hold = false;
  const pending: Array<(availability: ProviderAvailability) => void> = [];
  const listeners = new Set<() => void>();
  const account: ModelAccount = {
    availability: rs.fn(() => {
      if (!hold) return Promise.resolve(answer);
      return new Promise<ProviderAvailability>((resolve) => pending.push(resolve));
    }),
    async revoke() {},
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {},
  };
  return {
    account,
    set(next: ProviderAvailability) {
      answer = next;
    },
    /** The account changed, as its adapter would say. */
    changed(next: ProviderAvailability) {
      answer = next;
      for (const listener of listeners) listener();
    },
    hold() {
      hold = true;
    },
    /** Answers the oldest held read. */
    release(next: ProviderAvailability) {
      hold = false;
      pending.shift()?.(next);
    },
    reads: () => (account.availability as ReturnType<typeof rs.fn>).mock.calls.length,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createModelAvailability", () => {
  it("knows nothing about a provider until its account was read", async () => {
    const codex = fakeAccount(available);
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    expect(availability.read()).toEqual({});
    await availability.refresh();
    expect(availability.read().openai).toBe(available);
    availability.close();
  });

  it("reads a limit whose end has passed as available without a refresh", async () => {
    let now = readAt;
    const codex = fakeAccount(limited);
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => now,
    });
    await availability.refresh("openai");
    expect(availability.read().openai).toBe(limited);
    now = new Date("2026-11-07T01:00:01.000Z");
    expect(availability.read().openai).toEqual({ state: "available", account: { loggedIn: true } });
    availability.close();
  });

  it("runs one read per provider for refreshes asked while it is in flight", async () => {
    const codex = fakeAccount(available);
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
    });
    codex.hold();
    const first = availability.refresh("openai");
    const second = availability.refresh();
    codex.release(available);
    await Promise.all([first, second]);
    expect(codex.reads()).toBe(1);
    availability.close();
  });

  it("tells listeners when the authorized state flips and after every read", async () => {
    const codex = fakeAccount(available);
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
    });
    const changes: string[] = [];
    availability.onChanged((provider, change) => changes.push(`${provider}:${change}`));
    await availability.refresh();
    expect(changes).toEqual(["openai:refreshed"]);
    codex.set(limited);
    await availability.refresh();
    expect(changes).toEqual(["openai:refreshed", "openai:refreshed"]);
    codex.set(unauthorized);
    await availability.refresh();
    expect(changes).toEqual([
      "openai:refreshed",
      "openai:refreshed",
      "openai:authorization",
      "openai:refreshed",
    ]);
    availability.close();
  });

  it("reads an account again when it says it changed", async () => {
    const codex = fakeAccount(available);
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    await availability.refresh();
    codex.changed(limited);
    await settle();
    expect(availability.read().openai).toBe(limited);
    availability.close();
  });

  it("reads once more when the account changes during a read, so the change is not lost", async () => {
    const codex = fakeAccount(available);
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    codex.hold();
    const read = availability.refresh("openai");
    // The provider refuses a turn while the read is waiting on the account.
    codex.changed(limited);
    codex.changed(limited);
    // The read that began before the refusal answers with what it saw then.
    codex.release(available);
    await read;
    await settle();
    expect(codex.reads()).toBe(2);
    expect(availability.read().openai).toBe(limited);
    availability.close();
  });

  it("keeps the last answer when a read fails, and says the read settled", async () => {
    const codex = fakeAccount(available);
    const warn = rs.fn();
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      log: { info: () => {}, warn },
      now: () => readAt,
    });
    await availability.refresh();
    const changes: string[] = [];
    availability.onChanged((provider, change) => changes.push(`${provider}:${change}`));
    (codex.account.availability as ReturnType<typeof rs.fn>).mockRejectedValueOnce(
      new Error("down"),
    );
    await availability.refresh();
    expect(availability.read().openai).toBe(available);
    expect(changes).toEqual(["openai:refreshed"]);
    expect(warn).toHaveBeenCalledWith("model account read failed", {
      provider: "openai",
      error: "down",
    });
    availability.close();
  });
});
