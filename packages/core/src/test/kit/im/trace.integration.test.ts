import { afterEach, describe, expect, it } from "@rstest/core";
import {
  configureImApiTrace,
  type ImApiTraceEvent,
} from "../../../channels/diagnostics/api-trace.js";
import { createTracedTelegramBot } from "../../../channels/telegram.js";
import { DiscordApiFixture, DISCORD_DM, DISCORD_TOKEN } from "./discord.js";
import { LarkApiFixture, LARK_CHAT } from "./lark.js";
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";
import { DefaultRestOptions } from "discord.js";
import { traceDiscordRequest } from "../../../channels/diagnostics/discord-trace.js";

afterEach(() => configureImApiTrace([]));

describe("IM API recording through SDK transports", () => {
  it("observes the default Discord undici response without requiring clone", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["discord"], (event) => events.push(event));
    const fixture = await new DiscordApiFixture().start();
    try {
      const response = await traceDiscordRequest(DefaultRestOptions.makeRequest)(
        `${fixture.server.url}/api/v10/users/@me`,
        { method: "GET", headers: { authorization: `Bot ${DISCORD_TOKEN}` } },
      );
      expect("clone" in response).toBe(false);
      expect(await response.json()).toMatchObject({ bot: true });
      expect(events.map((event) => event.phase)).toEqual(["request", "response", "response-body"]);
      fixture.server.assertClean();
    } finally {
      await fixture.close();
    }
  });
  it("records Discord physical requests and consumed bodies, including 429 retries", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["discord"], (event) => events.push(event));
    const fixture = await new DiscordApiFixture().start();
    const adapter = fixture.createAdapter();
    try {
      await adapter.start();
      fixture.server.once({
        method: "POST",
        path: `/api/v10/channels/${DISCORD_DM}/messages`,
        response: {
          status: 429,
          body: { retry_after: 0.01, global: false },
          headers: { "retry-after": "0.01", "x-ratelimit-reset-after": "0.01" },
        },
      });
      const receipt = await adapter.sendMessage(DISCORD_DM, DISCORD_DM, { text: "recorded reply" });
      expect(fixture.messages.get(receipt.messageId!)?.content).toBe("recorded reply");
      expect(
        events.some(
          (event) =>
            event.phase === "response" && (event.detail as { status?: number }).status === 429,
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.phase === "response-body" &&
            JSON.stringify(event.detail).includes(receipt.messageId!),
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain(DISCORD_TOKEN);
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
      await fixture.close();
    }
  });

  it("records Lark token and message API shapes with credentials redacted", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["lark"], (event) => events.push(event));
    const fixture = await new LarkApiFixture().start();
    const adapter = fixture.createAdapter({ domain: "lark" });
    try {
      await adapter.start();
      await adapter.sendMessage(LARK_CHAT, LARK_CHAT, { text: "recorded Lark" });
      expect(
        events.some(
          (event) =>
            event.phase === "response" && JSON.stringify(event.detail).includes("message_id"),
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain(fixture.appSecret);
      expect(JSON.stringify(events)).not.toContain("fixture-tenant-token");
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
      await fixture.close();
    }
  });

  it("records Telegram API payloads without changing grammy results", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["telegram"], (event) => events.push(event));
    const fixture = await new TelegramApiFixture().start();
    const bot = createTracedTelegramBot(TELEGRAM_TOKEN, fixture.createBot);
    try {
      const result = await bot.api.sendMessage(1001, "recorded Telegram");
      expect(result.text).toBe("recorded Telegram");
      expect(JSON.stringify(events)).toContain("sendMessage");
      expect(JSON.stringify(events)).toContain(String(result.message_id));
      expect(JSON.stringify(events)).not.toContain(TELEGRAM_TOKEN);
      fixture.server.assertClean();
    } finally {
      await fixture.close();
    }
  });
});
