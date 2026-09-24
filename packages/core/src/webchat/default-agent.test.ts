import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AppView, CatalogEvent } from "../apps/state.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import {
  WEBCHAT_DEFAULT_AGENT_SETTING,
  createWebchatDefaultAgentSubscriber,
  effectiveDefaultAgent,
  parseSavedDefaultAgent,
  readSavedDefaultAgent,
  reconcileWebchatDefaultAgentAtBoot,
  shouldClearOnCatalogEvent,
} from "./default-agent.js";

const SAVED = { agentName: "helper-app:helper", ownerAppId: "helper-app" };

function view(overrides: Partial<AppView> = {}): AppView {
  return {
    appId: SAVED.ownerAppId,
    source: { mode: "bundle", path: "/bundle" },
    enabled: true,
    firstParty: false,
    state: "installed",
    installedHash: "hash",
    installedVersion: "1.0.0",
    lastError: null,
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  } as AppView;
}

function changed(overrides: Partial<AppView> = {}): CatalogEvent {
  return {
    appId: overrides.appId ?? SAVED.ownerAppId,
    change: "changed",
    current: view(overrides),
  };
}

const removed: CatalogEvent = { appId: SAVED.ownerAppId, change: "removed", current: null };

describe("Webchat default agent setting", () => {
  let testDb: TestDb;
  let settings: SettingsRepository;

  beforeEach(async () => {
    testDb = createTestDb();
    settings = new SettingsRepository(testDb.db);
  });

  afterEach(() => testDb.close());

  it("reads an absent row as no saved choice and the main agent as effective", async () => {
    const saved = await readSavedDefaultAgent(settings);
    expect(saved).toBeNull();
    expect(effectiveDefaultAgent(saved, { has: () => true })).toBe("main");
  });

  it("reads a malformed value as unset", () => {
    expect(parseSavedDefaultAgent("helper-app:helper")).toBeNull();
    expect(parseSavedDefaultAgent({ agentName: "helper-app:helper" })).toBeNull();
    expect(parseSavedDefaultAgent({ agentName: "", ownerAppId: "helper-app" })).toBeNull();
    expect(parseSavedDefaultAgent(SAVED)).toEqual(SAVED);
  });

  it("treats a saved agent that is not loaded as main without clearing it", () => {
    expect(effectiveDefaultAgent(SAVED, { has: () => false })).toBe("main");
    expect(effectiveDefaultAgent(SAVED, { has: () => true })).toBe(SAVED.agentName);
  });

  describe("removal rule", () => {
    it("clears when the owning app is uninstalled or disabled", () => {
      expect(shouldClearOnCatalogEvent(removed, SAVED)).toBe(true);
      expect(shouldClearOnCatalogEvent(changed({ enabled: false }), SAVED)).toBe(true);
    });

    it.each([
      ["installing", changed({ state: "installing" })],
      ["uninstalling", changed({ state: "uninstalling" })],
      ["broken", changed({ state: "broken" })],
      ["failed", changed({ state: "failed" })],
      ["installed, agent not yet loaded", changed()],
      ["added at boot", { ...changed(), change: "added" } as CatalogEvent],
      ["another app removed", { ...removed, appId: "other-app" }],
      ["another app disabled", changed({ appId: "other-app", enabled: false })],
    ])("keeps the choice for %s", (_label, event) => {
      expect(shouldClearOnCatalogEvent(event, SAVED)).toBe(false);
    });

    it("deletes the row on uninstall and never restores it when the app returns", async () => {
      await settings.set(WEBCHAT_DEFAULT_AGENT_SETTING, SAVED);
      const subscriber = createWebchatDefaultAgentSubscriber(settings);

      await subscriber(changed({ state: "uninstalling" }));
      expect(await readSavedDefaultAgent(settings)).toEqual(SAVED);
      await subscriber(removed);
      expect(await settings.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();

      await subscriber({ ...changed(), change: "added" });
      expect(await settings.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();
    });

    it("deletes the row on disable and keeps it cleared after re-enable", async () => {
      await settings.set(WEBCHAT_DEFAULT_AGENT_SETTING, SAVED);
      const subscriber = createWebchatDefaultAgentSubscriber(settings);

      await subscriber(changed({ enabled: false }));
      expect(await settings.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();
      await subscriber(changed({ enabled: true }));
      expect(await settings.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();
    });

    it("keeps the row through a reinstall", async () => {
      await settings.set(WEBCHAT_DEFAULT_AGENT_SETTING, SAVED);
      const subscriber = createWebchatDefaultAgentSubscriber(settings);

      await subscriber(changed({ state: "installing" }));
      await subscriber(changed({ state: "installed", installedVersion: "2.0.0" }));
      expect(await readSavedDefaultAgent(settings)).toEqual(SAVED);
    });

    it("does not throw into the catalog when the settings store fails", async () => {
      const failing = {
        get: async () => {
          throw new Error("database is locked");
        },
        set: async () => {},
        delete: async () => {},
      };
      await expect(createWebchatDefaultAgentSubscriber(failing)(removed)).resolves.toBeUndefined();
    });
  });

  describe("boot reconcile", () => {
    const catalogWith = (owner: AppView | null) => ({
      get: (appId: string) => (appId === SAVED.ownerAppId ? owner : null),
    });

    it("clears the choice when the owning app is absent", async () => {
      await settings.set(WEBCHAT_DEFAULT_AGENT_SETTING, SAVED);
      await reconcileWebchatDefaultAgentAtBoot(settings, catalogWith(null));
      expect(await settings.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();
    });

    it("clears the choice when the owning app is disabled", async () => {
      await settings.set(WEBCHAT_DEFAULT_AGENT_SETTING, SAVED);
      await reconcileWebchatDefaultAgentAtBoot(settings, catalogWith(view({ enabled: false })));
      expect(await settings.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();
    });

    it.each([
      ["installed and enabled", view()],
      ["broken", view({ state: "broken" })],
      ["failed", view({ state: "failed" })],
    ])("keeps the choice when the owning app is %s, whether or not its agent loaded", async (_l, owner) => {
      await settings.set(WEBCHAT_DEFAULT_AGENT_SETTING, SAVED);
      await reconcileWebchatDefaultAgentAtBoot(settings, catalogWith(owner));
      expect(await readSavedDefaultAgent(settings)).toEqual(SAVED);
    });

    it("keeps a Rome built-in agent, which no app lifecycle can remove", async () => {
      const core = { agentName: "core:envoy", ownerAppId: "core" };
      await settings.set(WEBCHAT_DEFAULT_AGENT_SETTING, core);
      await reconcileWebchatDefaultAgentAtBoot(settings, catalogWith(null));
      expect(await readSavedDefaultAgent(settings)).toEqual(core);
    });
  });
});
