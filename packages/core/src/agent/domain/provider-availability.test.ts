import { describe, expect, it } from "@rstest/core";
import type { ModelAccountReport, ProviderAvailabilityState } from "./model-account-report.js";
import { providerAvailability } from "./provider-availability.js";

function reportOf(state: ProviderAvailabilityState): ModelAccountReport {
  return { state, account: { loggedIn: state !== "unauthorized" } };
}

describe("providerAvailability", () => {
  const credits = { kind: "rome_credits", credentialId: "c", modelsServed: null } as const;

  it("reads the account on the guardian's own login", () => {
    const subscription = { kind: "subscription" } as const;
    expect(providerAvailability(reportOf("expired"), subscription)).toBe("expired");
    expect(providerAvailability(reportOf("usage_limit_reached"), undefined)).toBe(
      "usage_limit_reached",
    );
  });

  it("makes Codex available on Rome credits, whatever the account says", () => {
    expect(providerAvailability(reportOf("unauthorized"), credits)).toBe("available");
    expect(providerAvailability(reportOf("expired"), credits)).toBe("available");
  });

  it("reads a provider Rome has not read yet as available", () => {
    expect(providerAvailability(undefined, undefined)).toBe("available");
  });
});
