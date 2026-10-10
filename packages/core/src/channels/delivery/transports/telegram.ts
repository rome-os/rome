import { type Api, GrammyError, HttpError } from "grammy";
import { DeliveryFailure, type DeliveryTransport, plainText } from "../types.js";

/**
 * Reply delivery over the Telegram Bot API. Text goes out plain, so a preview
 * that cuts Markdown in half never fails to parse. Telegram counts a message's
 * text in UTF-16 code units, which is what `plainText` measures.
 */
export function telegramTransport(api: Api): DeliveryTransport {
  return {
    capabilities: {
      maxPartLength: 4096,
      edit: true,
      // Telegram allows a bot about 30 messages a second across chats, about
      // one a second in a private chat, and 20 a minute in a group. Group and
      // channel chat ids are negative, and a channel can also be named by its
      // @username.
      budget: {
        burst: 30,
        refillMs: 34,
        conversationSpacingMs: (chat) =>
          chat.startsWith("-") || chat.startsWith("@") ? 3000 : 1000,
      },
    },
    codec: plainText,
    create: (chat, text, replyTo) =>
      call(async () => {
        const sent = await api.sendMessage(chat, text, {
          // The user can delete the message while a long run streams. The reply
          // is still worth sending, without the link to it.
          ...(replyTo
            ? {
                reply_parameters: {
                  message_id: Number(replyTo),
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        });
        return { messageId: String(sent.message_id), conversationId: String(sent.chat.id) };
      }),
    edit: (receipt, text) =>
      call(async () => {
        try {
          await api.editMessageText(receipt.conversationId, Number(receipt.messageId), text);
        } catch (error) {
          // The message already shows this text, which is what the edit asked for.
          if (error instanceof GrammyError && error.description.includes("message is not modified"))
            return;
          throw error;
        }
      }),
  };
}

async function call<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw classify(error);
  }
}

/** System errors that mean the connection to Telegram was never made. A reset
 *  or a timeout is not among them, since it can follow a request already sent. */
const NEVER_CONNECTED = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/** Whether the error, or a cause it wraps, is a failure to connect. */
function neverConnected(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 3 && cause && typeof cause === "object"; depth++) {
    const { code, cause: inner } = cause as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && NEVER_CONNECTED.has(code)) return true;
    cause = inner;
  }
  return false;
}

function classify(error: unknown): DeliveryFailure {
  if (error instanceof GrammyError) {
    if (error.error_code === 429)
      return new DeliveryFailure(
        "rate-limited",
        error.description,
        (error.parameters.retry_after ?? 1) * 1000,
      );
    // Only a 401 means the token is dead. A 403 is a refusal for one chat, such
    // as a user who blocked the bot, and the token still works.
    if (error.error_code === 401) return new DeliveryFailure("unauthorized", error.description);
    // A server error is a hiccup, and the write may have gone through before it.
    if (error.error_code >= 500) return new DeliveryFailure("unknown", error.description);
    return new DeliveryFailure("rejected", error.description);
  }
  if (error instanceof HttpError) {
    // A connection that never opened did not carry the request, so it may be
    // sent again. Any other failure may have come after the request was written.
    if (neverConnected(error.error)) return new DeliveryFailure("unavailable", error.message);
    return new DeliveryFailure("unknown", error.message);
  }
  return new DeliveryFailure("unknown", error instanceof Error ? error.message : String(error));
}
