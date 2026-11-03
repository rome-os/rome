import { isValidAppId } from "../apps/packaging/app-id.js";

export interface PublicAccessConfig {
  enableAccessControl: boolean;
  allowedApps: string[];
  cloudEmailAccess: Record<string, string[]>;
}

export const PUBLIC_ACCESS_SETTING_KEY = "publicAccess";

export const DEFAULT_PUBLIC_ACCESS_CONFIG: PublicAccessConfig = {
  enableAccessControl: false,
  allowedApps: [],
  cloudEmailAccess: {},
};

const SAFE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizePublicAccessEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!SAFE_EMAIL_RE.test(normalized)) return null;
  return normalized;
}

function normalizeEmailList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(raw.map(normalizePublicAccessEmail).filter((email): email is string => email !== null)),
  ).sort();
}

export function normalizePublicAccessConfig(raw: unknown): PublicAccessConfig {
  const body = (raw ?? {}) as {
    enableAccessControl?: unknown;
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
    enableAccessControl: body.enableAccessControl === true,
    allowedApps,
    cloudEmailAccess,
  };
}
