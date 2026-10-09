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
      // channel chat ids are negative.
      budget: {
        burst: 30,
        refillMs: 34,
        conversationSpacingMs: (chat) => (chat.startsWith("-") ? 3000 : 1000),
      },
    },
    codec: plainText,
    create: (chat, text, replyTo) =>
      call(async () => {
        const sent = await api.sendMessage(chat, text, {
          ...(replyTo ? { reply_parameters: { message_id: Number(replyTo) } } : {}),
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
    return new DeliveryFailure("rejected", error.description);
  }
  // The request may have reached Telegram before the connection failed.
  if (error instanceof HttpError) return new DeliveryFailure("unknown", error.message);
  return new DeliveryFailure("unknown", error instanceof Error ? error.message : String(error));
}
