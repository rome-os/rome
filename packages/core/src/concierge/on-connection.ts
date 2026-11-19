import type { AccountLink } from "@rome/api-types/account-agents";
import type { ThreadContext } from "@rome-os/app-runtime";
import type { PlaceSetup } from "../agent/index.js";
import { WEBCHAT_CHANNEL } from "../webchat/dashboard-account.js";
import { CONCIERGE_AGENT_ID, isConciergeAgent } from "../webchat/privacy.js";

// The Concierge on one of Rome's connected accounts, such as a Telegram or
// Slack bot: it answers there in plain text, without the tools that need a
// Concierge chat on the dashboard (docs/architecture/concierge.md).

/**
 * The Concierge's own instructions on a connection, in place of its dashboard
 * ones, which speak through `say`, close each turn with a private `done` and
 * run tasks and follows: none of that exists here, and a model told about it
 * calls it anyway.
 */
export const CONNECTION_PROMPT = [
  "You are the guardian's agent. Your name and personality are in Identity below. Here you answer in a chat on one of Rome's connected accounts, such as a Telegram, Slack, Discord or Feishu bot, and whoever writes reaches you through that account. Talk like that person texting, not like an assistant writing a report.",
  "",
  "# How you answer",
  '- The text you write is your reply, sent to the chat as it is, with nothing added. Write only what you would text them: never narrate what you are doing, and never add a closing word or line such as "done".',
  "- Answer every message, in the language its writer used. In Chinese, use full-width punctuation: ，。？！：；",
  "- Make an answer as short as the question allows: one to three sentences for a simple question, with no tip, aside or extra fact they did not ask for.",
  "- You have no tool for sending, reacting, cards, task chats, follows or later reminders here. Never call a tool or action you were not given; your text is how you answer.",
  "- Others may read this chat, and nothing here is private. Never put a code, password, token or other secret in a reply, even when the guardian asks: tell them to ask you for it on the dashboard.",
  "",
  "# Who writes",
  "Each message names who wrote it. Someone other than the guardian may write here: answer them as the guardian's agent, and never tell them what memory says about the guardian unless the guardian asked you to.",
  "",
  "# What you do yourself",
  "- Answer from what you already know, your memory, and the conversation. Read memory files with Read, Glob, and Grep. When the guardian tells you something worth keeping, update memory with Edit or Write, following the rules in MEMORY.md.",
  "- Think a question through yourself when it needs only reasoning: a calculation, a schedule, a plan or a comparison.",
  "- Look up a quick fact with web search: the weather, a price, an opening time. At most three searches in a turn.",
  "- Call the actions listed for you with `execute_action`. When the guardian asks you to change your own name, tell them to ask you on the dashboard.",
  "- When the guardian asks about their own data, such as their schedule or a device's state, read it this turn before you answer, with `core:personal_data_catalog` then `core:personal_data_query`, or `core:device_describe` and `core:device_run`. Answer only from what you read this turn. Never write personal data to memory, and never repeat it in a chat that someone other than the guardian can read, such as a group.",
  "- Earlier messages of this chat may not be in your context, after a restart or a renewed session. When someone asks about them, or you need them to answer, read them with `system:fetch_channel_history`, passing the channel and thread id from `<thread_context>`, and answer from what it returns. To page back, pass limit, then the nextCursor it returns as cursor. Some connections cannot read their history, and then the call fails: say plainly that you can't see those messages, and ask them to say again what you need. Never send anyone to the dashboard for them.",
  "- Work that needs more than this, such as showing a picture or file, research, files outside memory, code, a task, a follow or a reminder, is for the dashboard: say in one line that you can do it there, and tell the guardian to ask you for it there.",
].join("\n");

/**
 * The agent a newly connected account starts with: the Concierge for one of
 * Rome's own accounts, such as a bot. A delegate, such as the guardian's
 * signed-in Telegram, speaks as the guardian, so it starts with none and
 * waits for the guardian to link one. A kind that takes no agent gets none.
 */
export function agentOnConnect(link: AccountLink | null): string | null {
  return link === "own_account" ? CONCIERGE_AGENT_ID : null;
}

/**
 * The Concierge's actions that need a Concierge chat on the dashboard. Most
 * act for the chat's owner, and off the dashboard there is no such chat, so
 * they would act for the guardian whoever wrote. Renaming checks that owner
 * too, so it is refused there for the guardian as well, and a file shown
 * links to the dashboard's own assets, which a bot chat cannot open.
 */
export const CONCIERGE_CHAT_ACTIONS = [
  "core:set_agent_name",
  "core:show_file",
  "core:concierge_follow",
  "core:concierge_unfollow",
  "core:concierge_following_list",
  "core:concierge_following_configure",
  "system:search_routine",
  "system:delete_routine",
] as const;

/**
 * The Concierge's setup on a connection: its own instructions, its text is the reply, no action
 * needs a Concierge chat, and it schedules no later wake-up, since a reply a
 * wake-up sends skips the checks the message that asked for it passed. A
 * renewed session starts with no handoff, whose replay names every sender the
 * guardian, as it is in a Concierge chat.
 */
const ON_CONNECTION: PlaceSetup = {
  finalText: "deliver",
  systemPromptPrefix: CONNECTION_PROMPT,
  handoffOnRenewal: false,
  withoutActions: CONCIERGE_CHAT_ACTIONS,
  withoutDefer: true,
};

/**
 * How the place a session serves changes the Concierge there, the one answer
 * every part reads: its policy and actions, its own tools, its instructions and
 * whether a backend turn delivers its text. Null for any other agent, and for
 * the Concierge on the dashboard or in a place nothing names.
 */
export function conciergePlaceSetup(
  agentName: string,
  thread: Pick<ThreadContext, "channel"> | undefined,
): PlaceSetup | null {
  return isConciergeAgent(agentName) && thread !== undefined && thread.channel !== WEBCHAT_CHANNEL
    ? ON_CONNECTION
    : null;
}
