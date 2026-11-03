import { getInstanceToken } from "../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";

/**
 * Adds this instance's token to a Store read (browse, listing detail, bundle)
 * so Rome Cloud can show the account's invite-only listings. Public listings
 * don't need it, and Rome Cloud treats a missing or stale token as anonymous.
 *
 * The token goes only to the configured Rome Cloud origin, never to a URL a
 * caller or test resolver pointed somewhere else.
 */
export function withRomeCloudReadAuth(
  url: URL,
  headers: Record<string, string>,
): Record<string, string> {
  const token = getInstanceToken();
  const cloudOrigin = getRomeCloudOrigin();
  if (!token || !cloudOrigin || url.origin !== cloudOrigin) return headers;
  return { ...headers, authorization: `Bearer ${token}` };
}
