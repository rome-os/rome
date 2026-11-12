// Connection management HTTP surface. Vocabulary: docs/domains/connections.md.
// What it lists is the projection in connections/views.ts. Minting stays in
// the connect setup, a later account of a connection kind included.

import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ConnectionRegistry } from "../../connections/index.js";
import type { Connection } from "../../connections/types.js";
import {
  buildConnectionView,
  buildGrantDetails,
  listConnectionViews,
  loadGrant,
} from "../../connections/views.js";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import { accountLinkOf } from "../../chats/connected-accounts/account-links.js";
import type { ApiDeps } from "../deps.js";
import { requireConnectionRegistry } from "../helpers.js";

export function connectionsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  const findConnection = (registry: ConnectionRegistry, id: string): Connection | undefined =>
    registry.all().find((c) => c.id === id);
  const channels = new ChannelRecordsRepository(deps.db, accountLinkOf(deps.connectionRegistry));
  const accounts = new ConnectedAccountsRepository(deps.db);

  // `?platform=&accountId=` finds the connection that reaches an account, so
  // it lists no placeholders. An account id means nothing without its platform.
  app.get("/connections", async (c) => {
    const platform = c.req.query("platform");
    const accountId = c.req.query("accountId");
    if (accountId !== undefined && platform === undefined) {
      return c.json({ error: "Name the platform an account id is on." }, 400);
    }
    const connections = await listConnectionViews(deps, { platform, accountId });
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
          channels.byConnection(conn.id) ?? null,
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
    const settled = await deps.setupManager?.cancelActive(conn.id, name);
    // A fix that was committing when the cancel landed may have reached
    // another account: it ended this connection and started one to that
    // account. The guardian asked to take away the access they were fixing,
    // so the disconnect ends the connection the fix started.
    const target =
      settled?.status === "done" && settled.grant.ended === conn.id
        ? settled.grant.connectionId
        : conn.id;
    if (target && findConnection(registry, target)) await registry.disconnect(target);
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
