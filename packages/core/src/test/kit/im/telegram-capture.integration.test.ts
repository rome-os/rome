import { describe, expect, it } from "@rstest/core";
import capture from "./telegram-text.capture.json" with { type: "json" };
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";

function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (key === "date" || key === "edit_date") {
        expect(Number.isInteger(item)).toBe(true);
        expect(item).toBeGreaterThan(0);
        return 1700000000;
      }
      if (key === "chat") return { id: item.id, type: item.type };
      return item;
    }),
  );
}

describe("Telegram text capture", () => {
  it.each(["replay", "model"])("matches real private-chat exchanges through %s", async (mode) => {
    const fixture = await new TelegramApiFixture().start();
    const bot = fixture.createBot(TELEGRAM_TOKEN);
    try {
      for (const exchange of capture.exchanges) {
        const path = `/bot${TELEGRAM_TOKEN}/${exchange.method}`;
        if (mode === "replay")
          fixture.server.once({
            method: "POST",
            path,
            response: { status: exchange.status, body: exchange.response },
          });
        const body = exchange.body;
        const invoke = () =>
          exchange.method === "sendMessage"
            ? bot.api.sendMessage(body.chat_id, body.text, {
                reply_parameters: body.reply_parameters,
              })
            : bot.api.editMessageText(body.chat_id, body.message_id!, body.text);
        if (exchange.response.ok) {
          const result = await invoke();
          if (mode === "replay") expect(result).toEqual(exchange.response.result);
          else expect(normalize(result)).toEqual(normalize(exchange.response.result));
        } else {
          await expect(invoke()).rejects.toMatchObject({
            error_code: exchange.response.error_code,
            description: exchange.response.description,
          });
        }
        expect(fixture.server.calls.at(-1)).toMatchObject({
          path: `/bot[redacted]/${exchange.method}`,
          body,
          status: exchange.status,
        });
      }
      fixture.server.assertClean();
    } finally {
      await fixture.close();
    }
  });
});
