import { describe, expect, it } from "@rstest/core";
import type { AppCatalog } from "./catalog.js";
import type { AppView } from "./state.js";
import { createRuntimeStatusFailureTracker } from "./runtime-status-subscriber.js";

describe("createRuntimeStatusFailureTracker", () => {
  it("clears recovered lifecycle failures without dropping unrelated failures", () => {
    const catalog = catalogWithViews([
      appView("app.alpha"),
      appView("app.beta"),
      appView("app.disabled", { enabled: false }),
    ]);
    const tracker = createRuntimeStatusFailureTracker(catalog);

    tracker.markFailed(
      "lifecycle:agent-turn-started:/apps/alpha/hook.js",
      "app.alpha",
      "hook broke",
    );
    tracker.markFailed("app-action:app.beta:boom", "app.beta", "action broke");
    tracker.markFailed(
      "lifecycle:agent-turn-finished:/apps/beta/hook.js",
      "app.beta",
      "hook broke",
    );
    tracker.markFailed(
      "lifecycle:agent-turn-started:/apps/disabled/hook.js",
      "app.disabled",
      "ignored",
    );

    expect(tracker.entries()).toMatchObject({
      "app.alpha": { status: "failed", error: "hook broke" },
      "app.beta": { status: "failed", error: "action broke; hook broke" },
      "app.disabled": { status: "disabled" },
    });

    tracker.clearSources((source) => source.startsWith("lifecycle:"));

    expect(tracker.entries()).toMatchObject({
      "app.alpha": { status: "active" },
      "app.beta": { status: "failed", error: "action broke" },
      "app.disabled": { status: "disabled" },
    });
    expect(tracker.entries()["app.alpha"]).not.toHaveProperty("error");
  });
});

function catalogWithViews(views: AppView[]): AppCatalog {
  return {
    list() {
      return views;
    },
  } as unknown as AppCatalog;
}

function appView(appId: string, overrides: Partial<AppView> = {}): AppView {
  return {
    appId,
    source: { mode: "bundle", path: `/apps/${appId}` },
    enabled: true,
    firstParty: false,
    state: "installed",
    installedHash: "hash",
    installedVersion: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
