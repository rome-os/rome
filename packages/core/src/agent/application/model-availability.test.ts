import { describe, expect, it, rs } from "@rstest/core";
import type {
  ModelAccount,
  ModelAccountStatus,
  ModelAccountUsage,
} from "../domain/model-account.js";
import { createModelAvailability } from "./model-availability.js";

const readAt = new Date("2026-11-07T00:00:00.000Z");

/** An account whose answers the test hands out, one status read at a time. */
function fakeAccount(initial: ModelAccountStatus) {
  let status = initial;
  let usage: ModelAccountUsage | null = null;
  const pendingStatus: Array<(status: ModelAccountStatus) => void> = [];
  const pendingUsage: Array<(usage: ModelAccountUsage | null) => void> = [];
  let holdStatus = false;
  let holdUsage = false;
  const listeners = new Set<() => void>();
  const account: ModelAccount = {
    status: rs.fn(() => {
      if (!holdStatus) return Promise.resolve(status);
      return new Promise<ModelAccountStatus>((resolve) => pendingStatus.push(resolve));
    }),
    usage: rs.fn(() => {
      if (!holdUsage) return Promise.resolve(usage);
      return new Promise<ModelAccountUsage | null>((resolve) => pendingUsage.push(resolve));
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
    set(next: ModelAccountStatus, nextUsage: ModelAccountUsage | null = null) {
      status = next;
      usage = nextUsage;
    },
    /** The account changed, as its adapter would say. */
    changed(next: ModelAccountStatus) {
      status = next;
      for (const listener of listeners) listener();
    },
    hold() {
      holdStatus = true;
    },
    holdUsage() {
      holdUsage = true;
    },
    releaseUsage(answer: ModelAccountUsage | null) {
      holdUsage = false;
      pendingUsage.shift()?.(answer);
    },
    /** Answers the oldest held status read with the status at the time it was asked. */
    release(answer: ModelAccountStatus) {
      holdStatus = false;
      pendingStatus.shift()?.(answer);
    },
    statusReads: () => (account.status as ReturnType<typeof rs.fn>).mock.calls.length,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createModelAvailability", () => {
  it("knows nothing about a provider until its account was read", async () => {
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    expect(availability.read()).toEqual({});
    await availability.refresh();
    expect(availability.read().openai).toMatchObject({ state: "available" });
    availability.close();
  });

  it("reads a limit whose end has passed as available without a refresh", async () => {
    let now = readAt;
    const codex = fakeAccount({
      loggedIn: true,
      usageLimited: true,
      usageLimitUntil: "2026-11-07T01:00:00.000Z",
    });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => now,
    });
    await availability.refresh("openai");
    expect(availability.read().openai).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: "2026-11-07T01:00:00.000Z",
    });
    now = new Date("2026-11-07T01:00:01.000Z");
    expect(availability.read().openai).toMatchObject({ state: "available" });
    expect(availability.read().openai).not.toHaveProperty("usageLimitUntil");
    availability.close();
  });

  it("runs one read per provider for refreshes asked while it is in flight", async () => {
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
    });
    codex.hold();
    const first = availability.refresh("openai");
    const second = availability.refresh();
    codex.release({ loggedIn: true, usageLimited: true });
    await Promise.all([first, second]);
    expect(codex.statusReads()).toBe(1);
    availability.close();
  });

  it("tells listeners when the authorized state flips and after every read", async () => {
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
    });
    const changes: string[] = [];
    availability.onChanged((provider, change) => changes.push(`${provider}:${change}`));
    await availability.refresh();
    expect(changes).toEqual(["openai:refreshed"]);
    codex.set({ loggedIn: true, usageLimited: true, usageLimitUntil: "2026-11-07T05:00:00.000Z" });
    await availability.refresh();
    expect(changes).toEqual(["openai:refreshed", "openai:refreshed"]);
    codex.set({ loggedIn: false });
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
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    await availability.refresh();
    codex.changed({
      loggedIn: true,
      usageLimited: true,
      usageLimitUntil: "2026-11-07T05:00:00.000Z",
    });
    await settle();
    expect(availability.read().openai).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: "2026-11-07T05:00:00.000Z",
    });
    availability.close();
  });

  it("reads once more when the account changes during a read, so the change is not lost", async () => {
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    codex.hold();
    const read = availability.refresh("openai");
    // The provider refuses a turn while the read is waiting on the account.
    const refused = {
      loggedIn: true,
      usageLimited: true,
      usageLimitUntil: "2026-11-07T05:00:00.000Z",
    };
    codex.changed(refused);
    codex.changed(refused);
    // The read that began before the refusal answers with what it saw then.
    codex.release({ loggedIn: true, usageLimited: true });
    await read;
    await settle();
    expect(codex.statusReads()).toBe(2);
    expect(availability.read().openai).toMatchObject({ state: "usage_limit_reached" });
    availability.close();
  });

  it("lands an authorization change as soon as the status answers, before the usage read settles", async () => {
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    await availability.refresh();
    const changes: string[] = [];
    availability.onChanged((provider, change) => changes.push(`${provider}:${change}`));
    codex.holdUsage();
    codex.set({ loggedIn: false, needsReauth: true });
    const read = availability.refresh("openai");
    await settle();
    expect(availability.read().openai).toMatchObject({ state: "expired" });
    expect(changes).toEqual(["openai:authorization"]);
    codex.releaseUsage(null);
    await read;
    expect(changes.slice(0, 2)).toEqual(["openai:authorization", "openai:refreshed"]);
    // The change can restart the provider's process under the usage read, so
    // the account is read once more.
    await settle();
    expect(codex.statusReads()).toBe(3);
    availability.close();
  });

  it("treats a usage read that fails while the status is pending as a failed read", async () => {
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => readAt,
    });
    const unhandled = rs.fn();
    process.on("unhandledRejection", unhandled);
    try {
      codex.hold();
      (codex.account.usage as ReturnType<typeof rs.fn>).mockRejectedValueOnce(new Error("gone"));
      const read = availability.refresh("openai");
      await settle();
      codex.release({ loggedIn: true, usageLimited: true });
      await read;
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      expect(availability.read().openai).toMatchObject({ usage: { error: "gone" } });
    } finally {
      process.off("unhandledRejection", unhandled);
      availability.close();
    }
  });

  it("keeps the last status when a read fails and drops the usage into an error", async () => {
    const codex = fakeAccount({ loggedIn: true, usageLimited: true });
    const warn = rs.fn();
    const availability = createModelAvailability({
      accounts: { openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      log: { info: () => {}, warn },
      now: () => readAt,
    });
    await availability.refresh();
    (codex.account.status as ReturnType<typeof rs.fn>).mockRejectedValueOnce(new Error("down"));
    (codex.account.usage as ReturnType<typeof rs.fn>).mockRejectedValueOnce(new Error("no usage"));
    await availability.refresh();
    expect(availability.read().openai).toMatchObject({
      state: "available",
      account: { loggedIn: true },
      usage: { error: "no usage" },
    });
    expect(warn).toHaveBeenCalledWith("model account status read failed", {
      provider: "openai",
      error: "down",
    });
    availability.close();
  });
});
