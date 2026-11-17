import { describe, expect, it } from "@rstest/core";
import type { DefaultProviderState } from "../domain/default-provider.js";
import type {
  ModelAccountReport,
  ModelAccountReports,
  ProviderAvailabilityState,
} from "../domain/model-account-report.js";
import type { ProviderId } from "../domain/model-port.js";
import { createDefaultProviders } from "./default-providers.js";

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
    creditsSignedIn: options.credits ?? (() => false),
    ...(options.seed ? { seed: options.seed } : {}),
    now: () => new Date("2026-11-16T12:00:00.000Z"),
  });
  return { defaults, stored: () => stored };
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

  it("keeps Rome credits as the default until a read says they are gone", async () => {
    let credits: boolean | undefined;
    const { defaults } = keeper(
      { anthropic: reportOf("available"), openai: reportOf("unauthorized") },
      { stored: { provider: "rome_credits" }, credits: () => credits },
    );
    await defaults.reconcile();
    expect(defaults.current()).toBe("rome_credits");
    credits = false;
    await defaults.reconcile();
    expect(defaults.current()).toBe("anthropic");
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
