import { expect, it } from "@rstest/core";
import { FakeTelegramApi } from "./fake-telegram.js";

it("preserves the chat and message identity across edits without consuming a new message ID", async () => {
  const fake = new FakeTelegramApi();
  const bot = fake.createBot("fixture-token");
  const first = await bot.api.sendMessage(123, "preview");
  const edited = await bot.api.editMessageText(123, first.message_id, "final");
  expect(edited).toMatchObject({ message_id: first.message_id, chat: { id: 123 } });
  const next = await bot.api.sendMessage(123, "next");
  expect(next.message_id).toBe(first.message_id + 1);
  expect(fake.sent.map((call) => call.method)).toEqual([
    "sendMessage",
    "editMessageText",
    "sendMessage",
  ]);
});
