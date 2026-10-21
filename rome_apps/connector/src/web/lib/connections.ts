import { SUPPORTED_CONNECTORS } from "@rome-os/app-runtime";

/** A connected account as returned by the `connectors` API. */
export interface ConnectedAccount {
  id: string;
  toolkitSlug: string;
  status: string;
}

/** A third-party app Rome can work in on the owner's behalf. Keyed by Composio
    toolkit slug, but the slug never reaches the owner — only `name`/`scope`. */
export interface CatalogEntry {
  slug: string;
  name: string;
  scope: string;
  glyph: string;
  /** Brokered by Rome's own integration (Rome Cloud OAuth), not Composio's connect
      flow. The connector never offers a Composio "Connect" for these — it routes
      the owner to Settings → Connections, and a connection bridged from the Rome
      token surfaces here as "Connected via Rome". Keeps a single integration per
      provider no matter which entry point the owner starts from. */
  romeManaged?: boolean;
}

/** Per-toolkit UI fields the shared catalog doesn't carry. Keyed by the SDK's
    `SUPPORTED_CONNECTORS` slugs so the *set* of connectable toolkits has one
    source of truth: a toolkit added to the SDK without a presentation entry here
    fails the drift guard in `shared.test.ts`, and the slug → name mapping comes
    from the SDK, not a second hand-maintained list. */
interface CatalogPresentation {
  scope: string;
  glyph: string;
  romeManaged?: boolean;
}

const CATALOG_PRESENTATION: Record<string, CatalogPresentation> = {
  gmail: { scope: "Reads and sends your email.", glyph: "gmail" },
  outlook: { scope: "Reads and sends your email.", glyph: "outlook" },
  googlecalendar: { scope: "Reads your schedule and books time.", glyph: "calendar" },
  github: {
    scope: "Powers git, the shell, and GitHub tools for your agents.",
    glyph: "github",
    romeManaged: true,
  },
  slack: { scope: "Reads and posts messages.", glyph: "slack", romeManaged: true },
  notion: { scope: "Reads and writes your pages.", glyph: "notion" },
  googledrive: { scope: "Finds and manages your files.", glyph: "drive" },
  googlesheets: { scope: "Reads and updates your spreadsheets.", glyph: "sheets" },
  googledocs: { scope: "Reads and writes your documents.", glyph: "docs" },
  googleslides: { scope: "Creates and updates your presentations.", glyph: "slides" },
  googleads: { scope: "Manages campaigns, audiences, and reporting.", glyph: "googleads" },
  dropbox: { scope: "Finds and manages your files.", glyph: "dropbox" },
  linear: { scope: "Tracks issues and projects.", glyph: "linear" },
  discord: { scope: "Reads and posts messages.", glyph: "discord" },
  linkedin: { scope: "Reads your network and shares posts.", glyph: "linkedin" },
  metaads: { scope: "Manages Meta ad campaigns and insights.", glyph: "metaads" },
  supabase: { scope: "Manages projects, databases, auth, storage, and SQL.", glyph: "supabase" },
  neon: { scope: "Manages Postgres projects, branches, databases, and roles.", glyph: "neon" },
  hubspot: { scope: "Tracks your contacts and deals.", glyph: "hubspot" },
  stripe: { scope: "Looks up payments and customers.", glyph: "stripe" },
  shopify: {
    scope: "Updates your store's products and inventory, and reads orders.",
    glyph: "shopify",
    romeManaged: true,
  },
  otter_ai_mcp: { scope: "Searches your meetings and reads their transcripts.", glyph: "otter" },
};

export const CATALOG: CatalogEntry[] = SUPPORTED_CONNECTORS.map((connector) => {
  const presentation = CATALOG_PRESENTATION[connector.toolkit];
  if (!presentation) {
    throw new Error(`connector catalog: no presentation entry for toolkit "${connector.toolkit}"`);
  }
  return {
    slug: connector.toolkit,
    name: connector.displayName,
    scope: presentation.scope,
    glyph: presentation.glyph,
    ...(presentation.romeManaged ? { romeManaged: true } : {}),
  };
});

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

/**
 * Whether a Rome-managed connection's grants can serve the agent, which is what
 * the inline connect card waits for. Only an authorized grant counts: a degraded
 * one is still on file (the dashboard lists it) but its token no longer works,
 * so the card must keep offering the reconnect instead of reporting success.
 */
export function romeManagedGrantsUsable(grants: Record<string, string> | undefined): boolean {
  return Object.values(grants ?? {}).some((state) => state === "authorized");
}

/** A connection as core's registry reports it (`/api/connections`). */
export interface RegistryConnectionStatus {
  service: string;
  grants: Record<string, string>;
}

/**
 * The Rome-managed catalog slugs whose registry grants are usable. Core's
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
      .filter((c) => managed.has(c.service.toLowerCase()) && romeManagedGrantsUsable(c.grants))
      .map((c) => c.service.toLowerCase()),
  );
}

/**
 * Whether a connect link is a page of Rome's own dashboard (Shopify's Settings
 * card) rather than an OAuth start. A dashboard page needs the guardian's Rome
 * session, so it opens in the current window: the desktop app hands a new
 * window to the system browser, which isn't signed in to Rome.
 */
export function isRomeSettingsLink(url: string): boolean {
  return url.startsWith("/settings/");
}
