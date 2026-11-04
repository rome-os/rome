// Reading the messages on record in a place, a page at a time. Vocabulary:
// docs/domains/chats.md#message.

import type { Via } from "./events.js";
import type { SaidMessage } from "./message.js";
import type { Place } from "./place.js";

/** A position in a place's messages, oldest to newest. Opaque to callers,
 *  which hand back the one a page answered. */
export interface MessageCursor {
  readonly at: Date;
  readonly id: string;
}

/**
 * Some of a place's messages, oldest first. `older` is where the messages
 * before these begin, for {@link MessageRepository.before}, and null when
 * none are older.
 */
export interface MessagePage {
  readonly messages: readonly SaidMessage[];
  readonly older: MessageCursor | null;
}

export interface MessageRepository {
  /**
   * The newest `limit` messages on record in `place`, oldest first. A place
   * Rome holds no messages in answers an empty page. Today's storage keeps no
   * delivery, so an agent's reply whose send is pending or was refused is
   * read too (see {@link SaidMessage}).
   *
   * `via` is the one of Rome's accounts reading, over today's storage, and
   * the place reads as that account heard it. Absent, a group reads as one
   * chat across every account in it, and a direct message reads only while
   * one account holds it, since its address alone may name a direct message
   * with each of Rome's accounts.
   */
  recent(place: Place, limit: number, via?: Pick<Via, "channel">): Promise<MessagePage>;

  /** The `limit` messages said in `place` just before `cursor`, oldest
   *  first, by the same rule as {@link recent}. */
  before(
    place: Place,
    cursor: MessageCursor,
    limit: number,
    via?: Pick<Via, "channel">,
  ): Promise<MessagePage>;
}
