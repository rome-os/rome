import type { MessageReplyReference } from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import { channelChatId } from "../db/session-kind.js";
import type { ContextLine, TurnLinks } from "../sessions/turn-links.js";
import type { TurnBriefing } from "../agent-sessions/index.js";
import type { ChannelSurface } from "../connections/session-surface.js";
import { currentMessageSection, replyContextLine, replyContextSection } from "./reply-context.js";
import type { ThreadContext } from "./types.js";

// What a wake on a connection tells the agent before the waking message: the
// messages said where its session stands that it has not seen, and the one the
// waking message replies to. The caller prepares it; the session only places
// it in the turn's prompt when the turn starts.

const log = createLogger("connection-briefing");

/** How many of the messages the agent has not seen a turn's prompt carries.
 *  The rest are counted, not shown. */
const CATCH_UP_LIMIT = 20;

/** One message of the context a turn's prompt opens with. */
interface ConversationContextMessage {
  id: string;
  sender: string | null;
  text: string;
  createdAt?: Date;
}

function contextMessage(message: ContextLine): ConversationContextMessage {
  return {
    id: String(message.id),
    sender: message.senderName,
    text: message.text,
    createdAt: message.at,
  };
}

function conversationContextMessage(message: ConversationContextMessage): string {
  return replyContextLine({
    createdAt: message.createdAt,
    sender: message.sender?.trim() || "Unknown sender",
    text: message.text,
  });
}

function prependConversationContext(
  prompt: string,
  context: {
    notifications: ConversationContextMessage[];
    omittedNotificationCount: number;
    repliedTo: ConversationContextMessage | null;
  },
): string {
  const sections: string[] = [];
  const notifications = context.repliedTo
    ? context.notifications.filter((message) => message.id !== context.repliedTo?.id)
    : context.notifications;
  if (notifications.length > 0 || context.omittedNotificationCount > 0) {
    sections.push(
      "<conversation_context>",
      ...(context.omittedNotificationCount > 0
        ? [`[${context.omittedNotificationCount} earlier messages omitted]`]
        : []),
      ...notifications.map(conversationContextMessage),
      "</conversation_context>",
    );
  }
  if (context.repliedTo) {
    sections.push(...replyContextSection(conversationContextMessage(context.repliedTo)));
  }
  if (sections.length === 0) return prompt;
  sections.push(...currentMessageSection(prompt));
  return sections.join("\n");
}

export interface CatchUpDeps {
  turnLinks?: Pick<TurnLinks, "unseen" | "seen">;
  /** What the named connection's surface supports, or null for a name no
   *  connection has. A null result reads as a messaging connection's. */
  surface?: (connection: string) => ChannelSurface | null;
}

/**
 * The briefing of a turn a wake on a connection starts: the messages the agent
 * has not seen where its session stands, and the message the waking one
 * replies to. Only a turn recorded in a connection's conversation on a surface
 * that carries prompt context gets one. Undefined when there is nothing to
 * read the messages from.
 */
export function catchUpBriefing(
  deps: CatchUpDeps,
  turn: {
    threadContext?: ThreadContext;
    /** The conversation the turn's session stands in, when its caller names one. */
    romeSessionId?: string;
    replyTo?: MessageReplyReference;
    /** The message `replyTo` names, as Rome holds it where the turn's session
     *  stands, or null when Rome holds none. */
    quoted?: ContextLine | null;
  },
): TurnBriefing | undefined {
  const turnLinks = deps.turnLinks;
  const connection = turn.threadContext?.channel;
  if (!turnLinks || !connection || !turn.threadContext) return undefined;
  const promptContext = deps.surface?.(connection)?.promptContext ?? true;
  if (!promptContext) return undefined;
  // The conversation Chats keeps where the turn replies, which is where its
  // session stands.
  const thread = turn.threadContext;
  const romeSessionId =
    turn.romeSessionId ?? thread.romeSessionId ?? channelChatId(thread.channel, thread.threadId);
  return {
    compose(prompt, { turnId }) {
      const recorded = { romeSessionId, turnId };
      // The agent catches up on the messages said where its session stands
      // that no turn of it took, gave or saw (docs/domains/participation.md#projection).
      const unseen = turnLinks.unseen(recorded.romeSessionId);
      const shown = unseen.slice(-CATCH_UP_LIMIT);
      // Rome's first message in a thread quotes the message that started it,
      // said in the chat outside the thread. No message in the thread is a starter.
      const threadStarter =
        unseen.find((message) => message.fromRome && message.quotesOutside)?.quoted ?? null;
      const quoted = turn.quoted ?? null;
      const repliedTo = quoted
        ? contextMessage(quoted)
        : turn.replyTo?.content
          ? {
              id: `runtime-reply:${turn.replyTo.messageId}`,
              sender: turn.replyTo.senderName ?? null,
              text: turn.replyTo.content,
            }
          : null;
      const unseenIds = unseen.map((message) => message.id);
      return {
        prompt: prependConversationContext(prompt, {
          notifications: [
            ...(threadStarter ? [contextMessage(threadStarter)] : []),
            ...shown.map(contextMessage),
          ],
          omittedNotificationCount: unseen.length - shown.length,
          repliedTo,
        }),
        sent:
          unseenIds.length > 0
            ? () => {
                try {
                  turnLinks.seen(unseenIds, recorded.romeSessionId, recorded.turnId);
                } catch (err) {
                  // The turn goes on, and a later turn retries.
                  log.warn("failed to mark conversation context seen", {
                    romeSessionId: recorded.romeSessionId,
                    turnId: recorded.turnId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            : undefined,
      };
    },
  };
}
