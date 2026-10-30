import { randomBytes } from "node:crypto";
import { DiscordAPIError, HTTPError, type REST, Routes } from "discord.js";
import { DeliveryFailure, type DeliveryTransport, type TextCodec } from "../types.js";
import { renderFenced } from "./fenced-markdown.js";
import { neverConnected } from "./network.js";

export interface DiscordTransportOptions {
  /** The REST client of the adapter's bot, so a reply's writes share the rate
   *  limits its whole sends meet. */
  rest: REST;
  /** The channel a reply to `replyTo` in `chat` goes to, as a whole reply is
   *  placed: a thread on the user's message where the chat's settings thread
   *  replies, otherwise the chat. */
  place(chat: string, replyTo: string): Promise<string>;
}

/**
 * Reply delivery over Discord's REST API. A message holds Markdown, as a whole
 * reply does, and does not point at the user's message, since a whole reply
 * does not either. Discord allows any number of edits.
 *
 * discord.js sends a request again when it times out, its connection resets,
 * or Discord answers with a server error, a create included. Each create
 * carries a nonce Discord enforces, so a create sent again returns the message
 * the first one made instead of posting it twice. Only the last attempt's
 * error reaches the transport, so a create that fails to connect is unknown:
 * an earlier attempt may have posted it, and a new create has a new nonce.
 */
export function discordTransport({ rest, place }: DiscordTransportOptions): DeliveryTransport {
  return {
    capabilities: {
      maxPartLength: 2000,
      edit: true,
      // Discord allows a bot 50 requests a second, and about 5 messages every
      // 5 seconds in one channel.
      budget: { burst: 50, refillMs: 20, conversationSpacingMs: 1000 },
    },
    codec: discordMarkdown,
    create: async (chat, text, replyTo) => {
      let target = chat;
      if (replyTo) {
        try {
          target = await place(chat, replyTo);
        } catch (error) {
          // Nothing of the reply was written yet, whatever the lookup's result.
          const failure = classify(error);
          throw failure.kind === "unknown"
            ? new DeliveryFailure("unavailable", failure.message)
            : failure;
        }
      }
      const created = call(async () => {
        const sent = (await rest.post(Routes.channelMessages(target), {
          body: {
            content: text,
            nonce: randomBytes(12).toString("base64url"),
            enforce_nonce: true,
          },
        })) as { id: string; channel_id: string };
        return { messageId: sent.id, chatId: sent.channel_id };
      });
      return created.catch((failure: DeliveryFailure) => {
        throw failure.kind === "unavailable"
          ? new DeliveryFailure("unknown", failure.message)
          : failure;
      });
    },
    edit: (receipt, text) =>
      call(async () => {
        await rest.patch(Routes.channelMessage(receipt.chatId, receipt.messageId), {
          body: { content: text },
        });
      }),
  };
}

/**
 * Markdown as a whole reply sends it, which Discord shows natively. Code that
 * runs past the end of a message is closed there and opened again in the next,
 * since Discord shows an unclosed fence as text. Discord counts the length of
 * a message's content in characters, and UTF-16 code units never count fewer.
 */
export const discordMarkdown: TextCodec = {
  render: (source, _settled, context) => renderFenced(source, context),
  measure: (rendered) => rendered.length,
};

async function call<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw classify(error);
  }
}

function classify(error: unknown): DeliveryFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof DiscordAPIError) {
    // Only a 401 means the token is dead. A 403 is a refusal in one channel,
    // such as a user who closed their DMs, and the token still works.
    if (error.status === 401) return new DeliveryFailure("unauthorized", message);
    if (error.status === 429) return new DeliveryFailure("rate-limited", message, 1000);
    if (error.status >= 500) return new DeliveryFailure("unknown", message);
    // Anything else is a refusal, including an edit to a message the user
    // deleted (Unknown Message).
    return new DeliveryFailure("rejected", message);
  }
  // A server error that outlasted discord.js's own retries. One of them may
  // have gone through.
  if (error instanceof HTTPError) return new DeliveryFailure("unknown", message);
  // A connection that never opened did not carry the request, so it may be
  // sent again. Any other failure may have come after the request was written.
  if (neverConnected(error)) return new DeliveryFailure("unavailable", message);
  return new DeliveryFailure("unknown", message);
}
