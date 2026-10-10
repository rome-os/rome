import { describe, expect, it, rs } from "@rstest/core";
import type { ChatStopHandler, ConversationId } from "@rome-os/app-runtime";
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

  it("preserves a mention-only message as the visible bot name", () => {
    const bot = { id: "123", displayName: "Rome" };
    expect(discordInboundText("<@123>", bot)).toBe("@Rome");
    expect(discordInboundText(" <@!123> ", bot)).toBe("@Rome");
    expect(discordInboundText("<@123> please review", bot)).toBe("please review");
  });

  it("does not invent a mention for empty content without a typed bot mention", () => {
    // A reply that pings the bot carries no <@id> token in its content.
    expect(discordInboundText("", { id: "123", displayName: "Rome" })).toBe("");
    expect(discordInboundText("<@456>", { id: "123", displayName: "Rome" })).toBe("<@456>");
    expect(discordInboundText("", undefined)).toBe("");
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
      channelId: "channel-1" as ConversationId,
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
      ref: { connectionId: "connection:discord", conversationId: "channel-1" },
      service: "discord",
      senderId: "user-1",
    });
    expect(editReply).toHaveBeenCalledWith({ content: "Stopped." });
    expect(resolveDiscordPerson).not.toHaveBeenCalled();
  });
});
