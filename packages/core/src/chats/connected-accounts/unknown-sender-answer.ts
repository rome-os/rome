// Answering a sender nobody in Rome holds with the way to connect their
// account. Vocabulary: docs/domains/participation.md#entry.

import type { ConnectionRegistry } from "../../connections/registry.js";
import { createLogger } from "../../logger.js";
import type { UnknownSenderMessage } from "../../participation/unknown-senders.js";
import { sendThrough } from "./connection-ports.js";

const log = createLogger("unknown-sender-answer");

/** The dashboard page where a person gets a code for their account. */
export const CONNECT_ACCOUNT_PATH = "/connect-account";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** How many accounts and chats each record keeps before it drops the one
 *  answered longest ago. */
export const ANSWERED_KEPT = 1_000;

/** The answer, with this Rome's connect page as `link`. */
export function unknownSenderAnswer(link: string): string {
  return (
    "This account is not connected to anyone on this Rome yet. " +
    `If you use this Rome, open ${link}, get a code, and send it to me in a direct message.`
  );
}

export interface UnknownSenderAnswerDeps {
  registry: Pick<ConnectionRegistry, "get">;
  /** This Rome's public dashboard origin, or null when none is configured.
   *  Read on each message. */
  publicOrigin(): string | null;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?(): number;
}

/**
 * Builds the `tell` that answers a sender nobody holds with the link to the
 * connect page, in the chat the message came from. In a shared chat the answer
 * goes to the sender alone where the connection's kind offers that, and is a
 * visible reply otherwise: the link carries no secret.
 *
 * At most one answer goes to an account in 24 hours, and at most one to a chat
 * in 10 minutes. The record is kept in memory, so a restart forgets it and one
 * more answer may be sent. With no public origin nothing is sent. The returned
 * function never rejects: a failed send is logged and not tried again.
 */
export function answerUnknownSenders(
  deps: UnknownSenderAnswerDeps,
): (message: UnknownSenderMessage) => Promise<void> {
  const now = deps.now ?? Date.now;
  const accounts = new Answered(DAY_MS);
  const chats = new Answered(TEN_MINUTES_MS);
  let reportedNoOrigin = false;

  return async (message) => {
    const origin = deps.publicOrigin();
    if (!origin) {
      if (!reportedNoOrigin) {
        reportedNoOrigin = true;
        log.debug("no public origin, so a sender nobody holds is not answered");
      }
      return;
    }
    const at = now();
    const account = `${message.sender.platform}\n${message.sender.id}`;
    const chat = `${message.connectionId}\n${message.chatId}`;
    if (accounts.recent(account, at) || chats.recent(chat, at)) return;
    // Taken before sending, so a second message arriving during the send is
    // not answered too.
    accounts.take(account, at);
    chats.take(chat, at);

    const text = unknownSenderAnswer(`${origin}${CONNECT_ACCOUNT_PATH}`);
    try {
      const connection = deps.registry.get(message.connectionId);
      const reply = { replyToMessageId: message.platformMessageId };
      const privately =
        message.addressing === "direct"
          ? undefined
          : connection.withTalker((talker) =>
              talker.privateMessaging?.sendOnlyTo(message.chatId, message.sender.id, text, reply),
            );
      await (privately ?? sendThrough(connection, message.chatId, { text, ...reply }));
    } catch (error) {
      log.warn("could not answer a sender nobody holds", {
        messageId: message.messageId,
        connectionId: message.connectionId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  };
}

/** When each key was last answered, for one window, holding at most
 *  {@link ANSWERED_KEPT} keys. */
class Answered {
  private readonly at = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  recent(key: string, now: number): boolean {
    const at = this.at.get(key);
    return at !== undefined && now - at < this.windowMs;
  }

  take(key: string, now: number): void {
    // Re-inserted so the map stays in answering order, oldest first.
    this.at.delete(key);
    this.at.set(key, now);
    for (const [oldest, at] of this.at) {
      if (this.at.size <= ANSWERED_KEPT && now - at < this.windowMs) break;
      this.at.delete(oldest);
    }
  }
}
