import { describe, expect, it, rs } from "@rstest/core";
import type { InstalledAppCard } from "@rome/api-types/apps";
import type { DrizzleDb } from "../db/index.js";
import { approvalOf, callTool, whoMayAskSuite } from "./actions/agent-tool-contract.js";
import {
  type AppToolDeps,
  manageApp,
  publishApp,
  readApps,
  searchAppStore,
  shareApp,
} from "./agent-tools.js";
import type { AppPermissionsSetting } from "./app-permissions.js";
import type { AppCatalog } from "./catalog.js";
import { AppManagerError, type InstallResult } from "./manager.js";
import type { AppStoreListing } from "./store-service.js";

whoMayAskSuite(readApps, {});
whoMayAskSuite(searchAppStore, { query: "notes" });
whoMayAskSuite(manageApp, { change: "turn_off", appId: "notes" });
whoMayAskSuite(publishApp, { appId: "notes" });
whoMayAskSuite(shareApp, { appId: "notes", access: "anyone_with_link" });

const HASH = "a".repeat(64);

// Two rows as `GET /api/apps` lists them, with fields the page reads beyond
// what the agent gets: the source path, the icon, the artifact details.
const notes = {
  id: "notes",
  version: "1.2.0",
  description: "Keep notes.",
  displayName: "Notes",
  status: "active",
  phase: "installed",
  hasFrontend: true,
  href: "/apps/notes",
  fullHref: "/full/apps/notes",
  capabilities: ["1 agent", "2 actions", "0 skills", "0 hooks"],
  capabilityDetails: {
    agents: [{ name: "notes-agent", description: "Writes notes." }],
    actions: [],
    skills: [],
    hooks: [],
  },
  isEnabled: true,
  canToggle: true,
  canUninstall: true,
  canPublish: true,
  accessMode: "cloud-email",
  isPublic: false,
  cloudAllowedEmails: ["ada@example.com"],
  canManagePublicAccess: true,
  source: { mode: "source", path: "/home/guardian/projects/apps/notes" },
  projectPath: "apps/notes",
  origin: "local",
  iconUrl: "/api/apps/notes/icon",
} as InstalledAppCard;
const digest = {
  ...notes,
  id: "digest",
  displayName: "Digest",
  version: "0.1.0",
  status: "disabled",
  isEnabled: false,
  hasFrontend: false,
  href: null,
  fullHref: null,
  canPublish: false,
  accessMode: "private",
  cloudAllowedEmails: [],
  canManagePublicAccess: false,
  source: { mode: "appstore", listingId: "digest", version: "0.1.0" },
  projectPath: null,
  origin: "appstore",
} as InstalledAppCard;

const calendar: AppStoreListing = {
  id: "@ray/calendar",
  handle: "ray",
  slug: "calendar",
  name: "Calendar",
  description: "A calendar.",
  iconUrl: "https://store.example/icon.png",
  categories: ["productivity"],
  installCount: 12,
  highestVersion: "2.0.0",
  verified: true,
  updatedAt: "2026-11-01T00:00:00.000Z",
  installed: {
    appId: "@ray/calendar",
    installed: false,
    phase: null,
    enabled: null,
    installedVersion: null,
    sourceMode: null,
  },
};

const version = (v: string, state: "live" | "revoked" = "live") => ({
  version: v,
  contentHash: `${v.replaceAll(".", "")}`.padEnd(64, "0"),
  sizeBytes: 100,
  sourceAvailable: false,
  state,
  publishedAt: "2026-11-01T00:00:00.000Z",
});

