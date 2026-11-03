// Reading a task chat the way Concierge does: through the dashboard channel's
// Messages.

import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { messageContentText } from "../channels/messages-agent.js";
import type { SaidMessage as StoredLine } from "../chats/storage/message.js";
import { MessageRepository as ChatLines } from "../chats/storage/message-repository.js";
import { placeIn as placeInChat } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import { TurnLinks, type TurnLink } from "../sessions/turn-links.js";
import { WEBCHAT_CHANNEL } from "../channels/webchat-channel.js";
import type { SaidMessage } from "../chats/message.js";
import type { MessagePage, MessageRepository } from "../chats/message-repository.js";
import { chatKey, placeIn, type Place } from "../chats/place.js";
import { DASHBOARD_PLATFORM } from "../connections/send.js";

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
    const [chat] = db.all<{ id: number }>(sql`
      SELECT id FROM chats WHERE platform = ${place.chat.platform} AND key = ${place.chat.id}
    `);
    if (!chat) return { messages: [], older: null };
    const read = lines.read(
      placeInChat({ platform: place.chat.platform, id: chat.id }, place.threadId),
      {
        before: before ? { at: before.at, id: Number(before.id) } : null,
        limit,
      },
    );
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
  };
}
