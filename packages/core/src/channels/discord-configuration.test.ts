import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ConversationDescriptor,
  ConversationId,
  ConversationSettings,
  ConversationSettingsControl,
  ConversationSettingsSnapshot,
} from "@rome-os/app-runtime";
import type { ChatInputCommandInteraction } from "discord.js";
import { buildDiscordSlashCommands, DiscordAdapter } from "./discord.js";

const CONNECTION_ID = "connection:discord";
const CHANNEL_ID = "channel-1" as ConversationId;
const GUARDIAN_ID = "discord-guardian-777";
const UNLINKED_ID = "discord-user-888";

function makeConversationSettings() {
  const effective: ConversationSettings = {
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
  const descriptor: ConversationDescriptor = {
    ref: { connectionId: CONNECTION_ID, conversationId: CHANNEL_ID },
    service: "discord",
    kind: "channel",
    displayName: "general",
    containerName: "Rome",
  };
  const snapshot: ConversationSettingsSnapshot = {
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
  } as unknown as ConversationSettingsControl & {
    observe(descriptor: ConversationDescriptor): void;
  };
  return { control, get, update, reset };
}

function makeInteraction(input: {
  userId: string;
  subcommand: string;
  subcommandGroup?: string | null;
  strings?: Record<string, string>;
}) {
  const deferReply = rs.fn(async () => undefined);
  const editReply = rs.fn(async () => undefined);
  const interaction = {
    commandName: "channel",
    channelId: CHANNEL_ID,
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
    const settings = makeConversationSettings();
    const resolveDiscordPerson = rs.fn(async (discordUserId: string) =>
      discordUserId === GUARDIAN_ID ? { id: "guardian", bondLevel: "guardian" as const } : null,
    );
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      conversationSettings: settings.control,
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
    const settings = makeConversationSettings();
    const resolveDiscordPerson = rs.fn(async () => ({
      id: "guardian",
      bondLevel: "guardian" as const,
    }));
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: CONNECTION_ID,
      conversationSettings: settings.control,
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

  it("refuses an unlinked Discord user and records safe structured diagnostics", async () => {
    const warn = rs.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = makeConversationSettings();
    const resolveDiscordPerson = rs.fn(async () => null);
    const adapter = new DiscordAdapter({
      botToken: "credential-must-not-appear",
      connectionId: CONNECTION_ID,
      conversationSettings: settings.control,
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
});
