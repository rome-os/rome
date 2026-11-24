import { describe, expect, it, rs } from "@rstest/core";
import type { ChatDescriptor, ChatId } from "@rome-os/app-runtime";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { CHAT_COMMANDS } from "../../../chat-settings/chat-commands.js";
import type { Command, Commands } from "../../command.js";
import { DiscordAdapter, discordSlashCommands } from "./discord.js";

const CONNECTION_ID = "connection:discord";
const CHANNEL_ID = "channel-1" as ChatId;

/** Discord's option types for a subcommand and a subcommand group. */
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

function makeCommands(answer = "done") {
  const ran = rs.fn(async (_command: Command) => answer);
  const suggest = rs.fn(async (_command: Command, _option: string, _typed: string) => [
    "pm-assistant",
  ]);
  const commands: Commands = { list: [], ran, suggest };
  return { commands, ran, suggest };
}

function adapterWith(commands: Commands) {
  const observe = rs.fn((_descriptor: ChatDescriptor) => undefined);
  const adapter = new DiscordAdapter({
    botToken: "test-token",
    connectionId: CONNECTION_ID,
    chatSettings: { observe, get: rs.fn() },
    commands,
  });
  return { adapter, observe };
}

/** `/channel agent set name:<name>` as Discord delivers it. */
function agentSet(name: string, extra: Record<string, unknown> = {}) {
  return {
    commandName: "channel",
    channelId: CHANNEL_ID,
    guildId: "guild-1",
    channel: { name: "general", isThread: () => false },
    guild: { name: "Rome" },
    user: { id: "guardian-777", displayName: "Ann" },
    applicationId: "bot",
    options: {
      data: [
        {
          name: "agent",
          type: SUBCOMMAND_GROUP,
          options: [
            { name: "set", type: SUBCOMMAND, options: [{ name: "name", type: 3, value: name }] },
          ],
        },
      ],
      getFocused: () => ({ name: "name", value: name }),
    },
    ...extra,
  };
}

describe("Discord slash commands", () => {
  it("registers each command it is given, /stop among them, open to every member", () => {
    const registered = discordSlashCommands(CHAT_COMMANDS);

    expect(registered.map((command) => command.name)).toEqual(["stop", "channel", "bot", "help"]);
    expect(registered[0]).toMatchObject({
      name: "stop",
      description: "Stop the active Rome response in this conversation",
    });
    for (const command of registered) expect(command.default_member_permissions).toBeUndefined();
  });

  it("registers a subcommand with subcommands as a group, and its options' choices", () => {
    const channel = discordSlashCommands(CHAT_COMMANDS)[1] as unknown as {
      options: Array<{ name: string; type: number; options?: Array<Record<string, unknown>> }>;
    };

    const agent = channel.options.find((option) => option.name === "agent");
    expect(agent?.type).toBe(SUBCOMMAND_GROUP);
    expect(agent?.options?.[0]).toMatchObject({
      name: "set",
      options: [{ name: "name", required: true, autocomplete: true }],
    });
    const mention = channel.options.find((option) => option.name === "mention");
    expect(mention?.options?.[0]).toMatchObject({
      choices: [
        { name: "on", value: "on" },
        { name: "off", value: "off" },
      ],
    });
  });

  it("reports a command run, with its chat, sender and options, and answers only the sender", async () => {
    const { commands, ran } = makeCommands("✓ routed");
    const { adapter, observe } = adapterWith(commands);
    const deferReply = rs.fn(async () => undefined);
    const editReply = rs.fn(async () => undefined);
    const interaction = agentSet("pm-assistant", { deferReply, editReply });

    await (
      adapter as unknown as { handleSlashCommand(i: ChatInputCommandInteraction): Promise<void> }
    ).handleSlashCommand(interaction as unknown as ChatInputCommandInteraction);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(ran).toHaveBeenCalledWith({
      where: { chatId: CHANNEL_ID, kind: "group", name: "general" },
      sender: { accountId: "guardian-777", name: "Ann" },
      receivedBy: "bot",
      path: ["channel", "agent", "set"],
      options: { name: "pm-assistant" },
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { connectionId: CONNECTION_ID, chatId: CHANNEL_ID },
        displayName: "general",
        containerName: "Rome",
      }),
    );
    expect(editReply).toHaveBeenCalledWith({ content: "✓ routed" });
  });

  it("shows the values suggested for an option while it is typed", async () => {
    const { commands, suggest } = makeCommands();
    const { adapter } = adapterWith(commands);
    const respond = rs.fn(async () => undefined);
    const interaction = agentSet("pm", { respond });

    await (
      adapter as unknown as { handleAutocomplete(i: AutocompleteInteraction): Promise<void> }
    ).handleAutocomplete(interaction as unknown as AutocompleteInteraction);

    expect(suggest).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["channel", "agent", "set"] }),
      "name",
      "pm",
    );
    expect(respond).toHaveBeenCalledWith([{ name: "pm-assistant", value: "pm-assistant" }]);
  });
});
