// Connection management HTTP surface. Messaging model: docs/concepts/messaging.md.
//
// One list for everything the ConnectionRegistry holds — channels and OAuth
// integrations alike — the sole feed for the dashboard's Connections surface.
// Registered services with no connection row yet appear as offerable
// placeholders (`id: null`) so a fresh install still renders the full catalog.
// The projection speaks registry vocabulary (GrantState / CapabilityStatus)
// verbatim; identity only ever crosses through the descriptor's `reviveProfile`
// hook, so no service-owned profile field name is known here. No POST — minting
// stays in the connect setup.

import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { isEnabledOAuthProvider, isOAuthProvider } from "../../lib/oauth-providers.js";
import { createRomeCloudOAuthStartUrl } from "../../lib/rome-cloud-oauth.js";
import { removeProviderAccount } from "../../lib/provider-accounts.js";
import type { ConnectionRegistry } from "../../connections/index.js";
import type { GrantRecord } from "../../connections/ledger.js";
import type { DrizzleTx } from "../../db/index.js";
import type {
  Capability,
  CapabilityStatus,
  Connection,
  ConnectionDescriptor,
  GrantName,
  GrantState,
} from "../../connections/types.js";
import type { SetupManager } from "../../connections/setup/manager.js";
import type { ApiDeps } from "../deps.js";
import { requireConnectionRegistry } from "../helpers.js";

/** Per-grant active-setup ids for a connection.
 *  `idOrService` is the connection id for a real connection, or the service name
 *  for an offerable placeholder (the same key the setup route addresses).
 *  Empty when no manager is wired or no setup is live. */
