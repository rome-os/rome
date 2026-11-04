// The connectors this app offers a follower such as the Concierge: each one's
// connection (and how a client starts connecting it), whether Rome can act
// through it, and, for a watchable one, its watch catalog and whether it can
// be watched now, with what is missing.

import { CATALOG } from "../catalog.js";
import { type Watchable, WATCHABLES } from "./catalog.js";

export type WatchStatus = "ready" | "not_connected" | "no_relay" | "error";
export type ConnectionStatus = "connected" | "not_connected" | "expired";

/** How a client starts connecting a connector: one HTTP call that answers `{ redirectUrl }`. */
export type ConnectEntry =
  | { kind: "rome_oauth"; method: "POST"; path: string }
  | {
      kind: "composio";
      method: "POST";
      path: string;
      body: { provider: string };
      /** Sign in to Composio first, with `login`, when Rome is not signed in. */
      needsLogin: boolean;
      login: { method: "POST"; path: string };
    }
  | { kind: "settings"; path: string };

export interface WatchSection {
  status: WatchStatus;
  /** What is missing and how to fix it, when the status is not ready. */
  statusReason?: string;
  /** Who events are judged for: the GitHub login, the mailbox address. */
  account?: string;
  target: Watchable["target"];
  kinds: Watchable["kinds"];
  options: Watchable["options"];
}

export interface ConnectorEntry {
  id: string;
  label: string;
  glyph: string;
  connection: {
    status: ConnectionStatus;
    reason?: string;
    connect?: ConnectEntry;
  };
  /** Rome can act through it, by delegating to a task chat: it is connected. */
  act: boolean;
  /** Null when the connector cannot be watched. */
  watch: WatchSection | null;
}

/** What the statuses read, injected so tests need no token, relay or Composio. */
export interface WatchSourceDeps {
  githubToken(): Promise<string | null>;
  relayDepositUrl(): Promise<string | null>;
  githubLogin(token: string): Promise<string>;
  /** False when Rome is not signed in to Composio. */
  composioSignedIn(): Promise<boolean>;
  /** Composio connections by toolkit slug, with Composio's status. */
  composioAccounts(): Promise<{ toolkit: string; status: string }[]>;
  /** The connected Gmail account's address. */
  gmailAddress(): Promise<string>;
  /** Whether a Rome-managed toolkit (GitHub, Slack, Shopify) holds a token. */
  romeManagedConnected(toolkit: string): Promise<boolean>;
}

export const NO_RELAY_REASON =
  "This Rome has no relay mailbox, so outside events cannot reach it. Connect it to Rome Cloud, or fix Relay health in Settings.";

const COMPOSIO_LOGIN = { method: "POST" as const, path: "/api/apps/connector/login/start" };
/** Rome-managed toolkits whose OAuth starts from Rome's own route; Shopify starts from Shopify. */
const ROME_OAUTH = new Set(["github", "slack"]);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function connectEntry(slug: string, romeManaged: boolean, signedIn: boolean): ConnectEntry {
  if (romeManaged) {
    return ROME_OAUTH.has(slug)
      ? { kind: "rome_oauth", method: "POST", path: `/api/oauth/${slug}/start` }
      : { kind: "settings", path: "/settings" };
  }
  return {
    kind: "composio",
    method: "POST",
    path: "/api/apps/connector/connectors",
    body: { provider: slug },
    needsLogin: !signedIn,
    login: COMPOSIO_LOGIN,
  };
}

async function watchSection(
  deps: WatchSourceDeps,
  watchable: Watchable,
  connected: boolean,
): Promise<WatchSection> {
  const base = { target: watchable.target, kinds: watchable.kinds, options: watchable.options };
  if (!connected) {
    return {
      ...base,
      status: "not_connected",
      statusReason: `${watchable.label} is not connected. Connect it in Settings → Connections.`,
    };
  }
  if (!(await deps.relayDepositUrl())) {
    return { ...base, status: "no_relay", statusReason: NO_RELAY_REASON };
  }
  try {
    const account =
      watchable.source === "github"
        ? await deps.githubLogin((await deps.githubToken()) ?? "")
        : await deps.gmailAddress();
    return { ...base, status: "ready", account };
  } catch (error) {
    return {
      ...base,
      status: "error",
      statusReason: `${watchable.label} did not say which account is connected: ${message(error)}`,
    };
  }
}

/**
 * Every connector this app offers, in catalog order with the watchable ones
 * first: its connection, whether Rome can act through it, and its watch
 * section when it can be watched.
 */
export async function listConnectors(deps: WatchSourceDeps): Promise<ConnectorEntry[]> {
  const signedIn = await deps.composioSignedIn().catch(() => false);
  const accounts = signedIn ? await deps.composioAccounts().catch(() => []) : [];
  const watchable = new Map(WATCHABLES.map((w) => [w.source, w]));
  const ordered = [
    ...CATALOG.filter((entry) => watchable.has(entry.slug)),
    ...CATALOG.filter((entry) => !watchable.has(entry.slug)),
  ];
  const out: ConnectorEntry[] = [];
  for (const entry of ordered) {
    const romeManaged = entry.romeManaged === true;
    let status: ConnectionStatus = "not_connected";
    if (romeManaged) {
      if (await deps.romeManagedConnected(entry.slug).catch(() => false)) status = "connected";
    } else {
      const states = accounts.filter((a) => a.toolkit === entry.slug).map((a) => a.status);
      if (states.includes("ACTIVE")) status = "connected";
      else if (states.includes("EXPIRED")) status = "expired";
    }
    const connected = status === "connected";
    const watch = watchable.get(entry.slug);
    out.push({
      id: entry.slug,
      label: entry.name,
      glyph: entry.glyph,
      connection: {
        status,
        ...(connected
          ? {}
          : {
              reason:
                status === "expired"
                  ? `${entry.name}'s access expired. Connect it again.`
                  : `${entry.name} is not connected.`,
              connect: connectEntry(entry.slug, romeManaged, signedIn),
            }),
      },
      act: connected,
      watch: watch ? await watchSection(deps, watch, connected) : null,
    });
  }
  return out;
}
