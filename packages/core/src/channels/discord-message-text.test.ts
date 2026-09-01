import { describe, expect, it } from "vitest";
import { normalizeDiscordMessageText } from "./discord.js";

const bot = { id: "123", displayName: "Rome" };

describe("normalizeDiscordMessageText", () => {
  it("preserves a bot-only mention as the visible bot name", () => {
    expect(normalizeDiscordMessageText("<@123>", bot, true)).toBe("@Rome");
    expect(normalizeDiscordMessageText("<@!123>", bot, true)).toBe("@Rome");
  });

  it("strips the bot mention when addressed prose remains", () => {
    expect(normalizeDiscordMessageText("<@123> please review", bot, true)).toBe("please review");
  });

  it("does not invent a mention for unrelated empty content", () => {
    expect(normalizeDiscordMessageText("", bot, false)).toBe("");
  });
});
