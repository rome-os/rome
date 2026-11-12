import { eq } from "drizzle-orm";
import type { AppAccessMode } from "@rome/api-types/apps";
import type { DrizzleDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import type { Permission, Permissions } from "../access/permissions.js";
import { normalizeVisitorEmail } from "../access/visitor-email.js";
import type { AppCatalog } from "./catalog.js";
import { isValidAppId } from "./packaging/app-id.js";
import { isResolvedApp } from "./state.js";

/**
 * Who besides the guardian may open each app, as the guardian set it on the
 * app page. It is both the stored setting and the `/api/public-access` body.
 */
export interface AppPermissionsSetting {
  /** Apps anyone with the link may open. */
  allowedApps: string[];
  /** The visitor emails that may open each app. */
  cloudEmailAccess: Record<string, string[]>;
}

export const APP_PERMISSIONS_SETTING_KEY = "publicAccess";

export const DEFAULT_APP_PERMISSIONS_SETTING: AppPermissionsSetting = {
  allowedApps: [],
  cloudEmailAccess: {},
};

function normalizeEmailList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(raw.map(normalizeVisitorEmail).filter((email): email is string => email !== null)),
  ).sort();
}

export function normalizeAppPermissionsSetting(raw: unknown): AppPermissionsSetting {
  const body = (raw ?? {}) as {
    allowedApps?: unknown;
    cloudEmailAccess?: unknown;
  };

  const allowedApps = Array.isArray(body.allowedApps)
    ? Array.from(
        new Set(
          body.allowedApps
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim())
            .filter(isValidAppId),
        ),
      )
    : [];

  const cloudEmailAccess: Record<string, string[]> = {};
  if (body.cloudEmailAccess && typeof body.cloudEmailAccess === "object") {
    for (const [rawAppId, rawEmails] of Object.entries(
      body.cloudEmailAccess as Record<string, unknown>,
    )) {
      const appId = rawAppId.trim();
      if (!isValidAppId(appId)) continue;
      const emails = normalizeEmailList(rawEmails);
      if (emails.length > 0) cloudEmailAccess[appId] = emails;
    }
  }

  return {
    allowedApps,
    cloudEmailAccess,
  };
}

/** Each app's permission, keyed by app id. An app missing from the map is guardian-only. */
export function appPermissions(setting: AppPermissionsSetting): Map<string, Permission> {
  const byApp = new Map<string, Permission>();
  for (const appId of setting.allowedApps) {
    byApp.set(appId, { anyoneWithLink: true, listedEmails: new Set() });
  }
  for (const [appId, emails] of Object.entries(setting.cloudEmailAccess)) {
    byApp.set(appId, {
      anyoneWithLink: byApp.get(appId)?.anyoneWithLink ?? false,
      listedEmails: new Set(emails),
    });
  }
  return byApp;
}

/** How the app page names a permission. */
export function appAccessMode(permission: Permission): AppAccessMode {
  if (permission.anyoneWithLink) return "public";
  return permission.listedEmails.size > 0 ? "cloud-email" : "private";
}

export async function loadAppPermissionsSetting(db: DrizzleDb): Promise<AppPermissionsSetting> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, APP_PERMISSIONS_SETTING_KEY));
  return rows.length > 0 && rows[0].value
    ? normalizeAppPermissionsSetting(rows[0].value)
    : DEFAULT_APP_PERMISSIONS_SETTING;
}

/** Stores the setting and hands the apps' permissions to Access. */
export async function saveAppPermissionsSetting(
  db: DrizzleDb,
  permissions: Permissions,
  setting: AppPermissionsSetting,
): Promise<void> {
  const now = new Date();
  await db
    .insert(settings)
    .values({ key: APP_PERMISSIONS_SETTING_KEY, value: setting, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: setting, updatedAt: now },
    });
  permissions.replace(appPermissions(setting));
}

/** Who may open one app, as the app page names it. `emails` is empty unless `mode` is `cloud-email`. */
export interface AppAccess {
  mode: AppAccessMode;
  emails: string[];
}

export type AppAccessRefusal =
  | { reason: "unknown-app"; message: string }
  | { reason: "no-page"; message: string }
  | { reason: "invalid"; message: string };

export function isAppAccessRefusal(value: object): value is AppAccessRefusal {
  return "reason" in value;
}

