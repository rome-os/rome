import { describe, expect, it, rs } from "@rstest/core";
import type { TFunction } from "i18next";
import type { InstalledAppCard } from "@rome/api-types/apps";
import type { AppLifecycle } from "@/hooks/use-app-lifecycle";
import type { UpgradeCandidate } from "@/hooks/use-apps";
import { getAppActionMenuEntries, type AppActionMenuEntry } from "./app-action-menu";

// Labels come back as raw i18n keys; the tests assert structure, not copy.
const t = ((key: string) => key) as TFunction<"apps">;

function makeApp(overrides: Partial<InstalledAppCard> = {}): InstalledAppCard {
  return {
    id: "@ray/demo",
    version: "1.2.0",
    description: "",
    displayName: "Demo",
    status: "active",
    phase: "installed",
    hasFrontend: true,
    href: "/apps/@ray/demo",
    fullHref: "/full/apps/@ray/demo",
    capabilities: [],
    capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    canPublish: true,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: true,
    source: { mode: "source", path: "projects/apps/demo" },
    projectPath: "projects/apps/demo",
    origin: "local",
    iconUrl: null,
    ...overrides,
  };
}

function makeLifecycle(overrides: Partial<AppLifecycle> = {}): AppLifecycle {
  return {
    lifecycleBusy: false,
    accessBusy: false,
    bulkUpgradePending: false,
    isAppActing: () => false,
    actingLabelFor: () => null,
    freshCandidate: () => undefined,
    upgradeTargets: [],
    toggle: rs.fn(),
    upgrade: rs.fn(),
    upgradeAll: rs.fn(),
    requestUninstall: rs.fn(),
    requestPublish: rs.fn(),
    requestAccess: rs.fn(),
    startChatToUpdate: rs.fn(),
    dialogs: null,
    ...overrides,
  };
}

const keysOf = (entries: AppActionMenuEntry[]) => entries.map((entry) => entry.key);

describe("getAppActionMenuEntries", () => {
  it("yields the full ordered menu for a fully-capable app", () => {
    const entries = getAppActionMenuEntries({
      app: makeApp(),
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: { pinned: false, onToggle: rs.fn() },
      onRemix: null,
    });
    expect(keysOf(entries)).toEqual([
      "details",
      "chat",
      "full-view",
      "pin",
      "distribution-separator",
      "access",
      "publish",
      "danger-separator",
      "toggle",
      "uninstall",
      "uninstall-purge",
    ]);
  });

  it("collapses to just View details when no capability applies", () => {
    const entries = getAppActionMenuEntries({
      app: makeApp({
        hasFrontend: false,
        href: null,
        fullHref: null,
        projectPath: null,
        canToggle: false,
        canUninstall: false,
        canPublish: false,
        canManagePublicAccess: false,
      }),
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: { pinned: false, onToggle: rs.fn() },
      onRemix: null,
    });
    expect(keysOf(entries)).toEqual(["details"]);
  });

  it("prepends the upgrade entry when a fresh candidate exists", () => {
    const candidate: UpgradeCandidate = {
      appId: "@ray/demo",
      currentVersion: "1.2.0",
      availableVersion: "1.3.0",
      targetSource: { mode: "source", path: "projects/apps/demo" },
    };
    const entries = getAppActionMenuEntries({
      app: makeApp(),
      lifecycle: makeLifecycle({ freshCandidate: () => candidate }),
      t,
      disabled: false,
      pin: { pinned: false, onToggle: rs.fn() },
      onRemix: null,
    });
    expect(keysOf(entries).slice(0, 3)).toEqual(["upgrade", "upgrade-separator", "details"]);
  });

  it("shows Remix only for a remixable app with a handler", () => {
    const remixable = makeApp({ origin: "appstore", includeSource: true });
    const withHandler = getAppActionMenuEntries({
      app: remixable,
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: null,
      onRemix: rs.fn(),
    });
    expect(keysOf(withHandler).slice(0, 2)).toEqual(["remix", "remix-separator"]);

    const withoutHandler = getAppActionMenuEntries({
      app: remixable,
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: null,
      onRemix: null,
    });
    expect(keysOf(withoutHandler)).not.toContain("remix");

    const notRemixable = getAppActionMenuEntries({
      app: makeApp({ origin: "local" }),
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: null,
      onRemix: rs.fn(),
    });
    expect(keysOf(notRemixable)).not.toContain("remix");
  });

  it("hides Pin without an embedded frontend or without pin wiring", () => {
    const noFrontend = getAppActionMenuEntries({
      app: makeApp({ hasFrontend: false, href: null }),
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: { pinned: false, onToggle: rs.fn() },
      onRemix: null,
    });
    expect(keysOf(noFrontend)).not.toContain("pin");

    const noPinWiring = getAppActionMenuEntries({
      app: makeApp(),
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: null,
      onRemix: null,
    });
    expect(keysOf(noPinWiring)).not.toContain("pin");
  });

  it("marks destructive entries and routes disabled only to mutating ones", () => {
    const entries = getAppActionMenuEntries({
      app: makeApp(),
      lifecycle: makeLifecycle(),
      t,
      disabled: true,
      pin: { pinned: false, onToggle: rs.fn() },
      onRemix: null,
    });
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const action = (key: string) => {
      const entry = byKey.get(key);
      if (entry?.type !== "action") throw new Error(`expected action entry: ${key}`);
      return entry;
    };
    // Enabled app: Disable reads as destructive; uninstalls always do.
    expect(action("toggle").destructive).toBe(true);
    expect(action("uninstall").destructive).toBe(true);
    expect(action("uninstall-purge").destructive).toBe(true);
    expect(action("access").destructive).toBeUndefined();
    // Busy lifecycle grays the writes but never the navigational entries.
    expect(action("toggle").disabled).toBe(true);
    expect(action("publish").disabled).toBe(true);
    expect(action("uninstall").disabled).toBe(true);
    expect(action("chat").disabled).toBeUndefined();
    expect(action("pin").disabled).toBeUndefined();
  });

  it("reads Enable (non-destructive) for a disabled app", () => {
    const entries = getAppActionMenuEntries({
      app: makeApp({ isEnabled: false, status: "disabled" }),
      lifecycle: makeLifecycle(),
      t,
      disabled: false,
      pin: null,
      onRemix: null,
    });
    const toggle = entries.find((entry) => entry.key === "toggle");
    expect(toggle?.type === "action" && toggle.destructive).toBe(false);
    expect(toggle?.type === "action" && toggle.label).toBe("toggle.enable");
  });

  it("wires entry callbacks to the lifecycle", () => {
    const lifecycle = makeLifecycle();
    const app = makeApp();
    const entries = getAppActionMenuEntries({
      app,
      lifecycle,
      t,
      disabled: false,
      pin: null,
      onRemix: null,
    });
    const select = (key: string) => {
      const entry = entries.find((candidate) => candidate.key === key);
      if (entry?.type !== "action") throw new Error(`expected action entry: ${key}`);
      entry.onSelect();
    };
    select("chat");
    expect(lifecycle.startChatToUpdate).toHaveBeenCalledWith(app);
    select("uninstall");
    expect(lifecycle.requestUninstall).toHaveBeenCalledWith(app, false);
    select("uninstall-purge");
    expect(lifecycle.requestUninstall).toHaveBeenCalledWith(app, true);
  });
});
