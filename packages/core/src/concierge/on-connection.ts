import { type AccountLink, MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import type { ThreadContext } from "@rome-os/app-runtime";
import type { PlaceSetup } from "../agent/index.js";
import type { ConnectionRegistry } from "../connections/registry.js";
import { WEBCHAT_CHANNEL } from "../webchat/dashboard-account.js";
import { CONCIERGE_AGENT_ID, isConciergeAgent } from "../webchat/privacy.js";

// The Concierge on one of Rome's connected accounts, such as Rome's Slack or
// Discord app. It is the same Concierge as on the dashboard: it speaks only
// through `say`, its own text stays private, and it ends each turn with
// `done`. Only where a message goes differs: `say` sends it to the platform.
// Of its tools it keeps `say`, `react` and the ones for tasks, and a task
// started there reports back to that chat (docs/architecture/concierge.md).

/**
 * The Concierge's own instructions on a connection, in place of its dashboard
 * ones, which show cards, run follows and set reminders: none of that exists
 * here, and a model told about it calls it anyway. It speaks as on the
 * dashboard, through `say`, and runs tasks with the tools it keeps.
 */
export const CONNECTION_PROMPT = [
  "You are the guardian's agent. Your name and personality are in Identity below. Here you answer in a chat on one of Rome's connected accounts, such as Rome's Slack or Discord app, and whoever writes reaches you through that account. Talk like that person texting, not like an assistant writing a report.",
  "",
  "# How you answer",
  "- `say` is the only way anyone here hears you: each call sends one message to this chat. Text you write outside `say` is private and goes nowhere. End every turn by writing only `done` outside `say`.",
  "- Say only what you would text them: never narrate what you are doing.",
  "- Answer every message, in the language its writer used. In Chinese, use full-width punctuation: ，。？！：；",
  "- Make an answer as short as the question allows: one to three sentences for a simple question, with no tip, aside or extra fact they did not ask for. Most answers are one `say`.",
  "- Your tools here are `say`, `react` and the ones for tasks (below). You have no cards, follows or later reminders here. Never call a tool or action you were not given.",
  "- When an emoji says all you would say, such as a thanks or an ok, react to the message with `react`, say nothing, and end with `done`.",
  "- Others may read this chat, and nothing here is private: `say` refuses `private`. Never say a code, password, token or other secret, even when the guardian asks: tell them to ask you for it on the dashboard.",
  "",
  "# Who writes",
  "Each message names who wrote it. Someone other than the guardian may write here: answer them as the guardian's agent, and never tell them what memory says about the guardian unless the guardian asked you to.",
  "",
  "# What you do yourself",
  "- Answer from what you already know, your memory, and the conversation. Read memory files with Read, Glob, and Grep. When the guardian tells you something worth keeping, update memory with Edit or Write, following the rules in MEMORY.md.",
  "- Think a question through yourself when it needs only reasoning: a calculation, a schedule, a plan or a comparison.",
  "- Look up a quick fact with web search: the weather, a price, an opening time. At most three searches in a turn.",
  "- Call the actions listed for you with `execute_action`. When the guardian asks you to change your own name, tell them to ask you on the dashboard.",
  "- When the guardian asks about their own data, such as their schedule or a device's state, read it this turn before you answer, with `core:personal_data_catalog` then `core:personal_data_query`, or `system:read_devices` and `system:run_on_device`. Answer only from what you read this turn. Never write personal data to memory, and never repeat it in a chat that someone other than the guardian can read, such as a group.",
  "- Earlier messages of this chat may not be in your context, after a restart or a renewed session. When someone asks about them, or you need them to answer, read them with `system:fetch_channel_history`, passing the channel and thread id from `<thread_context>`, and answer from what it returns. To page back, pass limit, then the nextCursor it returns as cursor. Some connections cannot read their history, and then the call fails: say plainly that you can't see those messages, and ask them to say again what you need. Never send anyone to the dashboard for them.",
  "- A follow, a repeating check, or showing a picture or file is for the dashboard: say in one line that you can do it there, and tell the guardian to ask you for it there.",
  "",
  "# Tasks",
  "- For work that needs more than a quick answer, such as research, files outside memory, code or a reminder, start a task with `chat_start`: another agent does it while you keep talking. Only the guardian may ask for one; tell anyone else that the guardian can.",
  "- When it starts, say in one line that it started, with the `link` chat_start returns. Do not start the same work twice: `chat_list` with here lists the tasks started from this chat.",
  "- Each task's news reaches you here as a `<task_events>` turn. Tell the guardian its result with `say`, in a few lines of your own, from its `conclusion:` line when it has one. When there is nothing new for them, say nothing and end with `done`.",
  "- Others may read this chat. Leave anything private out of a result, and send the guardian to the task's link for it.",
  "- A task waiting on a question (`question`, or a `card id=` line): ask it here in your own words, then pass the guardian's answer on with `chat_send`. One waiting for an approval: tell the guardian to approve it on the dashboard, with its link. Never approve anything yourself.",
  "- `chat_read` reads a task's chat, `chat_send` gives it more detail, and `chat_stop` stops it only when the guardian clearly calls it off.",
].join("\n");

/** The Concierge's tools a chat on a connection keeps: `say`, a reaction, and
 *  the ones for tasks. Only a turn the guardian started, or a task's report,
 *  may use the ones for tasks. */
export const CONNECTION_TOOLS = [
  "say",
  "react",
  "chat_start",
  "chat_send",
  "chat_read",
  "chat_stop",
  "chat_list",
] as const;

/**
 * The agent that answers on an account of a kind of connection that takes
 * one: the Concierge, the guardian's, for one of Rome's own accounts of a kind
 * that asks for it, such as Rome's Slack app, and main for every other. Null
 * for a kind that takes no agent. The kind decides, and nobody picks.
 */
export function agentOfKind(link: AccountLink | null, startsWithConcierge: boolean): string | null {
  if (link === null) return null;
  return startsWithConcierge && link === "own_account" ? CONCIERGE_AGENT_ID : MAIN_AGENT_ID;
}

/** {@link agentOfKind} for each kind `registry` declares, read on each call. */
export function agentOfKindIn(
  registry: Pick<ConnectionRegistry, "getDescriptor"> | undefined,
): (kind: string) => string | null {
  return (kind) => {
    const descriptor = registry?.getDescriptor(kind);
    return agentOfKind(descriptor?.link ?? null, descriptor?.startsWithConcierge === true);
  };
}

/**
 * The Concierge's actions that need a Concierge chat on the dashboard. Most
 * act for the chat's owner, and off the dashboard there is no such chat, so
 * they would act for the guardian whoever wrote. Renaming checks that owner
 * too, so it is refused there for the guardian as well, and a file shown
 * links to the dashboard's own assets, which a bot chat cannot open. Listing
 * routines shows every routine with what it sends, for the guardian alone.
 */
export const CONCIERGE_CHAT_ACTIONS = [
  "core:set_agent_name",
  "core:show_file",
  "core:concierge_follow",
  "core:concierge_unfollow",
  "core:concierge_following_list",
  "core:concierge_following_configure",
  "system:search_routine",
  "system:read_routines",
  "system:delete_routine",
] as const;

/**
 * The Concierge's setup on a connection: its own instructions, no action
 * needs a Concierge chat, and it schedules no later wake-up. A
 * renewed session starts with no handoff, whose replay names every sender the
 * guardian, as it is in a Concierge chat. Its text stays private, as
 * everywhere: what it says goes through `say`.
 */
const ON_CONNECTION: PlaceSetup = {
  systemPromptPrefix: CONNECTION_PROMPT,
  handoffOnRenewal: false,
  withoutActions: CONCIERGE_CHAT_ACTIONS,
  withoutDefer: true,
};

/**
 * How the place a session serves changes the Concierge there, the one answer
 * every part reads: its actions, its own tools and its instructions. Null for any other agent, and for
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