function activeSetups(
  manager: SetupManager | null,
  idOrService: string,
  grantNames: string[],
): Record<GrantName, string> {
  const out: Record<GrantName, string> = {};
  if (!manager) return out;
  for (const name of grantNames) {
    const cid = manager.activeFor(idOrService, name);
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

/** Where the guardian goes to (re-)confer this connection's grants. Resolved
 *  server-side for Rome Cloud-brokered OAuth services; null for services whose
 *  connect setup is dashboard-local (channels). */
interface ConnectHint {
  url: string | null;
  available: boolean;
  unavailableReason: string | null;
}

interface ConnectionView {
  /** Ledger connection id, or null for an offerable placeholder — a registered
   *  service the guardian has never connected (nothing to address or tear down
   *  yet; the connect setup mints the row). */
  id: string | null;
  service: string;
  label: string;
  grants: Record<GrantName, GrantState>;
  /** One entry per declared grant: the revived display, or null when the grant
   *  has no stored profile or the descriptor exposes no projection. */
  display: Record<GrantName, GrantDisplayView | null>;
  capabilities: Record<Capability, CapabilityStatus>;
  connect: ConnectHint | null;
  /** Active-setup discovery: per grant, the id of the live conferral
   *  setup (if any), so a reopened dashboard re-attaches to it instead of
   *  starting a fresh one. Empty when no setup is in progress. */
  setups: Record<GrantName, string>;
}

/** Per-grant extras for the detail view — ledger envelope fields the list
 *  doesn't carry, normalized to ISO strings (no raw DB values). */
interface GrantDetailView {
  conferredAt: string | null;
  lastRenewedAt: string | null;
  degraded: { at: string; reason: string } | null;
  tokenExpiresAt: string | null;
}

function connectHint(service: string): ConnectHint | null {
  if (!isOAuthProvider(service)) return null;
  const link = createRomeCloudOAuthStartUrl(service);
  return {
    url: link.connectUrl,
    available: link.available,
    unavailableReason: link.unavailableReason,
  };
}

/** One ledger read per connection; both view builders below project from it. */
async function loadGrantRecords(
  registry: ConnectionRegistry,
  conn: Connection,
): Promise<Map<GrantName, GrantRecord>> {
  const records = await registry.getLedger().listGrants(conn.id);
  return new Map(records.map((rec) => [rec.name, rec]));
}

function buildConnectionView(
  registry: ConnectionRegistry,
  conn: Connection,
  records: Map<GrantName, GrantRecord>,
  manager: SetupManager | null,
): ConnectionView {
  const revive = registry.getDescriptor(conn.service)?.reviveProfile;
  const grants = conn.auth.grants();

  const display: Record<GrantName, GrantDisplayView | null> = {};
  for (const name of Object.keys(grants)) {
    const profile = records.get(name)?.profile;
    const revived = profile && revive ? revive(name, profile) : undefined;
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
    service: conn.service,
    label: conn.label,
    grants,
    display,
    capabilities: conn.status(),
    connect: connectHint(conn.service),
    setups: activeSetups(manager, conn.id, Object.keys(grants)),
  };
}

function buildGrantDetails(
  conn: Connection,
  records: Map<GrantName, GrantRecord>,
): Record<GrantName, GrantDetailView> {
  const details: Record<GrantName, GrantDetailView> = {};
  for (const name of Object.keys(conn.auth.grants())) {
    const rec = records.get(name);
    const expiresAt = rec?.credential?.expiresAt;
    details[name] = {
      conferredAt: rec?.conferredAt?.toISOString() ?? null,
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
): Promise<ConnectionView> {
  return buildConnectionView(registry, conn, await loadGrantRecords(registry, conn), manager);
}

/** An offerable placeholder: a registered service with no connection row yet.
 *  Mirrors exactly what a freshly minted connection would project — every grant
 *  unauthorized, every declared capability needs-auth (zero-need capabilities
 *  unlock at birth) — without writing a row: minting stays in the connect
 *  setup. */
function placeholderView(
  service: string,
  descriptor: ConnectionDescriptor,
  manager: SetupManager | null,
): ConnectionView {
  const grantNames = Object.keys(descriptor.auth);
  const grants: Record<GrantName, GrantState> = {};
  const display: Record<GrantName, GrantDisplayView | null> = {};
  for (const name of grantNames) {
    grants[name] = "unauthorized";
    display[name] = null;
  }

  const capStatus = (kind: "talker" | "actor" | "watcher"): CapabilityStatus => {
    const cap = descriptor.capabilities[kind];
    if (!cap) return { state: "unsupported" };
    if (cap.needs.length > 0) return { state: "needs-auth", missingGrants: [...cap.needs] };
    if (kind === "watcher" && descriptor.capabilities.watcher?.subscriptionGated) {
      return { state: "needs-subscription" };
    }
    return { state: "unlocked" };
  };

  return {
    id: null,
    service,
    label: service,
    grants,
    display,
    capabilities: {
      talk: capStatus("talker"),
      act: capStatus("actor"),
      watch: capStatus("watcher"),
    },
    connect: connectHint(service),
    setups: activeSetups(manager, service, grantNames),
  };
}

/** The offerable catalog: every registered service with no connection row.
 *  OAuth-brokered services only appear when the host actually offers them
 *  (env-enabled) — their descriptors register unconditionally so an existing
 *  account's state imports regardless, but a placeholder is a connect
 *  invitation. */
function placeholderViews(
  registry: ConnectionRegistry,
  manager: SetupManager | null,
): ConnectionView[] {
  return registry
    .registeredServices()
    .filter((service) => registry.find(service).length === 0)
    .filter((service) => !isOAuthProvider(service) || isEnabledOAuthProvider(service))
    .map((service) => {
      const descriptor = registry.getDescriptor(service);
      return descriptor ? placeholderView(service, descriptor, manager) : null;
    })
    .filter((view): view is ConnectionView => view !== null);
}

export function connectionsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  const findConnection = (registry: ConnectionRegistry, id: string): Connection | undefined =>
    registry.all().find((c) => c.id === id);

  app.get("/connections", async (c) => {
    const registry = requireConnectionRegistry(deps);
    const manager = deps.setupManager ?? null;
    const connected = await Promise.all(
      registry.all().map((conn) => serializeConnection(registry, conn, manager)),
    );
    // Stable ordering for the UI: by service, then label, then id — the
    // registry's own iteration order is insertion-dependent. Placeholders sort
    // like a connection whose label is its service name and whose id is empty.
    const connections = [...connected, ...placeholderViews(registry, manager)].sort(
      (a, b) =>
        a.service.localeCompare(b.service) ||
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
    const records = await loadGrantRecords(registry, conn);
    c.header("Cache-Control", "no-store");
    return c.json({
      connection: {
        ...buildConnectionView(registry, conn, records, deps.setupManager ?? null),
        grantDetails: buildGrantDetails(conn, records),
      },
    });
  });

  /** Transitional: the boot reconciler re-imports a retained legacy
   *  `provider_accounts` row over an unauthorized grant, so a teardown that
   *  only touches the ledger would resurrect it on the next boot. Tearing
   *  down an OAuth provider must also drop its legacy row until that table
   *  is retired. */
  const removeLegacyProviderRow = async (service: string): Promise<void> => {
    if (isOAuthProvider(service)) await removeProviderAccount(deps.db, service);
  };

  /** Enlist pairing and mapping cleanup in connection deletion or Talk-grant
   *  revocation. Unrelated grants have no cleanup participant. */
  const guardianMappingTeardown = (
    registry: ConnectionRegistry,
    conn: Connection,
    grant?: string,
  ): ((tx: DrizzleTx) => void) | undefined => {
    const talker = registry.getDescriptor(conn.service)?.capabilities.talker;
    if (!talker || (grant !== undefined && !talker.needs.includes(grant))) return undefined;
    return (tx) => {
      deps.approvalsRepo.supersedePairings(conn.id, tx);
      deps.personMappingRepo.writeDeleteGuardianChannelMappings(tx, conn.service);
    };
  };

  app.delete("/connections/:id/grants/:name", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const registry = requireConnectionRegistry(deps);
    const conn = findConnection(registry, c.req.param("id"));
    if (!conn) return c.json({ error: "Unknown connection." }, 404);
    const name = c.req.param("name");
    if (!(name in conn.auth.grants())) return c.json({ error: "Unknown grant." }, 404);

    // Serialize teardown with any in-flight setup on this grant. First
    // cancel a live setup OUTSIDE the section so it cannot re-import the
    // credential after we revoke (a setup waiting at its guardian-link unwinds
    // with no write; one already committing runs to `done` first, then our
    // revoke below wins as the final state). Then run the revoke INSIDE the same
    // per-(service, grant) critical section the setup's terminal write uses, so
    // the two can never interleave.
    await deps.setupManager?.cancelActive(conn.id, name);
    await registry.withGrantSection(conn.service, name, async () => {
      await removeLegacyProviderRow(conn.service);
      await registry.revoke(conn.id, name, { inTx: guardianMappingTeardown(registry, conn, name) });
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      connection: await serializeConnection(registry, conn, deps.setupManager ?? null),
    });
  });

  app.delete("/connections/:id", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const registry = requireConnectionRegistry(deps);
    const conn = findConnection(registry, c.req.param("id"));
    if (!conn) return c.json({ error: "Unknown connection." }, 404);
    await removeLegacyProviderRow(conn.service);
    await registry.remove(conn.id, { inTx: guardianMappingTeardown(registry, conn) });
    return c.json({ ok: true });
  });

  return app;
}
