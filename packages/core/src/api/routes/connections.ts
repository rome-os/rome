// Connection management HTTP surface. Vocabulary: docs/domains/connections.md.
//
// One list for everything the ConnectionRegistry holds — channels and OAuth
// integrations alike — the sole feed for the dashboard's Connections surface.
// Registered connection kinds with no connection row yet appear as offerable
// placeholders (`id: null`) so a fresh install still renders the full catalog.
// The projection speaks registry vocabulary (ConnectionState / CapabilityStatus)
// verbatim; identity only ever crosses through the descriptor's `reviveProfile`
// hook, so no kind-specific profile field name is known here. Minting stays in
// the connect setup, a later account of a connection kind included.

import type { AccountValue, ConnectionAccountFields } from "@rome/api-types/connected-accounts";
import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { isEnabledOAuthProvider, isOAuthProvider } from "../../lib/oauth-providers.js";
import { createRomeCloudOAuthStartUrl } from "../../lib/rome-cloud-oauth.js";
import type { ConnectionRegistry } from "../../connections/index.js";
import type { GrantValue } from "../../connections/grant.js";
import { reachedAccount } from "../../connections/connection.js";
import type {
  Capability,
  CapabilityStatus,
  Connection,
  ConnectionDescriptor,
  ConnectionState,
  GrantName,
  GrantState,
} from "../../connections/types.js";
import type { SetupManager } from "../../connections/setup/manager.js";
import {
  ChannelRecordsRepository,
  type ChannelRecord,
} from "../../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import { accountLinkOf } from "../../channels/account-links.js";
import type { ApiDeps } from "../deps.js";
import { requireConnectionRegistry } from "../helpers.js";

/** What a connection lets Rome do, by capability. `talk` repeats `chat` under
 *  its old name for dashboard tabs opened before the rename. */
type WireCapabilities = Record<Capability, CapabilityStatus> & {
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
interface ConnectHint {
  url: string | null;
  available: boolean;
  unavailableReason: string | null;
}

interface ConnectionView
  extends Required<
      Pick<ConnectionAccountFields, "channel" | "platform" | "account" | "link" | "severalAccounts">
    >,
    Pick<ConnectionAccountFields, "agent"> {
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

function connectHint(connectionKind: string): ConnectHint | null {
  if (!isOAuthProvider(connectionKind)) return null;
  const link = createRomeCloudOAuthStartUrl(connectionKind);
  return {
    url: link.connectUrl,
    available: link.available,
    unavailableReason: link.unavailableReason,
  };
}

/** One grant read per connection; both view builders below project from it. */
async function loadGrant(
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

function buildConnectionView(
  registry: ConnectionRegistry,
  conn: Connection,
  record: GrantValue | null,
  manager: SetupManager | null,
  channel: ChannelRecord | null,
  agent: string | null,
): ConnectionView {
  const revive = registry.getDescriptor(conn.connectionKind)?.reviveProfile;
  const link = registry.getDescriptor(conn.connectionKind)?.link ?? null;
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
    state: conn.state(),
    grants,
    display,
    capabilities: wireCapabilities(conn.status()),
    connect: connectHint(conn.connectionKind),
    setups: activeSetups(manager, conn.id, Object.keys(grants)),
    channel: channel?.id ?? null,
    platform: channel?.platform ?? null,
    account: accountView(registry.getDescriptor(conn.connectionKind), record),
    // Null means silent, so a connection kind that takes no link reports none.
    agent: link === null ? undefined : agent,
    link,
    severalAccounts: registry.getDescriptor(conn.connectionKind)?.severalAccounts === true,
  };
}

function buildGrantDetails(
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
    channels.byConnection(conn.id),
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
    state: null,
    grants,
    display,
    capabilities: wireCapabilities({
      chat: capStatus("talker"),
      act: capStatus("actor"),
      watch: capStatus("watcher"),
    }),
    connect: connectHint(connectionKind),
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

export function connectionsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  const findConnection = (registry: ConnectionRegistry, id: string): Connection | undefined =>
    registry.all().find((c) => c.id === id);
  const channels = new ChannelRecordsRepository(deps.db, accountLinkOf(deps.connectionRegistry));
  const accounts = new ConnectedAccountsRepository(deps.db);

  // `?platform=&accountId=` finds the connection that reaches an account, so
  // it lists no placeholders. An account id means nothing without its platform.
  app.get("/connections", async (c) => {
    const registry = requireConnectionRegistry(deps);
    const manager = deps.setupManager ?? null;
    const platform = c.req.query("platform");
    const accountId = c.req.query("accountId");
    if (accountId !== undefined && platform === undefined) {
      return c.json({ error: "Name the platform an account id is on." }, 400);
    }
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
    const connections = [...connected, ...placeholders].sort(
      (a, b) =>
        a.connectionKind.localeCompare(b.connectionKind) ||
        a.label.localeCompare(b.label) ||
        (a.id ?? "").localeCompare(b.id ?? ""),
    );
    c.header("Cache-Control", "no-store");
    return c.json({ connections });
  });

  app.get("/connections/:id", async (c) => {
    const registry = requireConnectionRegistry(deps);
    const conn = findConnection(registry, c.req.param("id"));
    if (!conn) return c.json({ error: "Unknown connection." }, 404);
    const record = await loadGrant(registry, conn);
    c.header("Cache-Control", "no-store");
    return c.json({
      connection: {
        ...buildConnectionView(
          registry,
          conn,
          record,
          deps.setupManager ?? null,
          channels.byConnection(conn.id),
          accounts.agentOf(conn.id),
        ),
        grantDetails: buildGrantDetails(conn, record),
      },
    });
  });

  app.delete("/connections/:id/grants/:name", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const registry = requireConnectionRegistry(deps);
    const conn = findConnection(registry, c.req.param("id"));
    if (!conn) return c.json({ error: "Unknown connection." }, 404);
    const name = c.req.param("name");
    if (!(name in conn.auth.grants())) return c.json({ error: "Unknown grant." }, 404);

    // Cancel a live setup first, OUTSIDE the grant's section, so it cannot
    // re-import the credential after the revoke (a setup waiting at its
    // guardian-link unwinds with no write; one already committing runs to
    // `done` first, then the disconnect wins as the final state). The
    // disconnect itself runs inside that section.
    await deps.setupManager?.cancelActive(conn.id, name);
    await registry.disconnect(conn.id);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, connection: null });
  });

  app.delete("/connections/:id", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const registry = requireConnectionRegistry(deps);
    const conn = findConnection(registry, c.req.param("id"));
    if (!conn) return c.json({ error: "Unknown connection." }, 404);
    await registry.remove(conn.id);
    return c.json({ ok: true });
  });

  return app;
}
