// The one projection of Rome's connections, which `GET /connections` serves
// and the Concierge's connectors build on. Vocabulary: docs/domains/connections.md.
//
// One list for everything the ConnectionRegistry holds — channels and OAuth
// integrations alike. Registered connection kinds with no connection row yet
// appear as offerable placeholders (`id: null`) so a fresh install still
// renders the full catalog. The projection speaks registry vocabulary
// (ConnectionState / CapabilityStatus) verbatim; identity only ever crosses
// through the descriptor's `reviveProfile` hook, so no kind-specific profile
// field name is known here.

import type { AccountValue, ConnectionAccountFields } from "@rome/api-types/connected-accounts";
import { isEnabledOAuthProvider, isOAuthProvider } from "./oauth/oauth-providers.js";
import { createRomeCloudOAuthStartUrl } from "./oauth/rome-cloud-oauth.js";
import type { ConnectionRegistry } from "./index.js";
import type { GrantValue } from "./grant.js";
import { reachedAccount } from "./connection.js";
import type {
  Capability,
  CapabilityStatus,
  Connection,
  ConnectionDescriptor,
  ConnectionState,
  GrantName,
  GrantState,
} from "./types.js";
import type { SetupManager } from "./setup/manager.js";
import type { DrizzleDb } from "../db/index.js";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../db/repositories/connected-accounts.js";
import { accountLinkOf } from "../chats/connected-accounts/account-links.js";

/** What a connection lets Rome do, by capability. `talk` repeats `chat` under
 *  its old name for dashboard tabs opened before the rename. */
export type WireCapabilities = Record<Capability, CapabilityStatus> & {
  /** @deprecated Read `chat`. */
  talk: CapabilityStatus;
};

function wireCapabilities(status: Record<Capability, CapabilityStatus>): WireCapabilities {
  return { ...status, talk: status.chat };
}

/** Per-grant active-setup ids for a connection.
 *  `idOrKind` is the connection id for a real connection, or the connection kind
 *  for an offerable placeholder (the same key the setup route addresses).
 *  Empty when no manager is wired or no setup is live. */
function activeSetups(
  manager: SetupManager | null,
  idOrKind: string,
  grantNames: string[],
): Record<GrantName, string> {
  const out: Record<GrantName, string> = {};
  if (!manager) return out;
  for (const name of grantNames) {
    const cid = manager.activeFor(idOrKind, name);
    if (cid) out[name] = cid;
  }
  return out;
}

/** The generic identity view of one grant — reviveProfile's ProfileDisplay
 *  normalized to nulls at the boundary. */
