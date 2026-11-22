import { describe, expect, it } from "@rstest/core";
import type { DefaultProviderState } from "../domain/default-provider.js";
import type {
  ModelAccountReport,
  ModelAccountReports,
  ProviderAvailabilityState,
} from "../domain/model-account-report.js";
import type { ProviderId } from "../domain/model-port.js";
import { createDefaultProviders, type DefaultProviderChange } from "./default-providers.js";

const reportOf = (state: ProviderAvailabilityState): ModelAccountReport => ({
  state,
  account: { loggedIn: state !== "unauthorized" && state !== "expired" },
});

function keeper(
  reports: ModelAccountReports,
  options: {
    stored?: DefaultProviderState;
    credits?: () => boolean | undefined;
    seed?: () => Promise<"anthropic" | "openai" | null>;
  } = {},
) {
  let stored: DefaultProviderState = options.stored ?? { provider: null };
  const changes: Array<DefaultProviderChange & { storedBefore: DefaultProviderState }> = [];
  const listeners = new Set<(p: ProviderId, c: "authorization" | "refreshed") => void>();
  const defaults = createDefaultProviders({
    setting: {
      read: async () => stored,
      write: async (next) => {
        stored = next;
      },
    },
    accounts: {
      read: () => reports,
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    providers: ["anthropic", "openai"],
    creditsEnabled: options.credits ?? (() => false),
    beforeChange: async (change) => {
      changes.push({ ...change, storedBefore: stored });
    },
    ...(options.seed ? { seed: options.seed } : {}),
    now: () => new Date("2026-11-16T12:00:00.000Z"),
  });
  return { defaults, stored: () => stored, changes };
}

describe("the default provider as Rome keeps it", () => {
  it("waits for every account to be read before it sets one", async () => {
    const { defaults } = keeper({ anthropic: reportOf("available") });
    await defaults.reconcile();
    expect(defaults.current()).toBeNull();
  });

  it("starts an upgrade from the provider the Concierge runs on, else the old order", async () => {
    const both = { anthropic: reportOf("available"), openai: reportOf("available") };
    const seeded = keeper(both, { seed: async () => "anthropic" });
    await seeded.defaults.reconcile();
    expect(seeded.defaults.current()).toBe("anthropic");
    const plain = keeper(both);
    await plain.defaults.reconcile();
    expect(plain.defaults.current()).toBe("openai");
  });

  it("moves a removed default to the one left, with a note, and keeps an expired one", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("expired"),
      openai: reportOf("available"),
    };
    const { defaults } = keeper(reports, { stored: { provider: "anthropic" } });
    await defaults.reconcile();
    expect(defaults.current()).toBe("anthropic");
    reports.anthropic = reportOf("unauthorized");
    await defaults.reconcile();
    expect(defaults.current()).toBe("openai");
    expect(defaults.note()).toMatchObject({ from: "anthropic", to: "openai" });
    reports.anthropic = reportOf("available");
    await defaults.reconcile();
    expect(defaults.current()).toBe("openai");
  });

  it("gives Rome credits up to the first login, without a note, moving every chat", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("unauthorized"),
      openai: reportOf("unauthorized"),
    };
    const { defaults, changes } = keeper(reports, { credits: () => true });
    await defaults.reconcile();
    expect(defaults.current()).toBe("rome_credits");
    reports.openai = reportOf("available");
    await defaults.reconcile();
    expect(defaults.current()).toBe("openai");
    expect(defaults.note()).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({
      from: "rome_credits",
      to: "openai",
      by: "first",
      moveExisting: true,
    });
  });

  it("the default changes on the last logout: Rome credits take it over", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("available"),
      openai: reportOf("unauthorized"),
    };
    const { defaults, changes } = keeper(reports, {
      stored: { provider: "anthropic" },
      credits: () => true,
    });
    reports.anthropic = reportOf("unauthorized");
    await defaults.reconcile();
    expect(defaults.current()).toBe("rome_credits");
    expect(defaults.note()).toMatchObject({ from: "anthropic", to: "rome_credits" });
    expect(changes.at(-1)).toMatchObject({ to: "rome_credits", by: "removed", moveExisting: true });
  });

  it("the default stays on the last logout when Rome credits cannot run either", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("available"),
      openai: reportOf("unauthorized"),
    };
    const { defaults } = keeper(reports, { stored: { provider: "anthropic" } });
    reports.anthropic = reportOf("unauthorized");
    await defaults.reconcile();
    expect(defaults.current()).toBe("anthropic");
  });

  it("a logout moves existing chats only as its dialog said", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("available"),
      openai: reportOf("available"),
    };
    const { defaults, changes } = keeper(reports, { stored: { provider: "openai" } });
    defaults.expectLogout("openai", { moveExisting: false });
    reports.openai = reportOf("unauthorized");
    await defaults.reconcile();
    expect(changes.at(-1)).toMatchObject({ from: "openai", to: "anthropic", moveExisting: false });
    // The choice is spent: the next logout that names none moves them.
    reports.openai = reportOf("available");
    await defaults.choose("openai");
    reports.openai = reportOf("unauthorized");
    await defaults.reconcile();
    expect(changes.at(-1)).toMatchObject({ to: "anthropic", moveExisting: true });
  });

  it("the default changes on a logout to the other login even when its login expired", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("expired"),
      openai: reportOf("available"),
    };
    const { defaults } = keeper(reports, { stored: { provider: "openai" } });
    reports.openai = reportOf("unauthorized");
    await defaults.reconcile();
    expect(defaults.current()).toBe("anthropic");
  });

  it("a login while Rome credits are the default takes it, and moves every chat", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("unauthorized"),
      openai: reportOf("unauthorized"),
    };
    let credits = true;
    const { defaults, changes } = keeper(reports, {
      stored: { provider: "rome_credits" },
      credits: () => credits,
    });
    await defaults.reconcile();
    reports.anthropic = reportOf("available");
    credits = true;
    await defaults.reconcile();
    expect(defaults.current()).toBe("anthropic");
    expect(defaults.note()).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({ from: "rome_credits", by: "first", moveExisting: true });
  });

  it("a failure never changes the default: a usage limit or an expired login keeps it", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("available"),
      openai: reportOf("available"),
    };
    const { defaults, changes } = keeper(reports, { stored: { provider: "anthropic" } });
    reports.anthropic = reportOf("usage_limit_reached");
    await defaults.reconcile();
    reports.anthropic = reportOf("expired");
    await defaults.reconcile();
    expect(defaults.current()).toBe("anthropic");
    expect(changes).toHaveLength(0);
  });

  it("hides Rome credits while any account is logged in, an expired one included", async () => {
    const { defaults } = keeper(
      { anthropic: reportOf("expired"), openai: reportOf("unauthorized") },
      { stored: { provider: "anthropic" }, credits: () => true },
    );
    await defaults.reconcile();
    expect(defaults.signedIn().rome_credits).toBe(false);
    await expect(defaults.choose("rome_credits")).rejects.toThrow("not signed in");
  });

  it("moves a logged-out default to the other login, and every chat with it", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("available"),
      openai: reportOf("available"),
    };
    const { defaults, changes } = keeper(reports, { stored: { provider: "openai" } });
    reports.openai = reportOf("unauthorized");
    await defaults.reconcile();
    expect(changes.at(-1)).toMatchObject({ to: "anthropic", by: "removed", moveExisting: true });
  });

  it("asks before it stores whether chats that follow the default move", async () => {
    const { defaults, changes } = keeper(
      { anthropic: reportOf("available"), openai: reportOf("available") },
      { stored: { provider: "anthropic" } },
    );
    await defaults.choose("openai", { moveExisting: false });
    expect(changes).toEqual([
      expect.objectContaining({
        from: "anthropic",
        to: "openai",
        by: "guardian",
        moveExisting: false,
        storedBefore: { provider: "anthropic" },
      }),
    ]);
    await defaults.choose("anthropic");
    expect(changes.at(-1)).toMatchObject({ moveExisting: true });
  });

  it("lets the guardian pick only a signed-in provider, and clears the note", async () => {
    const { defaults } = keeper(
      { anthropic: reportOf("available"), openai: reportOf("unauthorized") },
      { stored: { provider: "anthropic", note: { from: "openai", to: "anthropic", at: "x" } } },
    );
    await expect(defaults.choose("openai")).rejects.toThrow("not signed in");
    await defaults.choose("anthropic");
    expect(defaults.note()).toBeUndefined();
  });
});
