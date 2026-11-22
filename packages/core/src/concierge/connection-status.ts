// The status Rome derives for a guardian message (docs/domains/chats.md#status),
// as a chat on one of Rome's connected accounts shows it. The dashboard draws
// the status itself; a platform such as Discord or Slack draws none, so the
// account's own reaction on the message shows it: 👀 while the Concierge works
// on it, ⚠️ once that work failed, and none once it has no status.

import type { ConciergeMessageStatus } from "@rome/api-types/concierge";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-connection-status");

/** The reaction each status shows on a platform. */
const STATUS_REACTIONS: Readonly<Record<ConciergeMessageStatus, string>> = {
  working: "👀",
  failed: "⚠️",
};

export interface ConnectionStatusDeps {
  /** The chat on a connection `chatId` is, or null for any other chat. */
  chatOf: (chatId: string) => Promise<{ channel: string; threadId: string } | null>;
  add: (
    chat: { channel: string; threadId: string },
    messageKey: string,
    emoji: string,
  ) => Promise<void>;
  remove: (
    chat: { channel: string; threadId: string },
    messageKey: string,
    emoji: string,
  ) => Promise<void>;
}

export class ConnectionStatusMarks {
  /** The reaction each message shows for its status, by chat and message. */
  private readonly shown = new Map<string, string>();
  /** Each message's changes, one after the other, so an add never overtakes its removal. */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly deps: ConnectionStatusDeps) {}

  /** Message `messageKey` of chat `chatId` has status `status` now, or none. */
  statusChanged(
    chatId: string,
    messageKey: string,
    status: ConciergeMessageStatus | null,
  ): Promise<void> {
    const key = `${chatId}\u0000${messageKey}`;
    const next = (this.pending.get(key) ?? Promise.resolve())
      .then(() => this.show(key, chatId, messageKey, status))
      .catch((error: unknown) =>
        log.warn("message status not shown on its platform", {
          chatId,
          status,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    this.pending.set(key, next);
    void next.then(() => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    });
    return next;
  }

  private async show(
    key: string,
    chatId: string,
    messageKey: string,
    status: ConciergeMessageStatus | null,
  ): Promise<void> {
    const was = this.shown.get(key);
    const want = status ? STATUS_REACTIONS[status] : undefined;
    if (was === want) return;
    const chat = await this.deps.chatOf(chatId);
    if (!chat) return;
    if (was) {
      await this.deps.remove(chat, messageKey, was);
      this.shown.delete(key);
    }
    if (want) {
      await this.deps.add(chat, messageKey, want);
      this.shown.set(key, want);
    }
  }
}
