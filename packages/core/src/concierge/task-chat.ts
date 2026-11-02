// Reading a task chat the way Concierge does: through the place its session
// stands in on the dashboard.

import type { SaidMessage } from "../chats/message.js";
import type { MessageRepository } from "../chats/message-repository.js";
import type { Place } from "../chats/place.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";

export const MAX_READ_LIMIT = 30;

/** The dashboard chat task chat `sessionId` stands in. A task chat is a
 *  dashboard session, so its chat is the one its seat names. */
export async function taskChatPlace(
  seats: Pick<WebChatRepository, "seatOf">,
  sessionId: string,
): Promise<Place> {
  const seat = await seats.seatOf(sessionId);
  if (!seat) throw new Error(`No task chat ${sessionId}`);
  return seat.place;
}

export const hasText = (message: SaidMessage) => message.body.text.trim() !== "";

/** The newest `limit` messages of a place that `keep` keeps, oldest first,
 *  paging back past the rest, such as messages that carry only cards. */
export async function latestSaid(
  messages: Pick<MessageRepository, "read">,
  place: Place,
  limit: number,
  keep: (message: SaidMessage) => boolean,
): Promise<SaidMessage[]> {
  const pageSize = Math.max(limit, MAX_READ_LIMIT);
  const found: SaidMessage[] = [];
  let page = await messages.read(place, { limit: pageSize });
  for (;;) {
    found.unshift(...page.messages.filter(keep));
    if (found.length >= limit || !page.older) return found.slice(-limit);
    page = await messages.read(place, { before: page.older, limit: pageSize });
  }
}