function operations(overrides: Partial<AppToolDeps> = {}) {
  let setting: AppPermissionsSetting = {
    allowedApps: ["other"],
    cloudEmailAccess: { notes: ["ada@example.com"] },
  };
  const manager = {
    install: rs.fn(
      async (): Promise<InstallResult> => ({
        appId: "@ray/calendar",
        state: "installed",
        installedHash: HASH,
        installedVersion: "2.0.0",
        error: null,
      }),
    ),
    setEnabled: rs.fn(async () => {}),
    uninstall: rs.fn(async () => ({ alreadyAbsent: false, purged: false, diskCleanupError: null })),
  };
  const appStore = {
    listListings: rs.fn(async () => ({
      status: 200,
      body: { available: true, browseOrigin: "https://store.example", listings: [calendar] },
    })),
    getListing: rs.fn(async () => ({
      status: 200,
      body: {
        available: true,
        browseOrigin: "https://store.example",
        listing: calendar,
        versions: [version("2.0.0"), version("1.0.0"), version("0.9.0", "revoked")],
      },
    })),
  };
  const save = rs.fn(async (next: AppPermissionsSetting) => {
    setting = next;
  });
  const deps: AppToolDeps = {
    apps: async () => [notes, digest],
    updates: async () => ({
      upgradable: [
        {
          appId: "digest",
          currentVersion: "0.1.0",
          availableVersion: "0.2.0",
          targetSource: { mode: "appstore", listingId: "digest", version: "0.2.0" },
        },
      ],
    }),
    appStore,
    manager,
    catalog: { get: () => undefined } as unknown as AppCatalog,
    db: {} as DrizzleDb,
    publish: rs.fn(async () => ({
      status: "refused" as const,
      httpStatus: 404 as const,
      error: "",
    })),
    appAccess: { load: async () => setting, save },
    publicOrigin: () => "https://ada.romeos.cc",
    ...overrides,
  };
  const call = (tool: Parameters<typeof callTool<AppToolDeps>>[0]) => (input: object) =>
    callTool(tool, deps, input as Record<string, unknown>);
  const ops = {
    read: call(readApps),
    search: call(searchAppStore),
    manage: call(manageApp),
    publish: call(publishApp),
    share: call(shareApp),
    approval: (tool: Parameters<typeof approvalOf<AppToolDeps>>[0], input: object) =>
      approvalOf(tool, deps, input as Record<string, unknown>),
  };
  return { ops, manager, appStore, save, deps, setting: () => setting };
}

describe("reading the installed apps", () => {
  it("lists each app with its state, update, page and who may open it", async () => {
    const { ops } = operations();

    expect(await ops.read({})).toEqual({
      status: "ok",
      data: {
        apps: [
          {
            appId: "notes",
            name: "Notes",
            version: "1.2.0",
            description: "Keep notes.",
            origin: "local",
            state: "active",
            hasPage: true,
            access: "listed_emails",
            sharedWith: ["ada@example.com"],
            canTurnOff: true,
            canRemove: true,
            canPublish: true,
          },
          {
            appId: "digest",
            name: "Digest",
            version: "0.1.0",
            description: "Keep notes.",
            origin: "appstore",
            state: "disabled",
            updateTo: "0.2.0",
            hasPage: false,
            access: "private",
            canTurnOff: true,
            canRemove: true,
            canPublish: false,
          },
        ],
      },
    });
  });

  it("carries no path, source, link or artifact of the page's rows", async () => {
    const { ops } = operations();

    const text = JSON.stringify(await ops.read({}));

    for (const field of ["/home/guardian", "projectPath", "/api/apps", "notes-agent", "href"]) {
      expect(text).not.toContain(field);
    }
  });

  it("names a phase that is not installed, such as installing, as the state", async () => {
    const { ops } = operations({ apps: async () => [{ ...notes, phase: "installing" }] });

    expect(await ops.read({})).toMatchObject({
      data: { apps: [{ appId: "notes", state: "installing" }] },
    });
  });
});

describe("searching the App Store", () => {
  it("lists the listings found, with whether each is installed", async () => {
    const { ops, appStore } = operations();

    expect(await ops.search({ query: " calendar " })).toEqual({
      status: "ok",
      data: {
        listings: [
          {
            listingId: "@ray/calendar",
            name: "Calendar",
            description: "A calendar.",
            latestVersion: "2.0.0",
            verified: true,
            installCount: 12,
            installed: null,
          },
        ],
      },
    });
    expect(appStore.listListings).toHaveBeenCalledWith({
      query: "calendar",
      limit: 10,
      includeInstalledState: true,
    });
  });

  it("reads one listing with the versions it offers, leaving out revoked ones", async () => {
    const { ops } = operations();

    expect(await ops.search({ listingId: "@ray/calendar" })).toMatchObject({
      status: "ok",
      data: {
        listing: { listingId: "@ray/calendar" },
        versions: [
          { version: "2.0.0", publishedAt: "2026-11-01T00:00:00.000Z" },
          { version: "1.0.0", publishedAt: "2026-11-01T00:00:00.000Z" },
        ],
      },
    });
  });

  it("says why when the store is not available on this Rome", async () => {
    const { ops } = operations({
      appStore: {
        listListings: async () => ({
          status: 200,
          body: {
            available: false,
            reason: "No Rome Cloud origin.",
            listings: [],
            browseOrigin: null,
          },
        }),
        getListing: async () => ({ status: 200, body: { available: false, browseOrigin: null } }),
      },
    });

    expect(await ops.search({})).toEqual({ status: "error", error: "No Rome Cloud origin." });
  });
});

