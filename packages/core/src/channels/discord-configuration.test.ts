import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ChatDescriptor,
  ChatId,
  ChatSettings,
  ChatSettingsControl,
  ChatSettingsSnapshot,
} from "@rome-os/app-runtime";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { buildDiscordSlashCommands, DiscordAdapter } from "./discord.js";

const CONNECTION_ID = "connection:discord";
const CHANNEL_ID = "channel-1" as ChatId;
const GUARDIAN_ID = "discord-guardian-777";
const UNLINKED_ID = "discord-user-888";

function makeChatSettings() {
  const effective: ChatSettings = {
    enabled: true,
    activation: {
      mode: "mention",
      botMessages: "ignore",
      whenOthersMentioned: "ignore",
    },
    replies: { placement: "thread" },
    routing: { agentName: null },
    session: { reset: { mode: "idle", idleMinutes: 10_080 } },
  };
  const descriptor: ChatDescriptor = {
    ref: { connectionId: CONNECTION_ID, conversationId: CHANNEL_ID },
    service: "discord",
    kind: "channel",
    displayName: "general",
    containerName: "Rome",
  };
  const snapshot: ChatSettingsSnapshot = {
    conversation: descriptor,
    supportedFields: [
      "enabled",
      "activation.mode",
      "activation.botMessages",
      "activation.whenOthersMentioned",
      "replies.placement",
      "routing.agentName",
    ],
    effective,
    overrides: {},
  };
  const get = rs.fn(async () => snapshot);
  const update = rs.fn(async () => snapshot);
  const reset = rs.fn(async () => snapshot);
  const control = {
    observe: rs.fn(),
    get,
    update,
    reset,
    list: rs.fn(async () => ({ items: [] })),
  } as unknown as ChatSettingsControl & {
    observe(descriptor: ChatDescriptor): void;
  };
  return { control, get, update, reset };
}

function makeInteraction(input: {
  userId: string;
  subcommand: string;
  subcommandGroup?: string | null;
  strings?: Record<string, string>;
  guildId?: string | null;
}) {
  const deferReply = rs.fn(async () => undefined);
  const editReply = rs.fn(async () => undefined);
  const interaction = {
    commandName: "channel",
    channelId: CHANNEL_ID,
    guildId: input.guildId === undefined ? "guild-1" : input.guildId,
    channel: { name: "general", isThread: () => false },
    guild: { name: "Rome" },
    user: { id: input.userId },
    options: {
      getSubcommandGroup: () => input.subcommandGroup ?? null,
      getSubcommand: () => input.subcommand,
      getString: (name: string) => input.strings?.[name] ?? null,
    },
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, deferReply, editReply };
}

async function runCommand(
  adapter: DiscordAdapter,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await (
    adapter as unknown as {
      handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void>;
    }
  ).handleSlashCommand(interaction);
}

function makeAutocompleteInteraction(userId: string) {
  const respond = rs.fn(async () => undefined);
  const interaction = {
    commandName: "channel",
    user: { id: userId },
    options: {
      getSubcommandGroup: () => "agent",
      getSubcommand: () => "set",
      getFocused: () => ({ name: "name", value: "" }),
    },
    respond,
  } as unknown as AutocompleteInteraction;
  return { interaction, respond };
}

async function runAutocomplete(
  adapter: DiscordAdapter,
  interaction: AutocompleteInteraction,
): Promise<void> {
  await (
    adapter as unknown as {
      handleAutocomplete(interaction: AutocompleteInteraction): Promise<void>;
    }
  ).handleAutocomplete(interaction);
}

afterEach(() => {
  rs.restoreAllMocks();
});

