import type { ThreadContext } from "@rome-os/app-runtime";
import type { PlaceSetup } from "../agent/index.js";
import { WEBCHAT_CHANNEL } from "../webchat/dashboard-account.js";
import { isConciergeAgent } from "../webchat/privacy.js";

// The Concierge on one of Rome's connected accounts, such as a Telegram or
// Slack bot: it answers there in plain text, without the tools that need a
// Concierge chat on the dashboard (docs/architecture/concierge.md).

/** What the Concierge reads at the end of its system prompt in a chat on a connection. */
export const CONNECTION_INSTRUCTION = [
  "## On a connected account",
  "",
  "This chat is not on the dashboard. It is on one of Rome's connected accounts, such as a Telegram, Slack, Discord or Feishu bot, and whoever writes reaches you through that account. Here the text you write is your reply, sent to the chat as it is: write only what you would text them, and never narrate what you are doing. `say`, `react`, the task, chat and follow tools and your Concierge chats are not here, so what the instructions above say about them holds only on the dashboard. Do what you can yourself. When something needs a task chat or a follow, tell the guardian to ask you for it on the dashboard.",
  "",
  "Each message names who wrote it. Someone other than the guardian may write here: answer them as the guardian's agent, and never tell them what memory says about the guardian unless the guardian asked you to.",
].join("\n");

/**
 * The Concierge's actions that act for the owner of the Concierge chat a turn
 * runs in. Off the dashboard there is no such chat, so they would act for the
 * guardian whoever wrote.
 */
export const CONCIERGE_CHAT_ACTIONS = [
  "core:concierge_follow",
  "core:concierge_unfollow",
  "core:concierge_following_list",
  "core:concierge_following_configure",
  "system:search_routine",
  "system:delete_routine",
] as const;

/** The Concierge's setup on a connection: its text is the reply, and no action needs a Concierge chat. */
const ON_CONNECTION: PlaceSetup = { finalText: "deliver", withoutActions: CONCIERGE_CHAT_ACTIONS };

/**
 * How the place a session serves changes the Concierge there, the one answer
 * every part reads: its policy and actions, its own tools, its instruction and
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

/** The agent context's `chatInstructions` for the Concierge on a connection, and nothing elsewhere. */
export async function conciergeOnConnection(
  thread: Pick<ThreadContext, "channel"> | undefined,
  agentName: string,
): Promise<string | null> {
  return conciergePlaceSetup(agentName, thread) ? CONNECTION_INSTRUCTION : null;
}

type ChatInstructions = (
  thread: ThreadContext | undefined,
  agentName: string,
) => Promise<string | null>;

/** Every instruction the chat adds, in order, as one. Null when none adds any. */
export function chatInstructionsOf(sources: readonly ChatInstructions[]): ChatInstructions {
  return async (thread, agentName) => {
    const added = await Promise.all(sources.map((source) => source(thread, agentName)));
    const text = added.filter((part): part is string => !!part).join("\n\n");
    return text || null;
  };
}
