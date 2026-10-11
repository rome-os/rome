/**
 * Single source of truth for the app-id grammar.
 *
 * An app id names an installed app everywhere inside a Rome instance: the
 * manifest `id`, the lockfile key, the dashboard route param, and artifact
 * namespaces all carry it. Local apps may use an unscoped lowercase slug.
 * Store apps retain their canonical scoped listing id (`@handle/slug`) so two
 * publishers can install the same slug without collapsing onto one identity.
 *
 * A scoped id is not itself a safe filesystem or URL path segment. Every such
 * boundary must use `appIdToPathSegment`, which is injective because `%` is not
 * admitted by either app-id grammar.
 */
import { parseListingId } from "./listing-id.js";

/** Grammar for legacy/unscoped local app ids. */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
// `self` is not a reference namespace. Keep it reserved so historical
// `self:<name>` values cannot become canonical ids through a real app install.
export const RESERVED_APP_IDS = new Set(["core", "self"]);

export function isValidAppId(appId: string): boolean {
  if (APP_ID_PATTERN.test(appId)) return !RESERVED_APP_IDS.has(appId);
  const listing = parseListingId(appId);
  return listing?.scoped === true;
}

export function assertValidAppId(appId: string): void {
  if (!isValidAppId(appId)) {
    throw new Error(
      `Invalid app id ${JSON.stringify(appId)}. Use an unscoped lowercase slug or a scoped App Store id such as "@handle/slug"; "core" and "self" are reserved.`,
    );
  }
}

/** Encode an app id for use as exactly one filesystem or URL path segment. */
export function appIdToPathSegment(appId: string): string {
  assertValidAppId(appId);
  return encodeURIComponent(appId);
}
