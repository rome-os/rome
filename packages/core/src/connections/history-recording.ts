// Recording what a platform's history sync reports, in Chats' own tables.
// Vocabulary: docs/domains/chats.md#message.
//
// A connection that syncs the platform's history, as WhatsApp does, hands over
// messages Rome did not hear as they arrived: ones said before the account was
// connected, and ones the guardian said on the account themselves, in the
// platform's own app. Each is recorded in its chat under the keys inbound
// recording (inbound-recording.ts) gives it, so a message heard both ways is
// recorded once. Nothing is raised for it: it is history, not something to
// answer.

import type { Account, Attachment, ChatId } from "@rome-os/app-runtime";
import type { ChatKind } from "../chats/storage/chat.js";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import { messageToRome } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import { createLogger } from "../logger.js";
import type { ChatAddresses } from "./chat-addresses.js";
import { directMessageAt, messageKeyAt } from "./chat-adapter.js";
import { chatKey, type ChatKey } from "./chat-ids.js";

const log = createLogger("history-recording");

/** A message a platform's history sync reports, as Rome's account heard it. */
export interface SyncedMessage {
  /** Where the platform says it was said: a group's id, or the other end of
   *  a direct message. */
  readonly address: string;
  readonly kind: ChatKind;
  /** The platform's id for the message. */
  readonly id: string;
  /** The account that said it: Rome's own account for a message the guardian
   *  said on it themselves. */
  readonly sender: { readonly id: string; readonly name?: string };
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly at: Date;
}

export interface HistoryRecordingDeps {
  /** Starts the chat a message is said in, or finds it. */
  chats: Pick<ChatRepository, "start">;
  messages: Pick<MessageRepository, "record">;
  /** Where a direct message is already reached at an address other than its
   *  other end, so a synced message lands in the chat Rome already holds. */
  addresses: Pick<ChatAddresses, "keyAt">;
}

/**
 * Records `synced`, which Rome's account `account` heard, each in its chat,
 * and answers how many were new. A message with neither text nor attachments
 * is skipped, as inbound recording skips it. A message that fails to record is
 * logged and the rest are still recorded.
 */
export function recordSynced(
  deps: HistoryRecordingDeps,
  account: Account,
  synced: readonly SyncedMessage[],
): number {
  let recorded = 0;
  for (const message of synced) {
    if (!message.text.trim() && (message.attachments?.length ?? 0) === 0) continue;
    try {
      const key = chatOf(deps, account, message);
      const chat = deps.chats.start(key, message.kind, null);
      const said = messageToRome({
        key: messageKeyAt(key, account.id, message.id),
        place: placeIn(chat.ref),
        saidBy: {
          account: { platform: account.platform, id: message.sender.id },
          ...(message.sender.name ? { name: message.sender.name } : {}),
        },
        body: { text: message.text, attachments: [...(message.attachments ?? [])] },
        at: message.at,
      });
      if (deps.messages.record(said) !== null) recorded += 1;
    } catch (error) {
      log.error("failed to record a synced message", {
        platform: account.platform,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return recorded;
}

/** The chat `message` was said in, keyed as inbound recording keys it. */
function chatOf(
  deps: Pick<HistoryRecordingDeps, "addresses">,
  account: Account,
  message: SyncedMessage,
): ChatKey {
  if (message.kind === "group") return chatKey(account.platform, message.address as ChatId);
  return directMessageAt(account, message.address, deps.addresses);
}