/** What an app needs for its access to be set: it is installed and has a page. */
export interface ShareableApps {
  /** Whether the installed app has a page, or null when no such app is installed. */
  hasPage(appId: string): boolean | null;
}

/** Reads installed apps and their pages from the catalog. */
export function shareableApps(catalog: Pick<AppCatalog, "get">): ShareableApps {
  return {
    hasPage(appId) {
      const view = catalog.get(appId);
      if (!view) return null;
      return isResolvedApp(view) && !!view.web;
    },
  };
}

const APP_ACCESS_MODES: readonly AppAccessMode[] = ["private", "public", "cloud-email"];

export function appAccessOf(setting: AppPermissionsSetting, appId: string): AppAccess {
  const permission = appPermissions(setting).get(appId);
  if (!permission) return { mode: "private", emails: [] };
  const mode = appAccessMode(permission);
  return { mode, emails: mode === "cloud-email" ? [...permission.listedEmails] : [] };
}

/**
 * Checks a requested access, normalizing its emails. Refuses an unknown mode,
 * an email that is not one, and `cloud-email` with no email.
 */
export function parseAppAccess(raw: {
  mode?: unknown;
  emails?: unknown;
}): AppAccess | AppAccessRefusal {
  const mode = raw.mode;
  if (typeof mode !== "string" || !APP_ACCESS_MODES.includes(mode as AppAccessMode)) {
    return { reason: "invalid", message: `mode must be one of ${APP_ACCESS_MODES.join(", ")}.` };
  }
  if (mode !== "cloud-email") return { mode: mode as AppAccessMode, emails: [] };
  const given = Array.isArray(raw.emails) ? raw.emails : [];
  const invalid = given.filter((email) => normalizeVisitorEmail(email) === null);
  if (invalid.length > 0) {
    return { reason: "invalid", message: `Not an email: ${invalid.map(String).join(", ")}.` };
  }
  const emails = normalizeEmailList(given);
  if (emails.length === 0) {
    return { reason: "invalid", message: "cloud-email needs at least one email." };
  }
  return { mode: "cloud-email", emails };
}

/** Whether `after` lets in anyone `before` did not. */
export function widensAppAccess(before: AppAccess, after: AppAccess): boolean {
  if (after.mode === "public") return before.mode !== "public";
  if (after.mode === "private" || before.mode === "public") return false;
  const allowed = new Set(before.emails);
  return after.emails.some((email) => !allowed.has(email));
}

/** Refuses an app that is not installed or has no page. */
export function checkShareable(apps: ShareableApps, appId: string): AppAccessRefusal | null {
  const hasPage = apps.hasPage(appId);
  if (hasPage === null) return { reason: "unknown-app", message: `No installed app "${appId}".` };
  if (!hasPage) {
    return { reason: "no-page", message: `App "${appId}" has no page, so it cannot be shared.` };
  }
  return null;
}

/**
 * Sets who may open one app and leaves every other app's access as it was.
 * Hands the new permissions to Access before it resolves. Returns the access
 * before and after the change.
 */
export async function setAppAccess(
  deps: { db: DrizzleDb; permissions: Permissions; apps: ShareableApps },
  appId: string,
  access: AppAccess,
): Promise<{ before: AppAccess; after: AppAccess } | AppAccessRefusal> {
  const refusal = checkShareable(deps.apps, appId);
  if (refusal) return refusal;
  const setting = await loadAppPermissionsSetting(deps.db);
  const allowedApps = setting.allowedApps.filter((id) => id !== appId);
  const { [appId]: _dropped, ...cloudEmailAccess } = setting.cloudEmailAccess;
  if (access.mode === "public") allowedApps.push(appId);
  if (access.mode === "cloud-email") cloudEmailAccess[appId] = access.emails;
  const next = { allowedApps: allowedApps.sort(), cloudEmailAccess };
  await saveAppPermissionsSetting(deps.db, deps.permissions, next);
  return { before: appAccessOf(setting, appId), after: appAccessOf(next, appId) };
}

/** Loads the stored setting into Access at startup. */
export async function loadAppPermissions(db: DrizzleDb, permissions: Permissions): Promise<void> {
  permissions.replace(appPermissions(await loadAppPermissionsSetting(db)));
}
