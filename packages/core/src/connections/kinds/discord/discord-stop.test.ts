import { describe, expect, it } from "@rstest/core";
import { discordInboundText, normalizeDiscordMessageText } from "./discord.js";

describe("Discord message text", () => {
  it("removes the bot mention before command recognition", () => {
    expect(normalizeDiscordMessageText("  <@123> /stop  ", "123")).toBe("/stop");
    expect(normalizeDiscordMessageText("<@!123> /STOP", "123")).toBe("/STOP");
  });

  it("shows every user mention as the name a person sees, Rome's own included", () => {
    const names: Record<string, string> = { "123": "Rome", "456": "Grace" };
    const nameOf = (id: string) => names[id];
    expect(discordInboundText("<@123>", nameOf)).toBe("@Rome");
    expect(discordInboundText(" <@!123> ", nameOf)).toBe("@Rome");
    expect(discordInboundText("<@123> please review", nameOf)).toBe("@Rome please review");
    expect(discordInboundText("<@456> and <@123>, lunch?", nameOf)).toBe(
      "@Grace and @Rome, lunch?",
    );
  });

  it("keeps a mention whose name the message does not carry as typed", () => {
    expect(discordInboundText("<@789> hi", () => undefined)).toBe("<@789> hi");
    expect(discordInboundText("", () => undefined)).toBe("");
  });

  it("reads a /stop after mentions alone as /stop, whoever is mentioned", () => {
    expect(discordInboundText("<@123> /stop", () => "Rome")).toBe("/stop");
    expect(discordInboundText("<@123> <@456> /STOP", () => "Rome")).toBe("/stop");
    expect(discordInboundText("/stop", () => undefined)).toBe("/stop");
  });

  it("reads an account code after mentions alone as the bare code", () => {
    expect(discordInboundText("<@123> ROME-7KQ2M9-XAB3CD", () => "Rome")).toBe(
      "ROME-7KQ2M9-XAB3CD",
    );
    expect(discordInboundText("<@123> `ROME-7KQ2M9-XAB3CD`", () => "Rome")).toBe(
      "`ROME-7KQ2M9-XAB3CD`",
    );
    expect(discordInboundText("<@123> ROME-7KQ2M9-XAB3CD please", () => "Rome")).toBe(
      "@Rome ROME-7KQ2M9-XAB3CD please",
    );
  });
});
