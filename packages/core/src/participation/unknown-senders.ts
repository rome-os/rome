// Telling what someone nobody in Rome holds said to it, once the message is on
// record. Vocabulary: docs/domains/participation.md#entry.

import type { ChatId, InboundEvent, MessageAddressing } from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import { arrivalOf } from "./entrance.js";
import type { EntryAccount } from "./entry.js";

const log = createLogger("unknown-senders");

/** How many told messages are remembered. Another of Rome's accounts hears a
 *  message moments after the first, so only the latest matter. */
const TOLD_KEPT = 1_000;

/** A recorded message addressed to Rome, from an account nobody holds. */
export interface UnknownSenderMessage {
  /** The message's id in Rome's records. */
  readonly messageId: number;
  /** The account that said it. */
  readonly sender: EntryAccount;
  /** The connection it arrived on, and its channel's name. */
  readonly connectionId: string;
  readonly channel: string;
  /** Where it was said, as a send on the connection takes it. */
  readonly chatId: ChatId;
  /** The platform's id for it, which an answer may reply to. */
  readonly platformMessageId: string;
  /** How it addressed Rome's account. */
  readonly addressing: Exclude<MessageAddressing, "ambient">;
}

export interface UnknownSendersDeps {
  /** Whether `account` is one of Rome's, such as another of its bots in a group. */
  isRomes(account: EntryAccount): boolean;
  /** Whether Rome speaks on the connection as an account of its own, rather
   *  than as the guardian's. */
  isOwnAccount(connectionId: string): boolean;
  /** Called in the background, at most once for each message. Absent, nobody
   *  is told. */
  tell?(message: UnknownSenderMessage): Promise<void>;
}

/**
 * Takes each message on record as one of Rome's accounts heard it, and tells of
 * those from a sender nobody holds. Nothing waits for `tell`, and a failure is
 * logged and not tried again.
 */
export function unknownSenders(
  deps: UnknownSendersDeps,
): (
  recorded: { id: number; saidBy: { account: EntryAccount } },
  event: Pick<InboundEvent, "message" | "ref">,
) => void {
  const told = new Set<number>();
  return (recorded, event) => {
    if (!deps.tell) return;
    const arrival = arrivalOf(event);
    if (arrival?.entry.kind !== "unknown" || arrival.automated) return;
    const { message, ref } = event;
    const { addressing } = message;
    if (addressing === undefined || addressing === "ambient") return;
    if (told.has(recorded.id)) return;
    const sender = recorded.saidBy.account;
    const tell = async () => {
      if (!deps.isOwnAccount(ref.connectionId) || deps.isRomes(sender)) return;
      told.add(recorded.id);
      for (const oldest of told) {
        if (told.size <= TOLD_KEPT) break;
        told.delete(oldest);
      }
      await deps.tell?.({
        messageId: recorded.id,
        sender,
        connectionId: ref.connectionId,
        channel: message.channel,
        chatId: ref.chatId,
        platformMessageId: message.messageId,
        addressing,
      });
    };
    tell().catch((error: unknown) => {
      log.warn("could not tell of a message from a sender nobody holds", {
        messageId: recorded.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    });
  };
}
