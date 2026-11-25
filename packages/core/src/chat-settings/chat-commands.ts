// The commands the guardian and members run in a chat to read and change its chat rules,
// and `/stop`. A connection that offers commands puts these on its platform
// and reports each one run. The entrance (participation/entrance.ts) decides
// who may run one; this file decides what it does and what the answer says. Vocabulary: docs/domains/chats.md#chat-rule,
// docs/domains/connections.md#command.

import {
  type ChatSettingField,
  type ChatSettingsControl,
  type ChatSettingsSnapshot,
  type ChatStopHandler,
  chatStopReceipt,
  type PartialChatSettings,
} from "@rome-os/app-runtime";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import {
  answeringAgentOf,
  describeAnsweringAgent,
  storedAgentChoice,
} from "../chats/connected-accounts/account-agents.js";
import type { Command, CommandSpec, Commands } from "../connections/index.js";

/** The settings a chat's commands are written by. */
const ACTOR = { kind: "guardian", id: "discord-slash" } as const;

/** Most suggestions a platform shows for one option. */
const MAX_SUGGESTIONS = 25;

export interface ChatCommandsDeps {
  /** The Connection the commands are run on, and its kind. */
  connectionId: string;
  service: string;
  settings: ChatSettingsControl;
  chatStop?: ChatStopHandler;
  /** The loaded agents, by name. Absent, any name is taken. */
  listAgents?: () => string[];
  /** Whether an agent is loaded, aliases included. Absent, every agent counts
   *  as loaded. */
  hasAgent?: (name: string) => boolean;
  /** The agent linked to the Connection's account, as
   *  `accountAgentResolver` answers it. */
  accountAgent?: () => string | null | undefined;
}

const ON_OFF = ["on", "off"] as const;

/** The commands, as a platform lists them. */
export const CHAT_COMMANDS: readonly CommandSpec[] = [
  { name: "stop", description: "Stop the active Rome response in this conversation" },
  {
    name: "channel",
    description: "Configure Rome Bot behavior for this channel",
    subcommands: [
      { name: "ignore", description: "Permanently silence the bot in this channel" },
      { name: "allow", description: "Restore bot responses in this channel (clear ignore)" },
      {
        name: "mention",
        description: "Toggle @mention requirement",
        options: [
          {
            name: "setting",
            description: "on = require @mention (default), off = respond freely",
            required: true,
            choices: ON_OFF,
          },
        ],
      },
      {
        name: "bots",
        description: "Control how the bot handles messages from other bots",
        options: [
          {
            name: "mode",
            description: "none = ignore bots, mentions = only if bot is @mentioned, all = always",
            required: true,
            choices: ["none", "mentions", "all"],
          },
        ],
      },
      {
        name: "quiet",
        description: "Toggle quiet mode: ignore messages that @mention others",
        options: [
          {
            name: "setting",
            description:
              "on = stay silent when others are @mentioned (default), off = always respond",
            required: true,
            choices: ON_OFF,
          },
        ],
      },
      {
        name: "thread",
        description: "Toggle auto-thread for bot replies",
        options: [
          {
            name: "setting",
            description: "on = reply in a thread (default), off = reply inline",
            required: true,
            choices: ON_OFF,
          },
        ],
      },
      {
        name: "agent",
        description: "Route this channel to a specific agent (default = main)",
        subcommands: [
          {
            name: "set",
            description: "Bind this channel to the named agent",
            options: [
              {
                name: "name",
                description: "Agent name (e.g. main, or an agent shipped by an installed app)",
                required: true,
                // Whoever runs it may still type a name the list does not hold;
                // `set` checks it against the loaded agents.
                suggested: true,
              },
            ],
          },
          {
            name: "clear",
            description: "Stop routing to a custom agent — fall back to main",
          },
        ],
      },
      { name: "reset", description: "Clear all overrides for this channel, restore defaults" },
      { name: "status", description: "Show current configuration for this channel" },
    ],
  },
  {
    name: "bot",
    description: "Global Rome Bot status and management",
    subcommands: [{ name: "status", description: "Show all channel overrides" }],
  },
  { name: "help", description: "Show available Rome Bot commands" },
];

