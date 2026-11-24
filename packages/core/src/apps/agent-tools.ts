// What agents do on the Apps page: read the installed apps, find an app in the
// App Store, install, update, turn on or off or remove one, publish one, and
// share one with visitors. Each tool calls the operation the page's route
// calls: the installed-apps projection (`GET /api/apps`), the update probe
// (upgrade-detector.ts), the store reader (store-service.ts), the manager,
// uninstall.ts, publish.ts and app-permissions.ts. How a tool is declared:
// docs/concepts/actions.md#core-agent-tools.

import type { AppAccessMode, InstalledAppCard } from "@rome/api-types/apps";
import { z } from "zod";
import type { DrizzleDb } from "../db/index.js";
import { agentToolsOf, type ToolOutcome, toolError } from "./actions/agent-tool.js";
import {
  type AppPermissionsSetting,
  DEFAULT_APP_PERMISSIONS_SETTING,
  withAppAccess,
} from "./app-permissions.js";
import type { AppCatalog } from "./catalog.js";
import { type AppManager, AppManagerError } from "./manager.js";
import type { PublishInstalledAppOutcome } from "./publish.js";
import {
  type AppStoreListing,
  type AppStoreReader,
  type AppStoreServiceResult,
  liveVersionToInstall,
} from "./store-service.js";
import { uninstallApp } from "./uninstall.js";
import type { UpdateSummary } from "./upgrade-detector.js";

export interface AppToolDeps {
  /** The installed apps, as `GET /api/apps` lists them. */
  apps: () => Promise<InstalledAppCard[]>;
  /** The updates the page offers, as `GET /api/apps/updates` finds them. */
  updates: () => Promise<UpdateSummary>;
  appStore: AppStoreReader;
  manager: Pick<AppManager, "install" | "setEnabled" | "uninstall">;
  catalog: AppCatalog;
  db: DrizzleDb;
  /** Publishes an installed app, as `POST /api/apps/:appId/publish` does. */
  publish: (appId: string) => Promise<PublishInstalledAppOutcome>;
  /** Replaces one app's access in who besides the guardian may open each app
   *  (`/api/public-access`), keeping every other app's. */
  changeAppAccess: (
    appId: string,
    access: { mode: AppAccessMode; emails: readonly string[] },
  ) => AppPermissionsSetting;
  /** The instance's public origin, which a share link starts with; null when unknown. */
  publicOrigin: () => string | null;
}

const agentTool = agentToolsOf<AppToolDeps>();

const appId = z.string().describe("The installed app's id, from system:read_apps.");

const DESCRIPTION_LENGTH = 200;
const STORE_RESULTS = 10;

export const readApps = agentTool({
  name: "system:read_apps",
  description:
    "See the apps installed in Rome and how each one stands: on, off or failed, its version, whether an update is waiting, whether it has a page to open, and who besides the guardian may open it. Use it when the guardian asks which apps they have, whether an app is installed, on or working, or which apps can be updated, and to find an app's id before managing, publishing or sharing it",
  sideEffects: "read-only",
  input: z.object({}),
  run: async (_input, { deps }) => {
    const [apps, updates] = await Promise.all([deps.apps(), deps.updates()]);
    const updateOf = new Map(updates.upgradable.map((c) => [c.appId, c.availableVersion]));
    return { apps: apps.map((app) => installedForAgent(app, updateOf.get(app.id) ?? null)) };
  },
});

export const searchAppStore = agentTool({
  name: "system:search_app_store",
  description:
    "Find apps in the Rome App Store (also called the store or app store), or read one listing with the versions it offers. Use it when the guardian asks what the store has, whether there is an app for something, or about one store app, and to find a listing's id before installing it with system:manage_app. It is Rome's own store, not Apple's or Google's",
  sideEffects: "read-only",
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Words to search for, such as "calendar" or "github". Leave out to browse.'),
    listingId: z
      .string()
      .optional()
      .describe(
        'A listing\'s id, such as "xiaohongshu" or "@handle/slug", to read that one listing and its versions instead of searching.',
      ),
  }),
  run: async (input, { deps }) => {
    const listingId = input.listingId?.trim();
    if (listingId) {
      const detail = await deps.appStore.getListing({ listingId, includeInstalledState: true });
      const refused = storeRefusal(detail);
      if (refused) return refused;
      if (!detail.body.listing) return toolError(noListing(listingId));
      return {
        listing: listingForAgent(detail.body.listing),
        versions: (detail.body.versions ?? [])
          .filter((v) => v.state === "live")
          .map((v) => ({ version: v.version, publishedAt: v.publishedAt })),
      };
    }
    const found = await deps.appStore.listListings({
      query: input.query?.trim() ?? "",
      limit: STORE_RESULTS,
      includeInstalledState: true,
    });
    const refused = storeRefusal(found);
    if (refused) return refused;
    return { listings: found.body.listings.map(listingForAgent) };
  },
});

