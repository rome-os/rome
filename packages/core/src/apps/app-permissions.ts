import { eq } from "drizzle-orm";
import type { AppAccessMode } from "@rome/api-types/apps";
import type { DrizzleDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import type { Permission, Permissions } from "../access/permissions.js";
import { normalizeVisitorEmail } from "../access/visitor-email.js";
import { isValidAppId } from "./packaging/app-id.js";

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

/** Loads the stored setting into Access at startup. */
export async function loadAppPermissions(db: DrizzleDb, permissions: Permissions): Promise<void> {
  permissions.replace(appPermissions(await loadAppPermissionsSetting(db)));
}