describe("Discord configuration command authorization", () => {
  it("leaves Discord member permissions open so the linked guardian reaches Rome authorization", () => {
    const configurationCommands = buildDiscordSlashCommands().filter(({ name }) =>
      ["channel", "bot"].includes(name),
    );

    expect(configurationCommands).toHaveLength(2);
    for (const command of configurationCommands) {
      expect(command.default_member_permissions).toBeUndefined();
    }
  });

  it("lets the linked guardian read channel status", async () => {
    const settings = makeChatSettings();
    const resolveDiscordPerson = rs.fn(async (discordUserId: string) =>
      discordUserId === GUARDIAN_ID ? { id: "guardian", bondLevel: "guardian" as const } : null,
    );
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson,
    });
    const { interaction, editReply } = makeInteraction({
      userId: GUARDIAN_ID,
      subcommand: "status",
    });

    await runCommand(adapter, interaction);

    expect(resolveDiscordPerson).toHaveBeenCalledWith(GUARDIAN_ID);
    expect(settings.get).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("**#general configuration**"),
    });
  });

  it("lets the linked guardian set a channel agent", async () => {
    const settings = makeChatSettings();
    const resolveDiscordPerson = rs.fn(async () => ({
      id: "guardian",
      bondLevel: "guardian" as const,
    }));
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson,
      listAgents: () => ["main", "pm-assistant"],
    });
    const { interaction, editReply } = makeInteraction({
      userId: GUARDIAN_ID,
      subcommandGroup: "agent",
      subcommand: "set",
      strings: { name: "pm-assistant" },
    });

    await runCommand(adapter, interaction);

    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { connectionId: CONNECTION_ID, conversationId: CHANNEL_ID },
        set: { routing: { agentName: "pm-assistant" } },
        actor: { kind: "guardian", id: "discord-slash" },
      }),
    );
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("now routes to agent `pm-assistant`"),
    });
  });

  it("names the account's agent in status and after a clear", async () => {
    const settings = makeChatSettings();
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson: async () => ({ id: "guardian", bondLevel: "guardian" as const }),
      accountAgent: () => "sales:agent",
    });
    const status = makeInteraction({ userId: GUARDIAN_ID, subcommand: "status" });
    await runCommand(adapter, status.interaction);
    expect(status.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("agent: sales:agent"),
    });

    const clear = makeInteraction({
      userId: GUARDIAN_ID,
      subcommandGroup: "agent",
      subcommand: "clear",
    });
    await runCommand(adapter, clear.interaction);
    expect(clear.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("messages now route to sales:agent"),
    });
  });

  it("names the account's agent in status when the stored agent is not loaded", async () => {
    const settings = makeChatSettings();
    const snapshot = await settings.get();
    snapshot.effective.routing.agentName = "gone:agent";
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson: async () => ({ id: "guardian", bondLevel: "guardian" as const }),
      accountAgent: () => "sales:agent",
      hasAgent: (name) => name === "sales:agent",
    });
    const { interaction, editReply } = makeInteraction({
      userId: GUARDIAN_ID,
      subcommand: "status",
    });
    await runCommand(adapter, interaction);
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("agent: sales:agent"),
    });
  });

  it("says no agent answers when the account has no agent", async () => {
    const settings = makeChatSettings();
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson: async () => ({ id: "guardian", bondLevel: "guardian" as const }),
      accountAgent: () => null,
    });
    const { interaction, editReply } = makeInteraction({
      userId: GUARDIAN_ID,
      subcommandGroup: "agent",
      subcommand: "set",
      strings: { name: "main" },
    });
    await runCommand(adapter, interaction);
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("no agent answers here"),
    });
  });

  it("pins a channel to main on `set main`", async () => {
    const settings = makeChatSettings();
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson: async () => ({ id: "guardian", bondLevel: "guardian" as const }),
      accountAgent: () => "sales:agent",
    });
    const { interaction, editReply } = makeInteraction({
      userId: GUARDIAN_ID,
      subcommandGroup: "agent",
      subcommand: "set",
      strings: { name: "main" },
    });
    await runCommand(adapter, interaction);
    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ set: { routing: { agentName: "main" } } }),
    );
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("pinned to main — messages now route to main"),
    });
  });

  it("follows the account's agent in a DM, whatever agent is stored", async () => {
    const settings = makeChatSettings();
    const snapshot = await settings.get();
    snapshot.effective.routing.agentName = "pm-assistant";
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson: async () => ({ id: "guardian", bondLevel: "guardian" as const }),
      accountAgent: () => "sales:agent",
      listAgents: () => ["pm-assistant", "sales:agent"],
    });
    const status = makeInteraction({ userId: GUARDIAN_ID, subcommand: "status", guildId: null });
    await runCommand(adapter, status.interaction);
    expect(status.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("agent: sales:agent"),
    });

    const set = makeInteraction({
      userId: GUARDIAN_ID,
      subcommandGroup: "agent",
      subcommand: "set",
      strings: { name: "pm-assistant" },
      guildId: null,
    });
    await runCommand(adapter, set.interaction);
    expect(set.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining(
        "stored agent `pm-assistant`, but messages now route to sales:agent",
      ),
    });
  });

  it("refuses an unlinked Discord user and records safe structured diagnostics", async () => {
    const warn = rs.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = makeChatSettings();
    const resolveDiscordPerson = rs.fn(async () => null);
    const adapter = new DiscordAdapter({
      botToken: "credential-must-not-appear",
      connectionId: CONNECTION_ID,
      chatSettings: settings.control,
      resolveDiscordPerson,
      listAgents: () => ["pm-assistant"],
    });
    const { interaction, editReply } = makeInteraction({
      userId: UNLINKED_ID,
      subcommandGroup: "agent",
      subcommand: "set",
      strings: { name: "pm-assistant" },
    });

    await runCommand(adapter, interaction);

    expect(resolveDiscordPerson).toHaveBeenCalledWith(UNLINKED_ID);
    expect(settings.get).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: "Only the linked guardian can configure this Discord conversation.",
    });

    const entry = JSON.parse(warn.mock.calls.at(-1)?.[0] as string) as {
      message: string;
      data: Record<string, unknown>;
    };
    expect(entry).toMatchObject({
      message: "discord configuration command authorization rejected",
      data: {
        connectionId: CONNECTION_ID,
        discordUserId: UNLINKED_ID,
        command: "channel",
        authorized: false,
        decision: "deny",
        authorizationResult: "unlinked",
        personId: null,
        bondLevel: null,
      },
    });
    expect(warn.mock.calls.at(-1)?.[0]).not.toContain("credential-must-not-appear");
  });

  it("does not expose agent autocomplete choices to an unlinked Discord user", async () => {
    const resolveDiscordPerson = rs.fn(async () => null);
    const listAgents = rs.fn(() => ["main", "private-agent"]);
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      resolveDiscordPerson,
      listAgents,
    });
    const { interaction, respond } = makeAutocompleteInteraction(UNLINKED_ID);

    await runAutocomplete(adapter, interaction);

    expect(resolveDiscordPerson).toHaveBeenCalledWith(UNLINKED_ID);
    expect(listAgents).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith([]);
  });
});
