import { describe, expect, it } from "@rstest/core";
import type { ArtifactOwnership } from "../apps/types.js";
import { createUsageAppDirectory } from "./app-directory.js";

const apps = {
  news: { appId: "news", firstParty: false, source: { mode: "appstore", listingId: "@acme/news" } },
  coding: { appId: "coding", firstParty: true, source: { mode: "bundle", path: "/apps/coding" } },
  "my-tracker": {
    appId: "my-tracker",
    firstParty: false,
    source: { mode: "bundle", path: "/home/me/apps/my-tracker" },
  },
} as const;

const owners: Record<string, ArtifactOwnership> = {
  "news.digest": { ownerType: "app", ownerId: "news" },
  "coding.review": { ownerType: "app", ownerId: "coding" },
  "tracker.log": { ownerType: "app", ownerId: "my-tracker" },
  "core.memory": { ownerType: "core", ownerId: "core" },
};

const directory = createUsageAppDirectory({
  appCatalog: {
    get: (id: string) => ((apps as Record<string, unknown>)[id] ?? null) as never,
  },
  actionRegistry: { getMetadata: (name) => owners[name] },
  agentLoader: {
    getRecord: (name: string) => {
      if (name === "news_agent") return { metadata: owners["news.digest"] } as never;
      throw new Error(`Agent "${name}" not found`);
    },
  },
});

describe("createUsageAppDirectory", () => {
  it("names store apps by listing id and first-party apps by app id", () => {
    expect(directory.forAction("news.digest")).toBe("@acme/news");
    expect(directory.forAction("coding.review")).toBe("first-party:coding");
  });

  it("keeps the guardian's own app names on the instance", () => {
    expect(directory.forAction("tracker.log")).toBe("local");
    expect(directory.forApp("my-tracker")).toBe("local");
  });

  it("returns null for core work, unknown apps, and unloaded agents", () => {
    expect(directory.forAction("core.memory")).toBeNull();
    expect(directory.forApp("uninstalled")).toBeNull();
    expect(directory.forAgent("news_agent")).toBe("@acme/news");
    expect(directory.forAgent("gone")).toBeNull();
  });
});