const CHANGES = ["install", "update", "turn_on", "turn_off", "remove"] as const;

const manageInput = z.object({
  change: z
    .enum(CHANGES)
    .describe(
      "What to do: install an app from the App Store, update an installed app to its newer version, turn an installed app on or off, or remove it.",
    ),
  appId: appId
    .optional()
    .describe("For update, turn_on, turn_off and remove: " + appId.description),
  listingId: z
    .string()
    .optional()
    .describe(
      'For install: the App Store listing\'s id, from system:search_app_store, such as "xiaohongshu" or "@handle/slug".',
    ),
  version: z
    .string()
    .optional()
    .describe("For install: a version the listing offers. Leave out for the latest."),
  deleteData: z
    .boolean()
    .optional()
    .describe(
      "For remove: true also deletes the app's data for good. Leave out to keep it for a later reinstall.",
    ),
});

export const manageApp = agentTool({
  name: "system:manage_app",
  description:
    "Install an app from the Rome App Store, update an installed app, turn one on or off, or remove one. Use it when the guardian asks to install, add, get, update, upgrade, enable, disable, turn on, turn off, uninstall or remove an app. The guardian approves a removal on a card first; the other changes run at once. Only in the guardian's private chat, in a turn their own message started. Find a store app's listing id with system:search_app_store and an installed app's id with system:read_apps",
  sideEffects: "write",
  input: manageInput,
  // Only a removal is approved. The card is shown to the guardian alone, so it
  // names the app whoever asked.
  approval: async (input, { deps }) => {
    if (input.change !== "remove") return undefined;
    const id = input.appId?.trim() ?? "";
    const app = (await deps.apps()).find((a) => a.id === id);
    return removalWords(app?.displayName ?? (id || "an app"), input.deleteData === true);
  },
  run: async (input, { deps }) => {
    if (input.change === "install") return install(deps, input.listingId, input.version);
    const id = input.appId?.trim() ?? "";
    const app = (await deps.apps()).find((a) => a.id === id);
    if (!app) return toolError(notInstalled(id));
    try {
      switch (input.change) {
        case "update":
          return await update(deps, app);
        case "turn_on":
        case "turn_off": {
          const enabled = input.change === "turn_on";
          await deps.manager.setEnabled(app.id, enabled);
          return { appId: app.id, name: app.displayName, on: enabled };
        }
        case "remove": {
          const purge = input.deleteData === true;
          await uninstallApp(deps, app.id, { purge });
          return { appId: app.id, name: app.displayName, removed: true, dataDeleted: purge };
        }
      }
    } catch (err) {
      if (err instanceof AppManagerError) return toolError(err.message);
      throw err;
    }
  },
});

export const publishApp = agentTool({
  name: "system:publish_app",
  description:
    "Publish an app the guardian made on this Rome to the Rome App Store, so anyone can find and install that version. Use it when the guardian asks to publish, release or put an app in the store. Only an app developed on this Rome can be published, and the store refuses a version it already has. The guardian approves it on a card first. Only in the guardian's private chat, in a turn their own message started. Find the app's id with system:read_apps",
  sideEffects: "write",
  input: z.object({ appId }),
  approval: async (input, { deps }) => {
    const id = input.appId.trim();
    const app = (await deps.apps()).find((a) => a.id === id);
    if (!app) return { title: "Publish an app", summary: notInstalled(id) };
    return {
      title: `Publish ${app.displayName} to the App Store`,
      summary: `Anyone can find and install ${app.displayName} v${app.version} from the Rome App Store.`,
    };
  },
  run: async (input, { deps }) => {
    const id = input.appId.trim();
    const outcome = await deps.publish(id);
    if (outcome.status !== "ok") return toolError(outcome.error);
    return {
      appId: outcome.appId,
      listingId: outcome.listing.id,
      version: outcome.version.version,
      published: true,
    };
  },
});

const ACCESS = ["private", "anyone_with_link", "listed_emails"] as const;
const ACCESS_MODE: Record<(typeof ACCESS)[number], AppAccessMode> = {
  private: "private",
  anyone_with_link: "public",
  listed_emails: "cloud-email",
};

