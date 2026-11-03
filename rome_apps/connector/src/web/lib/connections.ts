import { CATALOG } from "../../catalog.js";

export { CATALOG };

/** A connected account as returned by the `connectors` API. */
export interface ConnectedAccount {
  id: string;
  toolkitSlug: string;
  status: string;
}

export const CATALOG_BY_SLUG = new Map(CATALOG.map((e) => [e.slug, e]));

export function titleCase(slug: string): string {
  return slug
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A connection as core's registry reports it (`/api/connections`). */
export interface RegistryConnectionStatus {
  connectionKind?: string;
  /** The kind of connection, as a host from before the rename names it. */
  service?: string;
  /** Working or broken, or null with no access. A host from before connection
   *  states omits it. */
  state?: "working" | "broken" | null;
  /** Per-grant states, which a host from before connection states sends alone. */
  grants?: Record<string, string>;
}

/**
 * Whether a Rome-managed connection can serve the agent, which is what the
 * inline connect card waits for. Only a working connection counts: a broken one
 * is still on file (the dashboard lists it) but its token no longer works, so
 * the card must keep offering the reconnect instead of reporting success.
 */
export function romeManagedConnectionWorking(
  connection: RegistryConnectionStatus | null | undefined,
): boolean {
  if (!connection) return false;
  if (connection.state !== undefined) return connection.state === "working";
  return Object.values(connection.grants ?? {}).some((state) => state === "authorized");
}

/**
 * Whether a connect link is a page of Rome's own dashboard rather than an OAuth
 * start or a provider's own page. A host that links Shopify to its Settings
 * card sends one. A dashboard page needs the guardian's Rome session, so it
 * opens in the current window: the desktop app hands a new window to the
 * system browser, which isn't signed in to Rome.
 */
export function isRomeSettingsLink(url: string): boolean {
  return url.startsWith("/settings/");
}
