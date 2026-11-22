// The dashboard's routes for Rome's own Discord bot: the servers and Discord
// accounts bound to this Rome, the link that adds the bot to another server,
// and removing a server. Each asks the Discord gateway Worker live.

import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../../../lib/mutation-origin.js";
import { type DiscordAppCloud, DiscordAppRefused } from "../worker.js";

export interface DiscordAppRoutesDeps {
  cloud: DiscordAppCloud;
  /** A Discord account's name as People knows it. */
  nameOf: (userId: string) => Promise<string | undefined>;
}

function refusal(error: unknown) {
  if (error instanceof DiscordAppRefused) {
    return { body: { error: error.message, code: error.code }, status: 502 as const };
  }
  return {
    body: { error: error instanceof Error ? error.message : String(error), code: "failed" },
    status: 502 as const,
  };
}

export function discordAppRoutes(deps: DiscordAppRoutesDeps): Hono {
  const app = new Hono();
  const base = "/connections/discord-app";

  app.get(`${base}/servers`, async (c) => {
    try {
      const [{ servers, users }, live] = await Promise.all([
        deps.cloud.bindings(),
        // Names and icons as Discord shows them now; without them the list
        // still shows, with the names the Worker stored.
        deps.cloud
          .servers()
          .catch(() => []),
      ]);
      const looks = new Map(live.map((server) => [server.id, server]));
      // A Discord account's name as People knows it; the Worker keeps only ids.
      const named = await Promise.all(
        users.map(async (user) => {
          const name = await deps.nameOf(user.userId).catch(() => undefined);
          return { ...user, ...(name ? { name } : {}) };
        }),
      );
      return c.json({
        servers: servers.map((server) => {
          const look = looks.get(server.serverId);
          return {
            ...server,
            serverName: look?.name || server.serverName,
            serverIcon: look?.icon ?? null,
          };
        }),
        users: named,
      });
    } catch (error) {
      const { body, status } = refusal(error);
      return c.json(body, status);
    }
  });

  app.post(`${base}/install-link`, async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    try {
      return c.json({ url: await deps.cloud.installUrl() });
    } catch (error) {
      const { body, status } = refusal(error);
      return c.json(body, status);
    }
  });

  app.delete(`${base}/servers/:serverId`, async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const serverId = c.req.param("serverId");
    if (!/^\d{1,20}$/.test(serverId)) return c.json({ error: "Unknown server." }, 400);
    try {
      return c.json(await deps.cloud.removeServer(serverId));
    } catch (error) {
      const { body, status } = refusal(error);
      return c.json(body, status);
    }
  });

  return app;
}