export const shareApp = agentTool({
  name: "system:share_app",
  description:
    "Share an app with people besides the guardian, or stop sharing it: anyone with its link, or only visitors whose Rome Cloud emails are listed, or the guardian alone. It answers with the link to send them, or says this Rome has no public address. Use it when the guardian asks to share an app, let someone open or use it, make it public, or make it private again. Only an app with a page can be shared. The guardian approves on a card any change that lets more people open the app; narrowing who may open it needs none. Only in the guardian's private chat, in a turn their own message started. Find the app's id with system:read_apps",
  sideEffects: "write",
  input: z.object({
    appId,
    access: z
      .enum(ACCESS)
      .describe(
        "Who may open the app: the guardian alone, anyone with the link, or only the visitors whose emails are listed.",
      ),
    emails: z
      .array(z.string())
      .optional()
      .describe(
        "For listed_emails: every Rome Cloud email that may open the app. It replaces the list the app had.",
      ),
  }),
  // A card only for a change that lets someone open the app who could not
  // before. Shown to the guardian alone, so it names the app and the emails.
  approval: async (input, { deps }) => {
    const id = input.appId.trim();
    const app = (await deps.apps()).find((a) => a.id === id);
    if (!app?.canManagePublicAccess) return undefined;
    const mode = ACCESS_MODE[input.access];
    const emails = validEmails(id, mode, input.emails);
    if (!widens(app, mode, emails)) return undefined;
    return mode === "public"
      ? {
          title: `Make ${app.displayName} public`,
          summary: `Anyone with the link can open ${app.displayName} and use what it serves, without signing in.`,
        }
      : {
          title: `Share ${app.displayName}`,
          summary: `${emails.join(", ")} can open ${app.displayName} and use what it serves, after signing in with Rome Cloud.`,
        };
  },
  run: async (input, { deps }) => {
    const id = input.appId.trim();
    const app = (await deps.apps()).find((a) => a.id === id);
    if (!app) return toolError(notInstalled(id));
    if (!app.canManagePublicAccess) {
      return toolError(`${app.displayName} has no page to open, so it cannot be shared.`);
    }
    const mode = ACCESS_MODE[input.access];
    const emails = validEmails(app.id, mode, input.emails);
    if (mode === "cloud-email" && emails.length === 0) {
      return toolError(
        "Pass at least one valid Rome Cloud email in emails, or choose anyone_with_link.",
      );
    }
    deps.changeAppAccess(app.id, { mode, emails });
    const origin = deps.publicOrigin();
    // The page's share link is the standalone route, which opens without the
    // dashboard around the app. Without a public address nobody else can
    // open it, and the page offers no link either.
    const shared = mode !== "private" && app.fullHref;
    return {
      appId: app.id,
      name: app.displayName,
      access: input.access,
      ...(mode === "cloud-email" ? { emails } : {}),
      ...(shared && origin ? { link: `${origin}${app.fullHref}` } : {}),
      ...(shared && !origin
        ? {
            note: "This Rome has no public address, so there is no link to send and no one else can open the app yet. Tell the guardian.",
          }
        : {}),
    };
  },
});

/** The emails a change to listed_emails keeps, normalized as they are stored. */
function validEmails(appId: string, mode: AppAccessMode, emails: string[] | undefined): string[] {
  if (mode !== "cloud-email") return [];
  return (
    withAppAccess(DEFAULT_APP_PERMISSIONS_SETTING, appId, { mode, emails: emails ?? [] })
      .cloudEmailAccess[appId] ?? []
  );
}

/** Whether the change lets someone open the app who could not before. */
function widens(app: InstalledAppCard, mode: AppAccessMode, emails: string[]): boolean {
  if (mode === "private" || app.accessMode === "public") return false;
  if (mode === "public") return true;
  if (app.accessMode !== "cloud-email") return emails.length > 0;
  const before = new Set(app.cloudAllowedEmails);
  return emails.some((email) => !before.has(email));
}

/** The Apps page's agent tools. */
export const appTools = [readApps, searchAppStore, manageApp, publishApp, shareApp];

/** What the agent needs of one installed app: what it is, how it stands, and
 * what it may do with it. No path, source or artifact list. */
function installedForAgent(app: InstalledAppCard, updateTo: string | null) {
  return {
    appId: app.id,
    name: app.displayName,
    version: app.version,
    description: short(app.description),
    origin: app.origin,
    state: app.phase === "installed" ? app.status : app.phase,
    ...(app.error ? { error: short(app.error) } : {}),
    ...(updateTo ? { updateTo } : {}),
    hasPage: app.hasFrontend,
    access: accessName(app.accessMode),
    ...(app.accessMode === "cloud-email" ? { sharedWith: app.cloudAllowedEmails } : {}),
    canTurnOff: app.canToggle,
    canRemove: app.canUninstall,
    canPublish: app.canPublish,
  };
}