interface GrantDisplayView {
  displayName: string | null;
  handle: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/** Where the guardian goes to (re-)grant this connection's grants. Resolved
 *  server-side for Rome Cloud-brokered OAuth connection kinds; null for connection kinds whose
 *  connect setup is dashboard-local (channels). */
export interface ConnectHint {
  url: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface ConnectionView
  extends Required<
      Pick<ConnectionAccountFields, "channel" | "platform" | "account" | "link" | "severalAccounts">
    >,
    Pick<ConnectionAccountFields, "agent" | "accountUnknown"> {
  /** Ledger connection id, or null for an offerable placeholder — a registered
   *  connection kind the guardian has never connected (nothing to address or tear down
   *  yet; the connect setup mints the row). */
  id: string | null;
  /** The kind of connection, such as `telegram_user`. */
  connectionKind: string;
  /** @deprecated The kind of connection under its old name, which apps built
   *  before the rename read. */
  service: string;
  label: string;
  /** The kind's display name ("GitHub"), where `label` is the kind id until
   *  someone renames the connection. */
  kindLabel: string;
  /** Working or broken. Null for a placeholder, and for a connection a
   *  disconnect kept with no access. */
  state: ConnectionState | null;
  /** @deprecated Per-grant states, which apps built before `state` read. */
  grants: Record<GrantName, GrantState>;
  /** One entry per declared grant: the revived display, or null when the grant
   *  has no stored profile or the descriptor exposes no projection. */
  display: Record<GrantName, GrantDisplayView | null>;
  capabilities: WireCapabilities;
  connect: ConnectHint | null;
  /** Active-setup discovery: per grant, the id of the live grant
   *  setup (if any), so a reopened dashboard re-attaches to it instead of
   *  starting a fresh one. Empty when no setup is in progress. */
  setups: Record<GrantName, string>;
}

/** Per-grant extras for the detail view — grant envelope fields the list
 *  doesn't carry, normalized to ISO strings (no raw DB values). */
interface GrantDetailView {
  grantedAt: string | null;
  lastRenewedAt: string | null;
  degraded: { at: string; reason: string } | null;
  tokenExpiresAt: string | null;
}

function connectHint(connectionKind: string, state: ConnectionState | null): ConnectHint | null {
  if (!isOAuthProvider(connectionKind)) return null;
  // A broken connection is repaired, not started over: the link says so.
  const link = createRomeCloudOAuthStartUrl(connectionKind, { reconnect: state === "broken" });
  return {
    url: link.connectUrl,
    available: link.available,
    unavailableReason: link.unavailableReason,
  };
}

/** One grant read per connection; both view builders below project from it. */
export async function loadGrant(
  registry: ConnectionRegistry,
  conn: Connection,
): Promise<GrantValue | null> {
  return registry.grantOf(conn.id);
}

/** The account `record`'s grant reaches, as the wire names it. */
function accountView(
  descriptor: ConnectionDescriptor | null,
  record: GrantValue | null,
): AccountValue | null {
  const account = descriptor && record ? reachedAccount(descriptor, record) : undefined;
  return account ? { platform: account.platform, id: account.accountId } : null;
}

export function buildConnectionView(
  registry: ConnectionRegistry,
  conn: Connection,
  record: GrantValue | null,
  manager: SetupManager | null,
  channel: { id: string; platformAccountId: string | null } | null,
  agent: string | null,
): ConnectionView {
  const revive = registry.getDescriptor(conn.connectionKind)?.reviveProfile;
  const link = registry.getDescriptor(conn.connectionKind)?.link ?? null;
  const account = accountView(registry.getDescriptor(conn.connectionKind), record);
  const grants = conn.auth.grants();

  const display: Record<GrantName, GrantDisplayView | null> = {};
  for (const name of Object.keys(grants)) {
    const profile = record?.profile;
    const revived = profile && revive ? revive(profile) : undefined;
    display[name] = revived
      ? {
          displayName: revived.displayName ?? null,
          handle: revived.handle ?? null,
          email: revived.email ?? null,
          avatarUrl: revived.avatarUrl ?? null,
        }
      : null;
  }

  return {
    id: conn.id,
    connectionKind: conn.connectionKind,
    service: conn.connectionKind,
    label: conn.label,
    kindLabel: registry.getDescriptor(conn.connectionKind)?.label ?? conn.connectionKind,
    state: conn.state(),
    grants,
    display,
    capabilities: wireCapabilities(conn.status()),
    connect: connectHint(conn.connectionKind, conn.state()),
    setups: activeSetups(manager, conn.id, Object.keys(grants)),
    channel: channel?.id ?? null,
    platform: account?.platform ?? null,
    account,
    ...(channel ? { accountUnknown: channel.platformAccountId === null } : {}),
    // Null means silent, so a connection kind that takes no link reports none.
    agent: link === null ? undefined : agent,
    link,
    severalAccounts: registry.getDescriptor(conn.connectionKind)?.severalAccounts === true,
  };
}

export function buildGrantDetails(
  conn: Connection,
  rec: GrantValue | null,
): Record<GrantName, GrantDetailView> {
  const details: Record<GrantName, GrantDetailView> = {};
  for (const name of Object.keys(conn.auth.grants())) {
    const expiresAt = rec?.credential?.expiresAt;
    details[name] = {
      grantedAt: rec?.grantedAt?.toISOString() ?? null,
      lastRenewedAt: rec?.lastRenewedAt?.toISOString() ?? null,
      degraded: rec?.degraded
        ? { at: rec.degraded.at.toISOString(), reason: rec.degraded.reason }
        : null,
      tokenExpiresAt: expiresAt && expiresAt !== "never" ? expiresAt.toISOString() : null,
    };
  }
  return details;
}

async function serializeConnection(
  registry: ConnectionRegistry,
  conn: Connection,
  manager: SetupManager | null,
  channels: ChannelRecordsRepository,
  accounts: ConnectedAccountsRepository,
): Promise<ConnectionView> {
  return buildConnectionView(
    registry,
    conn,
    await loadGrant(registry, conn),
    manager,
    channels.byConnection(conn.id) ?? null,
    accounts.agentOf(conn.id),
  );
}

/** An offerable placeholder: a registered connection kind with no connection row yet.
 *  Mirrors exactly what a freshly minted connection would project — its grant
 *  unauthorized, every declared capability needs-auth — without writing a row:
 *  minting stays in the connect setup. */
function placeholderView(
  connectionKind: string,
  descriptor: ConnectionDescriptor,
  manager: SetupManager | null,
): ConnectionView {
  const grants: Record<GrantName, GrantState> = { [descriptor.grant]: "unauthorized" };
  const display: Record<GrantName, GrantDisplayView | null> = { [descriptor.grant]: null };

  const capStatus = (kind: "talker" | "actor" | "watcher"): CapabilityStatus => {
    const cap = descriptor.capabilities[kind];
    if (!cap) return { state: "unsupported" };
    return { state: "needs-auth", missingGrants: [descriptor.grant] };
  };

  return {
    id: null,
    connectionKind,
    service: connectionKind,
    label: connectionKind,
    kindLabel: descriptor.label ?? connectionKind,
    state: null,
    grants,
    display,
    capabilities: wireCapabilities({
      chat: capStatus("talker"),
      act: capStatus("actor"),
      watch: capStatus("watcher"),
    }),
    connect: connectHint(connectionKind, null),
    setups: activeSetups(manager, connectionKind, [descriptor.grant]),
    channel: null,
    platform: null,
    account: null,
    link: descriptor.link ?? null,
    severalAccounts: descriptor.severalAccounts === true,
  };
}

/** The offerable catalog: every registered connection kind with no connection row.
 *  OAuth-brokered connection kinds only appear when the host actually offers them
 *  (env-enabled) — their descriptors register unconditionally so an existing
 *  account's state imports regardless, but a placeholder is a connect
 *  invitation. */
function placeholderViews(
  registry: ConnectionRegistry,
  manager: SetupManager | null,
): ConnectionView[] {
  return registry
    .registeredKinds()
    .filter((connectionKind) => registry.find(connectionKind).length === 0)
    .filter(
      (connectionKind) =>
        !isOAuthProvider(connectionKind) || isEnabledOAuthProvider(connectionKind),
    )
    .map((connectionKind) => {
      const descriptor = registry.getDescriptor(connectionKind);
      return descriptor ? placeholderView(connectionKind, descriptor, manager) : null;
    })
    .filter((view): view is ConnectionView => view !== null);
}

/**
 * Every connection and every offerable placeholder, as `GET /connections`
 * serves them: the one projection of Rome's connections. Other surfaces (the
 * Concierge's connectors) build on this rather than reading connection state
 * on their own. `?platform=&accountId=` finds the connection that reaches an
 * account, so it lists no placeholders.
 */
export async function listConnectionViews(
  deps: { connectionRegistry?: ConnectionRegistry; setupManager?: SetupManager; db: DrizzleDb },
  filter: { platform?: string; accountId?: string } = {},
): Promise<ConnectionView[]> {
  const registry = deps.connectionRegistry;
  if (!registry) throw new Error("connectionRegistry is not wired");
  const manager = deps.setupManager ?? null;
  const channels = new ChannelRecordsRepository(deps.db, accountLinkOf(deps.connectionRegistry));
  const accounts = new ConnectedAccountsRepository(deps.db);
  const { platform, accountId } = filter;
  const connected = (
    await Promise.all(
      registry
        .all()
        .map((conn) => serializeConnection(registry, conn, manager, channels, accounts)),
    )
  ).filter(
    (view) =>
      (platform === undefined || view.account?.platform === platform) &&
      (accountId === undefined || view.account?.id === accountId),
  );
  const placeholders = platform === undefined ? placeholderViews(registry, manager) : [];
  // Stable ordering for the UI: by connection kind, then label, then id — the
  // registry's own iteration order is insertion-dependent. Placeholders sort
  // like a connection whose label is its connection kind and whose id is empty.
  return [...connected, ...placeholders].sort(
    (a, b) =>
      a.connectionKind.localeCompare(b.connectionKind) ||
      a.label.localeCompare(b.label) ||
      (a.id ?? "").localeCompare(b.id ?? ""),
  );
}
