import { CATALOG, type CatalogEntry } from "../../catalog.js";

export { CATALOG, type CatalogEntry };

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

/** What an owner sees for a connection: a friendly app, never the raw slug. */
export interface ConnectionView {
  slug: string;
  name: string;
  scope: string;
  glyph: string | undefined;
  needsAttention: boolean;
  /** Carried from the catalog: this provider is brokered by Rome, so it renders
      as a Rome-managed card (manage in Settings) rather than a Composio one. */
  romeManaged: boolean;
}

function isActive(account: ConnectedAccount): boolean {
  return account.status.toUpperCase() === "ACTIVE";
}

/**
 * Collapse connected accounts into one card per app (toolkit). Composio can
 * return several accounts for the same toolkit — a stale/expired one alongside
 * a fresh ACTIVE one, or two workspaces of the same provider — but the owner
 * thinks in apps ("is Slack connected?"), not in individual account rows, so
 * each toolkit must surface exactly once. An app needs attention only when
 * *none* of its accounts is ACTIVE; a single live account means Rome can reach
 * it. Order follows first appearance so the list is stable across refreshes.
 */
export function buildConnectionViews(accounts: ConnectedAccount[]): ConnectionView[] {
  const byToolkit = new Map<string, ConnectedAccount[]>();
  for (const account of accounts) {
    const key = account.toolkitSlug.toLowerCase();
    const group = byToolkit.get(key);
    if (group) group.push(account);
    else byToolkit.set(key, [account]);
  }

  return [...byToolkit.values()].map((group) => {
    const reachable = group.some(isActive);
    const representative = group.find(isActive) ?? group[0];
    const entry = CATALOG_BY_SLUG.get(representative.toolkitSlug.toLowerCase());
    return {
      slug: representative.toolkitSlug,
      name: entry?.name ?? titleCase(representative.toolkitSlug),
      scope: entry?.scope ?? "Connected to Rome.",
      glyph: entry?.glyph,
      needsAttention: !reachable,
      romeManaged: entry?.romeManaged ?? false,
    };
  });
}

/** The catalog apps brokered by Rome's own integration (Rome Cloud OAuth). The
    connector renders these as managed cards and never offers a Composio connect
    for them. */
export const ROME_MANAGED_CATALOG: CatalogEntry[] = CATALOG.filter((e) => e.romeManaged);

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
 * The Rome-managed catalog slugs whose registry connection is working. Core's
 * registry is the system of record for these providers; the Composio account
 * list says nothing about them (a Rome-managed Shopify connection has no
 * Composio account, and a leftover Composio one doesn't make it connected).
 */
export function connectedRomeManagedSlugs(
  connections: readonly RegistryConnectionStatus[] | undefined,
): Set<string> {
  const managed = new Set(ROME_MANAGED_CATALOG.map((e) => e.slug.toLowerCase()));
  return new Set(
    (connections ?? [])
      .filter((c) => romeManagedConnectionWorking(c))
      .map((c) => (c.connectionKind ?? c.service ?? "").toLowerCase())
      .filter((kind) => managed.has(kind)),
  );
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
