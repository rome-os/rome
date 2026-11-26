// Answering a sender nobody in Rome holds with the way to connect their
// account. Vocabulary: docs/domains/participation.md#entry.

import type { ConnectionRegistry } from "../../connections/registry.js";
import { PrivateMessageRefused } from "../../connections/types.js";
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
 * visible reply otherwise or when the platform refuses the private message:
 * the link carries no secret.
 *
 * At most one answer goes to an account in 24 hours. A visible answer also
 * waits for 10 minutes after the last visible answer in the same chat, so a
 * shared chat does not fill with them; a direct message counts as a chat too.
 * A private answer adds nothing to the chat and is not held back by it. When
 * the chat limit holds a visible answer back, nothing is sent and the account
 * keeps its 24 hours, so a later message from it is answered. The record is
 * kept in memory, so a restart forgets it and one more answer may be sent.
 * With no public origin nothing is sent. The returned function never rejects:
 * a failed send is logged and not tried again.
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
    if (accounts.recent(account, at)) return;
    // Each limit is taken before its send, so a second message arriving during
    // the send is not answered too.
    accounts.take(account, at);

    const text = unknownSenderAnswer(`${origin}${CONNECT_ACCOUNT_PATH}`);
    try {
      const connection = deps.registry.get(message.connectionId);
      const reply = { replyToMessageId: message.platformMessageId };
      const visibly = async () => {
        const visibleAt = now();
        if (chats.recent(chat, visibleAt)) {
          accounts.release(account);
          return;
        }
        chats.take(chat, visibleAt);
        await sendThrough(connection, message.chatId, { text, ...reply });
      };
      const privately =
        message.addressing === "direct"
          ? undefined
          : connection.withTalker((talker) =>
              talker.privateMessaging?.sendOnlyTo(message.chatId, message.sender.id, text, reply),
            );
      if (!privately) {
        await visibly();
      } else {
        try {
          await privately;
        } catch (error) {
          if (!(error instanceof PrivateMessageRefused)) throw error;
          await visibly();
        }
      }
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

  /** Forgets `key`, for an answer that was taken but never sent. */
  release(key: string): void {
    this.at.delete(key);
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
