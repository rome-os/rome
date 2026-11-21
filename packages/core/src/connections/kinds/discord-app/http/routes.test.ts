import { describe, expect, it } from "@rstest/core";
import type { DiscordAppCloud } from "../worker.js";
import { DiscordAppRefused } from "../worker.js";
import { discordAppRoutes } from "./routes.js";

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

function app(over: Partial<DiscordAppCloud> = {}) {
  const cloud = {
    bindings: async () => ({
      servers: [{ serverId: "5", serverName: "Lab", createdAt: 1 }],
      users: [{ userId: "7", createdAt: 2 }],
    }),
    installUrl: async () => "https://discord.com/oauth2/authorize",
    removeServer: async () => ({ removed: true, left: false }),
    ...over,
  } as DiscordAppCloud;
  return discordAppRoutes({
    cloud,
    nameOf: async (userId) => (userId === "7" ? "Ray" : undefined),
  });
}

describe("the dashboard's routes for Rome's Discord bot", () => {
  it("lists the servers and the guardian's accounts by their People names", async () => {
    const response = await app().request("/connections/discord-app/servers");
    expect(await response.json()).toEqual({
      servers: [{ serverId: "5", serverName: "Lab", createdAt: 1 }],
      users: [{ userId: "7", createdAt: 2, name: "Ray" }],
    });
  });

  it("hands out the link that adds the bot, and removes a server", async () => {
    const link = await app().request("/connections/discord-app/install-link", {
      method: "POST",
      headers: SAME_ORIGIN,
    });
    expect(await link.json()).toEqual({ url: "https://discord.com/oauth2/authorize" });
    const removed = await app().request("/connections/discord-app/servers/5", {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(await removed.json()).toEqual({ removed: true, left: false });
    const bad = await app().request("/connections/discord-app/servers/x", {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(bad.status).toBe(400);
  });

  it("refuses a cross-site change, and passes a refusal on in the guardian's words", async () => {
    const crossSite = await app().request("/connections/discord-app/install-link", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
    const down = await app({
      bindings: async () => {
        throw new DiscordAppRefused(
          "discord_unavailable",
          "Discord is unavailable right now.",
          503,
        );
      },
    }).request("/connections/discord-app/servers");
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: "Discord is unavailable right now." });
  });
});
