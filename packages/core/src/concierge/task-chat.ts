// Reading a task chat the way Concierge does: through the dashboard channel's
// Messages.

import type { ChatId, MessagePart } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { messageContentText } from "../chats/history/messages-agent.js";
import type { SaidMessage as StoredLine } from "../chats/storage/message.js";
import { MessageRepository as ChatLines } from "../chats/storage/message-repository.js";
import { placeIn as placeInChat } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import { TurnLinks, type TurnLink } from "../sessions/turn-links.js";
import { DASHBOARD_PLATFORM, WEBCHAT_CHANNEL } from "../webchat/dashboard-account.js";
import type { SaidMessage } from "../chats/message.js";
import type { MessagePage, MessageRepository } from "../chats/message-repository.js";
import { chatKey, placeIn, type Place } from "../chats/place.js";
import { checkShowCard, SHOW_CARD_APP_ID } from "../agent/index.js";

/** A task chat is a direct message on the dashboard, read through its channel. */
const DASHBOARD = { channel: WEBCHAT_CHANNEL };

export const MAX_READ_LIMIT = 30;

export function taskChatPlace(chatId: string): Place {
  return placeIn(chatKey(DASHBOARD_PLATFORM, chatId as ChatId));
}

export const hasText = (message: SaidMessage) => message.body.text.trim() !== "";

/** The newest `limit` messages of a place that `keep` keeps, oldest first,
 *  paging back past the rest, such as messages that carry only cards. */
export async function latestSaid(
  messages: Pick<MessageRepository, "recent" | "before">,
  place: Place,
  limit: number,
  keep: (message: SaidMessage) => boolean,
): Promise<SaidMessage[]> {
  const pageSize = Math.max(limit, MAX_READ_LIMIT);
  const found: SaidMessage[] = [];
  let page = await messages.recent(place, pageSize, DASHBOARD);
  for (;;) {
    found.unshift(...page.messages.filter(keep));
    if (found.length >= limit || !page.older) return found.slice(-limit);
    page = await messages.before(place, page.older, pageSize, DASHBOARD);
  }
}

/**
 * A task chat's messages read from Chats, for Concierge: the same pages
 * `latestSaid` walks, from the lines Chats holds for the dashboard chat in
 * place of `rome_agent_messages`. Only the reads Concierge makes. A message's
 * text is its text parts without the narration that led to an answer, as
 * Concierge reads it from the legacy table. The page cursor is opaque, and
 * names Chats' line. Vocabulary: docs/domains/chats.md.
 */
export function chatsTaskChatMessages(db: DrizzleDb): Pick<MessageRepository, "recent" | "before"> {
  const lines = new ChatLines(db);
  const turns = new TurnLinks(db);
  const page = (
    place: Place,
    limit: number,
    before?: { readonly at: Date; readonly id: string },
  ): MessagePage => {
    const chat = storedPlace(db, place);
    if (!chat) return { messages: [], older: null };
    const read = lines.read(chat, {
      before: before ? { at: before.at, id: Number(before.id) } : null,
      limit,
    });
    const links = turns.turnsOf(read.messages.map((line) => line.id));
    return {
      messages: read.messages.map((line) => saidIn(place, line, links.get(line.id))),
      older: read.older ? { at: read.older.at, id: String(read.older.id) } : null,
    };
  };
  return {
    recent: async (place, limit) => page(place, limit),
    before: async (place, cursor, limit) => page(place, limit, cursor),
  };
}

/** A widget an agent showed itself with `show_card`. */
export type AgentCardPart = Extract<MessagePart, { type: "widget" }>;

/** What Concierge reads of a task chat's widgets. */
export interface TaskChatCards {
  /**
   * The widget the agent showed itself last in the turn that said message
   * `messageId` of task chat `place`, or null: a report's numbers that go
   * with its conclusion. The last, since an agent that shows a second one
   * corrects the first. It is checked again, so a forward never carries more
   * than `show_card` lets an agent show.
   */
  cardBeside(place: Place, messageId: string): Promise<AgentCardPart | null>;
}

export function chatsTaskChatCards(db: DrizzleDb): TaskChatCards {
  const lines = new ChatLines(db);
  const turns = new TurnLinks(db);
  return {
    async cardBeside(place, messageId) {
      const chat = storedPlace(db, place);
      if (!chat) return null;
      // A turn's widget comes just before its answer, so the newest page holds it.
      const { messages } = lines.read(chat, { limit: MAX_READ_LIMIT });
      const links = turns.turnsOf(messages.map((line) => line.id));
      const said = messages.find((line) => line.key === messageId);
      const turnId = said ? links.get(said.id)?.turnId : null;
      if (!turnId) return null;
      const cards = messages
        .filter((line) => {
          const link = links.get(line.id);
          return line.direction === "fromRome" && link?.role === "answer" && link.turnId === turnId;
        })
        .flatMap((line) => agentCardsIn(line.parts));
      return cards.at(-1) ?? null;
    },
  };
}

function agentCardsIn(parts: string): AgentCardPart[] {
  let read: unknown;
  try {
    read = JSON.parse(parts);
  } catch {
    return [];
  }
  if (!Array.isArray(read)) return [];
  return read.filter(
    (part): part is AgentCardPart =>
      part?.type === "widget" &&
      part.appId === SHOW_CARD_APP_ID &&
      "ui" in part &&
      part.bind === undefined &&
      checkShowCard(part.ui).length === 0,
  );
}

/** The place Chats holds for `place`, or null when it holds no such chat. */
function storedPlace(db: DrizzleDb, place: Place) {
  const [chat] = db.all<{ id: number }>(sql`
    SELECT id FROM chats WHERE platform = ${place.chat.platform} AND key = ${place.chat.id}
  `);
  return chat ? placeInChat({ platform: place.chat.platform, id: chat.id }, place.threadId) : null;
}

/** Chats' line as Concierge reads a message. A line that prompted a turn is
 *  input to the task, also Concierge's own follow-up, which one of Rome's
 *  agents said; any other line from Rome is the task's. */
function saidIn(place: Place, line: StoredLine, link: TurnLink | undefined): SaidMessage {
  return {
    id: line.key,
    direction: link?.role === "prompt" ? "toRome" : line.direction,
    place,
    ...(line.senderName === undefined ? {} : { senderName: line.senderName }),
    body: { text: messageContentText(line.parts) ?? "" },
    at: line.at,
    ...(line.chatThread === undefined ? {} : { chatThread: line.chatThread }),
  };
}
