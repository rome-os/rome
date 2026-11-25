// Reading a task chat the way Concierge does: through the dashboard channel's
// Messages.

import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { type AgentCardPart, agentCardIn } from "../chats/agent-card.js";
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

/** An agent card a task chat showed, with the id of the message that holds
 *  it. Each card is a message of its own, so the id names the card in its
 *  chat. */
export interface CardMessage {
  readonly id: string;
  readonly card: AgentCardPart;
}

/** A task chat's final answer, by the turn that said Rome's latest message
 *  with text or a card: that turn's latest text, and every agent card it
 *  showed, oldest first. A turn that showed only cards has no text, and the
 *  cards are its answer. A message no turn is linked to, such as an older
 *  row, answers alone. */
export interface FinalAnswer {
  readonly answer?: SaidMessage;
  readonly cards: readonly CardMessage[];
}

/** The final answer of a task chat, or null for none yet. Turns are told
 *  apart by the turn that said each message, never by where a prompt sits:
 *  a defer wake-up or an approval's resumption answers with no prompt of its
 *  own, and a card-only turn has no text to stop at. */
export async function finalAnswer(
  messages: Pick<MessageRepository, "recent" | "before">,
  place: Place,
): Promise<FinalAnswer | null> {
  let turn: string | undefined;
  let answer: SaidMessage | undefined;
  const cards: CardMessage[] = [];
  const found = (): FinalAnswer => ({ ...(answer ? { answer } : {}), cards: [...cards].reverse() });
  let page = await messages.recent(place, MAX_READ_LIMIT, DASHBOARD);
  for (;;) {
    // Newest message first.
    for (const message of [...page.messages].reverse()) {
      if (message.direction !== "fromRome" || (!message.card && !hasText(message))) continue;
      if (answer || cards.length > 0) {
        // Only the latest answering turn counts.
        if (!turn || message.turnId !== turn) return found();
      } else {
        turn = message.turnId;
      }
      if (message.card) cards.push({ id: message.id, card: message.card });
      else answer ??= message;
      if (!turn) return found();
    }
    if (!page.older) return answer || cards.length > 0 ? found() : null;
    page = await messages.before(place, page.older, MAX_READ_LIMIT, DASHBOARD);
  }
}

/** What Concierge reads of the chats it works in: their messages, and the
 *  agent card a dashboard chat's message holds. */
export interface TaskChatMessages extends Pick<MessageRepository, "recent" | "before"> {
  /** The agent card in the message keyed `id` and the id of the dashboard chat
   *  it is in, or null when no such message holds one. A key is unique only
   *  in its chat, so a key two chats share answers the newest. */
  cardIn(id: string): Promise<{ chatId: string; card: AgentCardPart } | null>;
}

/**
 * A task chat's messages read from Chats, for Concierge: the same pages
 * `latestSaid` walks, from the lines Chats holds for the dashboard chat in
 * place of `rome_agent_messages`. Only the reads Concierge makes. A message's
 * text is its text parts without the narration that led to an answer, as
 * Concierge reads it from the legacy table. The page cursor is opaque, and
 * names Chats' line. Vocabulary: docs/domains/chats.md.
 */
export function chatsTaskChatMessages(db: DrizzleDb): TaskChatMessages {
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
    // By the message key's own index. Only a line Rome said holds a card.
    cardIn: async (id) => {
      const rows = db.all<{ chat: string; parts: string }>(sql`
        SELECT c.key AS chat, m.parts AS parts FROM chat_messages m
        JOIN chats c ON c.id = m.chat_id
        WHERE m.key = ${id} AND c.platform = ${DASHBOARD_PLATFORM} AND m.sender_agent IS NOT NULL
        ORDER BY m.id DESC LIMIT 1
      `);
      const card = rows[0] && agentCardOf(rows[0].parts);
      return rows[0] && card ? { chatId: rows[0].chat, card } : null;
    },
  };
}

/** Chats' line as Concierge reads a message. A line that prompted a turn is
 *  input to the task, also Concierge's own follow-up, which one of Rome's
 *  agents said; any other line from Rome is the task's. */
function saidIn(place: Place, line: StoredLine, link: TurnLink | undefined): SaidMessage {
  const card = agentCardOf(line.parts);
  return {
    id: line.key,
    direction: link?.role === "prompt" ? "toRome" : line.direction,
    place,
    ...(line.saidBy && !line.saidBy.agent ? { saidBy: { account: line.saidBy.account } } : {}),
    ...(line.senderName === undefined ? {} : { senderName: line.senderName }),
    body: { text: messageContentText(line.parts) ?? "" },
    at: line.at,
    ...(line.chatThread === undefined ? {} : { chatThread: line.chatThread }),
    ...(card ? { card } : {}),
    ...(link?.turnId ? { turnId: link.turnId } : {}),
  };
}

function agentCardOf(parts: string): AgentCardPart | undefined {
  try {
    const parsed: unknown = JSON.parse(parts);
    return Array.isArray(parsed) ? agentCardIn(parsed) : undefined;
  } catch {
    return undefined;
  }
}
