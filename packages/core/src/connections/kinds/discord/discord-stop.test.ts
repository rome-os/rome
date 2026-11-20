import { describe, expect, it, rs } from "@rstest/core";
import type { ChatStopHandler, ChatId } from "@rome-os/app-runtime";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  buildDiscordSlashCommands,
  DiscordAdapter,
  discordInboundText,
  normalizeDiscordMessageText,
} from "./discord.js";

describe("Discord stop command", () => {
  it("registers /stop as a native command", () => {
    expect(buildDiscordSlashCommands()).toContainEqual(
      expect.objectContaining({
        name: "stop",
        description: "Stop the active Rome response in this conversation",
      }),
    );
  });

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

  it("reads a link code after mentions alone as the bare code, so admission voids it", () => {
    expect(discordInboundText("<@123> ROME-7KQ2M9XA", () => "Rome")).toBe("ROME-7KQ2M9XA");
    expect(discordInboundText("<@123> ROME-7KQ2M9XA please", () => "Rome")).toBe(
      "@Rome ROME-7KQ2M9XA please",
    );
  });

  it("routes native /stop through chat control before the guardian-only config gate", async () => {
    const stop = rs.fn(async () => ({ status: "stop_requested" as const, turnId: "turn-1" }));
    const chatStop: ChatStopHandler = stop;
    const resolveDiscordPerson = rs.fn(async () => null);
    const adapter = new DiscordAdapter({
      botToken: "token",
      connectionId: "connection:discord",
      chatStop,
      resolveDiscordPerson,
    });
    const deferReply = rs.fn(async () => undefined);
    const editReply = rs.fn(async () => undefined);
    const interaction = {
      commandName: "stop",
      channelId: "channel-1" as ChatId,
      user: { id: "user-1" },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;

    await (
      adapter as unknown as {
        handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void>;
      }
    ).handleSlashCommand(interaction);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(stop).toHaveBeenCalledWith({
      ref: { connectionId: "connection:discord", chatId: "channel-1" },
      service: "discord",
      senderId: "user-1",
    });
    expect(editReply).toHaveBeenCalledWith({ content: "Stopped." });
    expect(resolveDiscordPerson).not.toHaveBeenCalled();
  });
});
