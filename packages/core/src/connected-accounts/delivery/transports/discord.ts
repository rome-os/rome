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
  /** Waits before a create is sent again. Absent, it waits in real time. */
  sleep?(ms: number): Promise<void>;
}

/** How long a create waits before each time it is sent again after it failed
 *  to connect. */
const RESEND_DELAYS_MS = [250, 1000];

/**
 * Reply delivery over Discord's REST API. A message holds Markdown, as a whole
 * reply does, and does not point at the user's message, since a whole reply
 * does not either. Discord allows any number of edits.
 *
 * discord.js sends a request again when it times out, its connection resets,
 * or Discord answers with a server error, a create included. Each create
 * carries a nonce Discord enforces, so a create sent again returns the message
 * the first one made instead of posting it twice. The transport relies on that
 * itself: a create that failed to connect is sent again with the same nonce,
 * so a short outage at the start of a reply does not lose it. Only the last
 * attempt's error reaches the transport, so a create that still fails to
 * connect after those resends is unknown: an earlier attempt may have posted
 * it.
 */
export function discordTransport({
  rest,
  place,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: DiscordTransportOptions): DeliveryTransport {
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
      const body = {
        content: text,
        nonce: randomBytes(12).toString("base64url"),
        enforce_nonce: true,
      };
      const post = () =>
        call(async () => {
          const sent = (await rest.post(Routes.channelMessages(target), { body })) as {
            id: string;
            channel_id: string;
          };
          return { messageId: sent.id, chatId: sent.channel_id };
        });
      let resends = 0;
      for (;;) {
        try {
          return await post();
        } catch (error) {
          const failure = error as DeliveryFailure;
          if (failure.kind !== "unavailable") throw failure;
          const delay = RESEND_DELAYS_MS[resends++];
          if (delay === undefined) throw new DeliveryFailure("unknown", failure.message);
          await sleep(delay);
        }
      }
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
    // discord.js raises this for any refusal, with the response body as it
    // came. A body that is not Discord's JSON error came from something in
    // front of Discord, such as Cloudflare's HTML page, and the write may
    // still have reached Discord.
    if (!isDiscordError(error.rawError)) return new DeliveryFailure("unknown", message);
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

/** Whether a response body is the JSON error Discord's API answers with. */
function isDiscordError(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { message?: unknown }).message === "string" &&
    typeof (body as { code?: unknown }).code === "number"
  );
}
