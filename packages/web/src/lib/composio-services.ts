import { fetchJson } from "@/lib/fetch-json";

// The services Rome reaches through Composio. The Connector app owns them: its
// API lists the catalog, the guardian's connected accounts and the trigger
// webhook, and runs connect and disconnect. Settings › Connections only shows
// them and calls these routes.
const CONNECTOR_API = "/api/apps/connector";

/** One service in the Connector's catalog. */
export interface ComposioCatalogEntry {
  slug: string;
  name: string;
  /** What the service lets Rome do, in one line. */
  scope: string;
  glyph: string;
  /** Rome connects this service itself (GitHub, Slack, Shopify). Settings
   *  lists it as Rome's own connection, never as a Composio one. */
  romeManaged?: boolean;
}

/** One connected Composio account. Several can share a toolkit. */
export interface ComposioAccount {
  id: string;
  toolkitSlug: string;
  status: string;
}

export interface ComposioWebhookStatus {
  webhookRegistered: boolean;
  relayConfigured: boolean;
}

/** A Composio service as one row: connected services carry whether they need
 *  attention, available ones do not. */
export interface ComposioServiceRow extends ComposioCatalogEntry {
  needsAttention: boolean;
}

export const COMPOSIO_CATALOG_QUERY_KEY = ["composio", "catalog"] as const;
export const COMPOSIO_ACCOUNTS_QUERY_KEY = ["composio", "accounts"] as const;
export const COMPOSIO_STATUS_QUERY_KEY = ["composio", "status"] as const;

export async function fetchComposioCatalog(): Promise<ComposioCatalogEntry[]> {
  const body = await fetchJson<{ items: ComposioCatalogEntry[] }>(`${CONNECTOR_API}/catalog`, {
    fallback: "Couldn't load the Composio services.",
  });
  return body.items;
}

export async function fetchComposioAccounts(): Promise<ComposioAccount[]> {
  const body = await fetchJson<{ items: ComposioAccount[] }>(`${CONNECTOR_API}/connectors`, {
    fallback: "Couldn't load your Composio connections.",
  });
  return body.items;
}

export async function fetchComposioWebhookStatus(): Promise<ComposioWebhookStatus> {
  return await fetchJson<ComposioWebhookStatus>(`${CONNECTOR_API}/status`, {
    fallback: "Couldn't check the Composio webhook.",
  });
}

/** Starts a Composio OAuth for one service. Returns the page to authorize on,
 *  or `alreadyConnected` when Composio already holds a live connection. */
export async function startComposioConnect(
  slug: string,
): Promise<{ authorizationUrl?: string; alreadyConnected?: boolean }> {
  return await fetchJson(`${CONNECTOR_API}/connectors`, {
    method: "POST",
    json: { provider: slug },
    fallback: "Couldn't start the connection. Try again.",
  });
}

export async function disconnectComposioService(slug: string): Promise<void> {
  await fetchJson(`${CONNECTOR_API}/connectors/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    fallback: "Couldn't disconnect. Try again.",
  });
}

export async function registerComposioWebhook(): Promise<void> {
  await fetchJson(`${CONNECTOR_API}/webhook/register`, {
    method: "POST",
    fallback: "Couldn't register the webhook. Try again.",
  });
}

/**
 * Splits the catalog into connected and available rows. Accounts collapse to
 * one row per service, since the guardian thinks in services, not accounts. A
 * service needs attention only when none of its accounts is ACTIVE: one live
 * account means Rome can reach it. A connected service missing from the
 * catalog still shows, under its slug, so it can be disconnected.
 *
 * Rome-managed services are left out on both sides. Core bridges Rome's own
 * GitHub (and Slack, Shopify) connection into Composio, and that bridged
 * account is not the guardian's to manage here.
 */
export function composioServiceRows(
  fullCatalog: ComposioCatalogEntry[],
  accounts: ComposioAccount[],
): { connected: ComposioServiceRow[]; available: ComposioServiceRow[] } {
  const romeManaged = new Set(
    fullCatalog.filter((entry) => entry.romeManaged).map((entry) => entry.slug),
  );
  const catalog = fullCatalog.filter((entry) => !entry.romeManaged);
  const active = new Map<string, boolean>();
  for (const account of accounts) {
    const slug = account.toolkitSlug.toLowerCase();
    if (romeManaged.has(slug)) continue;
    active.set(slug, (active.get(slug) ?? false) || account.status.toUpperCase() === "ACTIVE");
  }
  const known = new Set(catalog.map((entry) => entry.slug));
  const unknown: ComposioServiceRow[] = [...active.keys()]
    .filter((slug) => !known.has(slug))
    .map((slug) => ({ slug, name: slug, scope: "", glyph: "", needsAttention: !active.get(slug) }));
  return {
    connected: [
      ...catalog
        .filter((entry) => active.has(entry.slug))
        .map((entry) => ({ ...entry, needsAttention: !active.get(entry.slug) })),
      ...unknown,
    ],
    available: catalog
      .filter((entry) => !active.has(entry.slug))
      .map((entry) => ({ ...entry, needsAttention: false })),
  };
}
