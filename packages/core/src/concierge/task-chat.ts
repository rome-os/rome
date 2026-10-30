// Reading a task chat the way Concierge does: through the dashboard channel's
// Messages.

import type { ChatId } from "@rome-os/app-runtime";
import { WEBCHAT_CHANNEL } from "../channels/webchat-channel.js";
import type { SaidMessage } from "../chats/message.js";
import type { MessageRepository } from "../chats/message-repository.js";
import { chatKey, placeIn, type Place } from "../chats/place.js";
import { DASHBOARD_PLATFORM } from "../chats/send.js";

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