function listingForAgent(listing: AppStoreListing) {
  const installed = listing.installed?.installed ? listing.installed : null;
  return {
    listingId: listing.id,
    name: listing.name ?? listing.slug,
    description: listing.description ? short(listing.description) : null,
    latestVersion: listing.highestVersion,
    verified: listing.verified,
    installCount: listing.installCount,
    installed: installed
      ? { appId: installed.appId, version: installed.installedVersion, on: installed.enabled }
      : null,
  };
}

async function install(
  deps: AppToolDeps,
  rawListingId: string | undefined,
  rawVersion: string | undefined,
): Promise<ToolOutcome> {
  const listingId = rawListingId?.trim();
  if (!listingId) {
    return toolError(
      "Pass the App Store listing's id as listingId. Find it with system:search_app_store.",
    );
  }
  const detail = await deps.appStore.getListing({ listingId });
  const refused = storeRefusal(detail);
  if (refused) return refused;
  const requested = rawVersion?.trim() || undefined;
  const target = liveVersionToInstall(detail.body, requested);
  if (!target) {
    return toolError(
      requested
        ? `${listingId} offers no version ${requested}. Read its versions with system:search_app_store.`
        : `${listingId} has no version to install.`,
    );
  }
  const result = await installing(deps, {
    mode: "appstore",
    listingId,
    version: target.version,
    contentHash: target.contentHash,
  });
  if ("error" in result) return result.error;
  return { appId: result.appId, version: target.version, installed: true };
}

async function update(deps: AppToolDeps, app: InstalledAppCard): Promise<ToolOutcome> {
  const candidate = (await deps.updates()).upgradable.find((c) => c.appId === app.id);
  if (!candidate || candidate.currentVersion !== app.version) {
    return toolError(`${app.displayName} v${app.version} has no update waiting.`);
  }
  const result = await installing(deps, candidate.targetSource);
  if ("error" in result) return result.error;
  return {
    appId: app.id,
    name: app.displayName,
    version: candidate.availableVersion,
    updated: true,
  };
}

/** Installs `source` as the page does (`POST /api/apps`), with a failed install
 * as the error the agent reads. */
async function installing(
  deps: AppToolDeps,
  source: Parameters<AppToolDeps["manager"]["install"]>[0]["source"],
): Promise<{ appId: string } | { error: ToolOutcome }> {
  try {
    const result = await deps.manager.install({ source });
    if (result.state === "failed") {
      return {
        error: toolError(`The install failed: ${result.error?.message ?? "unknown error"}`),
      };
    }
    return { appId: result.appId };
  } catch (err) {
    if (err instanceof AppManagerError) return { error: toolError(err.message) };
    throw err;
  }
}

function removalWords(name: string, deleteData: boolean) {
  return deleteData
    ? {
        title: `Remove ${name} and delete its data`,
        summary: `Rome uninstalls ${name}. Its data is deleted permanently and cannot be recovered.`,
      }
    : {
        title: `Remove ${name}`,
        summary: `Rome uninstalls ${name}. Its data is kept for a later reinstall. The routines it manages are deleted.`,
      };
}

function storeRefusal(
  result: AppStoreServiceResult<{ available: boolean; reason?: string; error?: string }>,
): ToolOutcome | null {
  if (result.status === 404) return toolError(result.body.error ?? noListing(""));
  if (result.status >= 400) {
    return toolError(result.body.error ?? `The App Store answered HTTP ${result.status}.`);
  }
  if (!result.body.available) {
    return toolError(result.body.reason ?? "The App Store is not available on this Rome.");
  }
  return null;
}

function accessName(mode: AppAccessMode): (typeof ACCESS)[number] {
  if (mode === "public") return "anyone_with_link";
  return mode === "cloud-email" ? "listed_emails" : "private";
}

function short(text: string): string {
  return text.length > DESCRIPTION_LENGTH ? `${text.slice(0, DESCRIPTION_LENGTH - 1)}…` : text;
}

function notInstalled(appId: string): string {
  return appId
    ? `No installed app has the id "${appId}". Use system:read_apps to find the right id.`
    : "Pass the app's id as appId. Find it with system:read_apps.";
}

function noListing(listingId: string): string {
  return `The App Store has no listing "${listingId}". Search it with system:search_app_store.`;
}