const HELP = [
  "**Rome Bot Commands**",
  "",
  "Channel configuration (run inside the target channel):",
  "  `/channel ignore` — silence the bot in this channel",
  "  `/channel allow` — restore bot responses (clear ignore)",
  "  `/channel mention off|on` — disable/enable @mention requirement",
  "  `/channel bots none|mentions|all` — how to handle messages from other bots",
  "  `/channel quiet on|off` — stay silent when others are @mentioned",
  "  `/channel thread off|on` — disable/enable auto-thread for replies",
  "  `/channel agent set <name>` — route this channel to a specific agent, or pin it to main (default: the account's agent)",
  "  `/channel agent clear` — clear the agent binding for this channel",
  "  `/channel reset` — clear all overrides for this channel",
  "  `/channel status` — show current channel configuration",
  "",
  "Global overview:",
  "  `/bot status` — list all channel overrides",
  "  `/stop` — stop the active Rome response in this conversation",
  "",
  "Tip: you can also tell the bot what you want in plain language",
].join("\n");

/** The chat commands run on Connection `deps.connectionId`. */
export function chatCommands(deps: ChatCommandsDeps): Commands {
  return {
    list: CHAT_COMMANDS,
    async ran(command) {
      const [name, sub] = command.path;
      if (name === "stop") return stop(deps, command);
      if (name === "help") return HELP;
      if (name === "bot" && sub === "status") return botStatus(deps);
      if (name === "channel") return channel(deps, command);
      return "Unknown command";
    },
    async suggest(command, option, typed) {
      const [name, group, sub] = command.path;
      if (name !== "channel" || group !== "agent" || sub !== "set" || option !== "name") return [];
      // `main` is the default: `/channel agent clear` goes back to it.
      const candidates = (deps.listAgents?.() ?? []).filter((each) => !isCoreMainAgentId(each));
      const query = typed.toLowerCase();
      return (
        query ? candidates.filter((each) => each.toLowerCase().includes(query)) : candidates
      ).slice(0, MAX_SUGGESTIONS);
    },
  };
}

async function stop(deps: ChatCommandsDeps, command: Command): Promise<string> {
  if (!deps.chatStop) return "Stop is unavailable for this connection.";
  const result = await deps.chatStop({
    ref: { connectionId: deps.connectionId, chatId: command.where.chatId },
    service: deps.service,
    senderId: command.sender.accountId,
  });
  return chatStopReceipt(result.status);
}

async function botStatus(deps: ChatCommandsDeps): Promise<string> {
  const page = await deps.settings.list({ connectionId: deps.connectionId, limit: 100 });
  const changed = page.items.filter((item) => Object.keys(item.snapshot.overrides).length > 0);
  return changed.length === 0
    ? "**Rome Bot Status**\n\nAll conversations use defaults."
    : `**Rome Bot Status**\n\n${changed.length} conversation(s) have explicit overrides. Manage them on the Discord connection's page in Settings → Connections.`;
}

async function channel(deps: ChatCommandsDeps, command: Command): Promise<string> {
  const [, sub, agentSub] = command.path;
  const { where } = command;
  const ref = { connectionId: deps.connectionId, chatId: where.chatId };
  const named = where.name ? `#${where.name}` : "this channel";
  const answering = (choice: string | undefined) =>
    answeringAgentOf(
      deps.accountAgent?.(),
      choice,
      where.kind === "group" ? "group" : "private",
      deps.hasAgent,
    );

  if (sub === "status") {
    const snapshot = await deps.settings.get(ref);
    return status(named, snapshot, answering(storedAgentChoice(snapshot)));
  }
  if (where.thread) {
    return "This thread follows the settings of the channel it was opened in. Run the command there to change them.";
  }
  if (sub === "reset") {
    await deps.settings.reset({ ref, actor: ACTOR });
    return `✓ ${named} configuration cleared\nRestored all defaults (require @mention, ignore other bots, auto-thread on)`;
  }

  const change = (set: PartialChatSettings, clear: ChatSettingField[] = []) =>
    deps.settings.update({ ref, set, clear, actor: ACTOR });
  const option = (name: string) => command.options[name] ?? "";

  switch (sub) {
    case "ignore":
      await change({ enabled: false });
      return `✓ ${named} is now ignored\nThe bot will not respond here, even if @mentioned\nUse \`/channel allow\` to undo`;
    case "allow":
      await change({}, ["enabled"]);
      return `✓ ${named} ignore cleared — bot will respond again`;
    case "mention":
      if (option("setting") === "off") {
        await change({ activation: { mode: "all" } });
        return `✓ ${named} @mention requirement disabled\nThe bot will respond to all messages here\n⚠ Use with caution in high-traffic channels`;
      }
      await change({}, ["activation.mode"]);
      return `✓ ${named} @mention requirement enabled (default restored)`;
    case "bots": {
      const mode = option("mode");
      if (mode === "mentions" || mode === "all") {
        await change({ activation: { botMessages: mode } });
      } else {
        await change({}, ["activation.botMessages"]);
      }
      return `✓ ${named} bot filter set to "${mode}"`;
    }
    case "quiet":
      if (option("setting") === "off") {
        await change({ activation: { whenOthersMentioned: "respond" } });
        return `✓ ${named} quiet mode disabled\nThe bot will respond even when others are @mentioned\n⚠ Not recommended in multi-user channels`;
      }
      await change({}, ["activation.whenOthersMentioned"]);
      return `✓ ${named} quiet mode enabled (stays silent when others are @mentioned)`;
    case "thread":
      if (option("setting") === "off") {
        await change({ replies: { placement: "inline" } });
        return `✓ ${named} auto-thread disabled\nThe bot will reply directly in the channel`;
      }
      await change({}, ["replies.placement"]);
      return `✓ ${named} auto-thread enabled (default restored)`;
    case "agent":
      return agent(deps, agentSub, option("name").trim(), named, answering, change);
    default:
      return "Unknown command";
  }
}