describe("managing an app", () => {
  it("installs a store app at its latest live version, pinned to that version's bytes", async () => {
    const { ops, manager } = operations();

    expect(await ops.manage({ change: "install", listingId: "@ray/calendar" })).toEqual({
      status: "ok",
      data: { appId: "@ray/calendar", version: "2.0.0", installed: true },
    });
    expect(manager.install).toHaveBeenCalledWith({
      source: {
        mode: "appstore",
        listingId: "@ray/calendar",
        version: "2.0.0",
        contentHash: version("2.0.0").contentHash,
      },
    });
  });

  it("installs a version the guardian names, and refuses one the listing does not offer", async () => {
    const { ops, manager } = operations();

    expect(
      await ops.manage({ change: "install", listingId: "@ray/calendar", version: "1.0.0" }),
    ).toMatchObject({ status: "ok", data: { version: "1.0.0" } });
    const revoked = await ops.manage({
      change: "install",
      listingId: "@ray/calendar",
      version: "0.9.0",
    });

    expect(revoked.status === "error" && revoked.error).toContain("system:search_app_store");
    expect(manager.install).toHaveBeenCalledTimes(1);
  });

  it("answers a failed install with its reason", async () => {
    const { ops, manager } = operations();
    manager.install.mockImplementation(async () => ({
      appId: "@ray/calendar",
      state: "failed",
      installedHash: null,
      installedVersion: null,
      error: { code: "BUILD_FAILED", message: "the build broke" },
    }));

    expect(await ops.manage({ change: "install", listingId: "@ray/calendar" })).toEqual({
      status: "error",
      error: "The install failed: the build broke",
    });
  });

  it("updates an app to the version the page offers, from the source the page would send", async () => {
    const { ops, manager } = operations();

    expect(await ops.manage({ change: "update", appId: "digest" })).toEqual({
      status: "ok",
      data: { appId: "digest", name: "Digest", version: "0.2.0", updated: true },
    });
    expect(manager.install).toHaveBeenCalledWith({
      source: { mode: "appstore", listingId: "digest", version: "0.2.0" },
    });
  });

  it("refuses to update an app with no update waiting", async () => {
    const { ops, manager } = operations();

    expect(await ops.manage({ change: "update", appId: "notes" })).toEqual({
      status: "error",
      error: "Notes v1.2.0 has no update waiting.",
    });
    expect(manager.install).not.toHaveBeenCalled();
  });

  it("turns an app off and on through the manager", async () => {
    const { ops, manager } = operations();

    expect(await ops.manage({ change: "turn_off", appId: "notes" })).toEqual({
      status: "ok",
      data: { appId: "notes", name: "Notes", on: false },
    });
    await ops.manage({ change: "turn_on", appId: "digest" });

    expect(manager.setEnabled.mock.calls).toEqual([
      ["notes", false],
      ["digest", true],
    ]);
  });

  it("removes an app and keeps its data unless the guardian asks to delete it", async () => {
    const { ops, manager } = operations();

    expect(await ops.manage({ change: "remove", appId: "notes" })).toEqual({
      status: "ok",
      data: { appId: "notes", name: "Notes", removed: true, dataDeleted: false },
    });
    expect(manager.uninstall).toHaveBeenCalledWith("notes", { purge: false });
  });

  it("passes on what the manager turns down, such as removing a first-party app", async () => {
    const { ops, manager } = operations();
    manager.uninstall.mockImplementation(async () => {
      throw new AppManagerError("FIRST_PARTY_PROTECTED", 'app "notes" ships with Rome');
    });

    expect(await ops.manage({ change: "remove", appId: "notes" })).toEqual({
      status: "error",
      error: 'app "notes" ships with Rome',
    });
  });

  it("names system:read_apps for an app it does not know", async () => {
    const { ops } = operations();

    const result = await ops.manage({ change: "turn_on", appId: "nope" });

    expect(result.status === "error" && result.error).toContain("system:read_apps");
  });

  it("words the approval card with the app and what happens to its data", async () => {
    const { ops } = operations();

    expect(
      await ops.approval(manageApp, { change: "remove", appId: "notes", deleteData: true }),
    ).toEqual({
      kind: "generic",
      title: "Remove Notes and delete its data",
      summary: "Rome uninstalls Notes. Its data is deleted permanently and cannot be recovered.",
    });
    expect(
      await ops.approval(manageApp, { change: "install", listingId: "@ray/calendar" }),
    ).toMatchObject({ title: "Install @ray/calendar from the App Store" });
  });
});

