import { describe, expect, it } from "@rstest/core";
import capture from "./discord-text.capture.json" with { type: "json" };
import { DiscordApiFixture, DISCORD_DM, DISCORD_TOKEN } from "./discord.js";

function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if ((key === "timestamp" || key === "edited_timestamp") && item !== null) {
        expect(Number.isFinite(Date.parse(item))).toBe(true);
        return "2023-11-14T22:13:20.000Z";
      }
      if (key === "author") return { id: item.id, bot: item.bot };
      return item;
    }),
  );
}

describe("Discord text capture", () => {
  it.each(["replay", "model"])("matches real message exchanges through %s", async (mode) => {
    const fixture = await new DiscordApiFixture().start();
    fixture.channels.set(DISCORD_DM, { id: DISCORD_DM, type: 0, guild_id: "100000000000000102" });
    const rest = fixture.transport().createRest!({ version: "10" }).setToken(DISCORD_TOKEN);
    try {
      for (const exchange of capture.exchanges) {
        const path = `/api/v10${exchange.path}`;
        if (mode === "replay") {
          fixture.server.once({
            method: exchange.method,
            path,
            response: { status: exchange.status ?? 200, body: exchange.response },
          });
        }
        const invoke = () =>
          rest.request({
            method: exchange.method as Parameters<typeof rest.request>[0]["method"],
            fullRoute: exchange.path as `/${string}`,
            ...(exchange.method === "GET" ? {} : { body: exchange.body }),
          });
        if (exchange.status) {
          await expect(invoke()).rejects.toMatchObject({
            status: exchange.status,
            rawError: exchange.response,
          });
        } else {
          const response = await invoke();
          if (mode === "replay") expect(response).toEqual(exchange.response);
          else expect(normalize(response)).toEqual(normalize(exchange.response));
        }
        expect(fixture.server.calls.at(-1)).toMatchObject({ path, body: exchange.body });
      }
      fixture.server.assertClean();
    } finally {
      await fixture.close();
    }
  });
});