async function agent(
  deps: ChatCommandsDeps,
  sub: string | undefined,
  name: string,
  named: string,
  answering: (choice: string | undefined) => string | null,
  change: (set: PartialChatSettings, clear?: ChatSettingField[]) => Promise<unknown>,
): Promise<string> {
  if (sub === "clear") {
    await change({}, ["routing.agentName"]);
    return `✓ ${named} agent binding removed — ${answersLine(answering(undefined))}`;
  }
  if (sub !== "set") return "Unknown command";
  if (!name) {
    return "Agent name is required. Try `/channel agent clear` to remove the binding.";
  }
  // `set main` pins the chat to main, so it stops following the account's
  // agent. `clear` is how it follows the link again.
  if (isCoreMainAgentId(name)) {
    await change({ routing: { agentName: "main" } });
    return `✓ ${named} pinned to main — ${answersLine(answering("main"))}\nUse \`/channel agent clear\` to undo.`;
  }
  const available = deps.listAgents?.();
  if (available && !available.includes(name)) {
    const sample = available.slice(0, 20).sort().join(", ");
    return `✗ Agent \`${name}\` is not loaded.\nAvailable agents: ${sample || "(none)"}`;
  }
  await change({ routing: { agentName: name } });
  const answers = answering(name);
  return (
    (answers === name
      ? `✓ ${named} now routes to agent \`${name}\`\n`
      : `✓ ${named} stored agent \`${name}\`, but ${answersLine(answers)}\n`) +
    "Use `/channel agent clear` to undo."
  );
}

/** A chat's rules as `/channel status` lists them. */
function status(named: string, snapshot: ChatSettingsSnapshot, agent: string | null): string {
  const { effective } = snapshot;
  const botMessages = effective.activation.botMessages;
  const lines = [
    `mode: ${effective.enabled ? "allow" : "ignore"}`,
    `requireMention: ${effective.activation.mode === "mention"}`,
    `allowBots: ${botMessages === "ignore" ? "none" : botMessages}`,
    `ignoreNoMention: ${effective.activation.whenOthersMentioned === "ignore"}`,
    `autoThread: ${effective.replies.placement === "thread"}`,
    `agent: ${describeAnsweringAgent(agent)}${snapshot.inheritedFrom ? " (inherited)" : ""}`,
  ];
  const by = snapshot.updatedBy?.displayName ?? snapshot.updatedBy?.id;
  const updated = snapshot.updatedAt
    ? `\nLast updated: ${snapshot.updatedAt.slice(0, 10)} by ${by ?? "unknown"}`
    : "";
  return `**${named} configuration**\n\n${lines.join("\n")}${updated}`;
}

function answersLine(agent: string | null): string {
  return agent
    ? `messages now route to ${agent}`
    : "no agent answers here: this account has no agent, or it is not loaded";
}