describe("publishing an app", () => {
  it("publishes through the page's operation and answers with the listing and version", async () => {
    const publish = rs.fn(async (appId: string) => ({
      status: "ok" as const,
      appId,
      listing: { id: "notes", handle: "notes", slug: "" },
      version: { version: "1.2.0", contentHash: HASH, sizeBytes: 10, sourceAvailable: false },
      claimed: false,
    }));
    const { ops } = operations({ publish });

    expect(await ops.publish({ appId: " notes " })).toEqual({
      status: "ok",
      data: { appId: "notes", listingId: "notes", version: "1.2.0", published: true },
    });
    expect(publish).toHaveBeenCalledWith("notes");
  });

  it("passes on why the publish was refused", async () => {
    const { ops } = operations({
      publish: async () => ({
        status: "rejected",
        httpStatus: 400,
        error: "Version 1.2.0 is already published",
      }),
    });

    expect(await ops.publish({ appId: "notes" })).toEqual({
      status: "error",
      error: "Version 1.2.0 is already published",
    });
  });

  it("words the approval card as the page's publish dialog does", async () => {
    const { ops } = operations();

    expect(await ops.approval(publishApp, { appId: "notes" })).toEqual({
      kind: "generic",
      title: "Publish Notes to the App Store",
      summary: "Anyone can find and install Notes v1.2.0 from the Rome App Store.",
    });
  });
});

describe("sharing an app", () => {
  it("lets anyone with the link open the app, leaves every other app as it was, and answers with the link", async () => {
    const { ops, setting } = operations();

    expect(await ops.share({ appId: "notes", access: "anyone_with_link" })).toEqual({
      status: "ok",
      data: {
        appId: "notes",
        name: "Notes",
        access: "anyone_with_link",
        link: "https://ada.romeos.cc/full/apps/notes",
      },
    });
    expect(setting()).toEqual({ allowedApps: ["notes", "other"], cloudEmailAccess: {} });
  });

  it("shares with listed visitors only, and stops sharing", async () => {
    const { ops, setting } = operations();

    expect(
      await ops.share({
        appId: "notes",
        access: "listed_emails",
        emails: ["Bob@Example.com", "not an email"],
      }),
    ).toMatchObject({ status: "ok", data: { emails: ["bob@example.com"] } });
    expect(setting().cloudEmailAccess).toEqual({ notes: ["bob@example.com"] });

    expect(await ops.share({ appId: "notes", access: "private" })).toEqual({
      status: "ok",
      data: { appId: "notes", name: "Notes", access: "private" },
    });
    expect(setting()).toEqual({ allowedApps: ["other"], cloudEmailAccess: {} });
  });

  it("saves nothing for a list with no valid email", async () => {
    const { ops, save } = operations();

    const result = await ops.share({ appId: "notes", access: "listed_emails", emails: ["x"] });

    expect(result.status === "error" && result.error).toContain("email");
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses an app with no page to open", async () => {
    const { ops, save } = operations();

    expect(await ops.share({ appId: "digest", access: "anyone_with_link" })).toEqual({
      status: "error",
      error: "Digest has no page to open, so it cannot be shared.",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("answers with the link's path where Rome has no public origin", async () => {
    const { ops } = operations({ publicOrigin: () => null });

    expect(await ops.share({ appId: "notes", access: "anyone_with_link" })).toMatchObject({
      data: { link: "/full/apps/notes" },
    });
  });
});
