import { describe, expect, it, rs } from "@rstest/core";
import type { ChatStopHandler, ConversationId } from "@rome-os/app-runtime";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  buildDiscordSlashCommands,
  DiscordAdapter,
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

  it("routes native /stop through chat control before the guardian-only config gate", async () => {
    const stop = rs.fn(async () => ({ status: "stop_requested" as const, turnId: "turn-1" }));
    const chatStop: ChatStopHandler = stop;
    const isGuardian = rs.fn(async () => false);
    const adapter = new DiscordAdapter({
      botToken: "token",
      connectionId: "connection:discord",
      chatStop,
      isGuardian,
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
    expect(editReply).toHaveBeenCalledWith({ content: "Stop requested." });
    expect(isGuardian).not.toHaveBeenCalled();
  });
});
