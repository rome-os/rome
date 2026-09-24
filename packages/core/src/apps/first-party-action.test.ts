import { describe, it, expect } from "@rstest/core";
import { isFirstPartyAction, type FirstPartyCatalog } from "./first-party-action.js";
import type { AppView, ArtifactRef } from "./state.js";

function catalog(
  apps: Record<string, { firstParty: boolean }>,
  refs: Record<string, Pick<ArtifactRef, "ownerType" | "ownerId">> = {},
): FirstPartyCatalog {
  return {
    get: (appId) => (apps[appId] ? (apps[appId] as unknown as AppView) : null),
    findArtifact: (_kind, name) => (refs[name] ? (refs[name] as ArtifactRef) : null),
  };
}

describe("isFirstPartyAction", () => {
  const apps = { system: { firstParty: true }, "store-app": { firstParty: false } };

  it("trusts a canonical action owned by a first-party app", () => {
    expect(isFirstPartyAction(catalog(apps), "system:send_message")).toBe(true);
  });

  it("does not trust a canonical action owned by a non-first-party app", () => {
    expect(isFirstPartyAction(catalog(apps), "store-app:send_message")).toBe(false);
  });

  it("does not trust an action whose app is not installed", () => {
    expect(isFirstPartyAction(catalog(apps), "ghost:send_message")).toBe(false);
  });

  it("trusts a core-owned action", () => {
    expect(isFirstPartyAction(catalog({}), "core:something")).toBe(true);
  });

  it("resolves a legacy bare name through the catalog", () => {
    const refs = {
      create_routine: { ownerType: "app" as const, ownerId: "system" },
      spoofed: { ownerType: "app" as const, ownerId: "store-app" },
    };
    expect(isFirstPartyAction(catalog(apps, refs), "create_routine")).toBe(true);
    expect(isFirstPartyAction(catalog(apps, refs), "spoofed")).toBe(false);
  });

  it("does not trust an unknown bare name", () => {
    expect(isFirstPartyAction(catalog(apps), "send_message")).toBe(false);
  });
});
