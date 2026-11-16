// Builds the snapshot a WebChat reply stores and quotes to the agent.

import type { ReplyToPart } from "@rome/api-types/chat";
import { replyContextLine } from "../../agent/index.js";
import type { ApiDeps } from "../deps.js";
import { taskCardLine } from "../../concierge/task-cards.js";
import { resolveChatSenders } from "./chat-senders.js";
import { promptSafeSourceName } from "../../webchat/automated-source.js";
import { quoteSpans, textSpans, truncateQuote, type TextSpan } from "../../webchat/reply-quote.js";

export type ReplyResolution =
  | { ok: true; part: ReplyToPart; promptLine: string }
  | { ok: false; error: string };

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Looks up the replied-to message in `sessionId` and snapshots what the reply quotes.
 *
 * A user row quotes itself. An assistant row quotes itself when `ownRowOnly` is
 * set, which holds for an agent that speaks through one tool call per message,
 * and otherwise quotes the answer text of its whole turn: the turn's rows
 * without commentary, or all their text when nothing else remains. A
 * `quote` that is not a substring of that text, after whitespace
 * normalization, is rejected.
 */
export async function resolveReply(
  deps: Pick<
    ApiDeps,
    "db" | "settingsRepo" | "webchatRepo" | "agentLoader" | "appCatalog" | "concierge"
  >,
  input: { sessionId: string; messageId: string; quote?: string; ownRowOnly: boolean },
): Promise<ReplyResolution> {
  const { sessionId, messageId } = input;
  const target = await deps.webchatRepo.getReplyTarget(sessionId, messageId);
  if (!target) return { ok: false, error: "replyToMessageId is not a message of this chat" };

  const { concierge } = deps;
  // Read only for an `ask` card, which quotes its question or approval.
  const cardLine = concierge
    ? (chatId: string, waitedOn: Parameters<typeof taskCardLine>[2]) =>
        taskCardLine(concierge.taskCardSources(), chatId, waitedOn)
    : undefined;
  // The quote the guardian sees, and the text the agent reads, which names a card's chat.
  const answerOf = (spans: TextSpan[]) => {
    const answer = spans.filter((span) => !span.commentary);
    return answer.length > 0 ? answer : spans;
  };
  const join = (spans: TextSpan[]) => spans.map((span) => span.text).join("\n\n");
  let rows: { content: string }[] = [target];
  if (target.role === "assistant" && target.turnId && !input.ownRowOnly) {
    rows = (await deps.webchatRepo.getTurnChatMessages(sessionId, target.turnId)).filter(
      (row) => row.role === "assistant",
    );
  }
  const whole = rows.length === 1 && rows[0] === target;
  const shownSpans = (
    await Promise.all(rows.map((row) => quoteSpans(row.content, cardLine)))
  ).flat();
  const readSpans = rows.flatMap((row) => textSpans(row.content));
  const full = join(whole ? shownSpans : answerOf(shownSpans));
  const agentFull = join(whole ? readSpans : answerOf(readSpans));
  if (!full.trim()) return { ok: false, error: "The replied-to message has no text to quote" };

  let text = full;
  if (input.quote !== undefined) {
    const quote = input.quote.trim();
    if (!quote || !normalizeWhitespace(full).includes(normalizeWhitespace(quote))) {
      return { ok: false, error: "replyQuote is not part of the replied-to message" };
    }
    text = quote;
  }
  const agentText = truncateQuote(input.quote !== undefined ? text : agentFull);
  text = truncateQuote(text);

  let author: ReplyToPart["author"] = target.role === "user" ? "guardian" : "agent";
  let name: string | undefined;
  if (target.role === "user") {
    const senders = await resolveChatSenders(
      deps,
      new Map(target.actor ? [[target.id, target.actor]] : []),
      new Map(target.senderId ? [[target.id, target.senderId]] : []),
    );
    const sender = senders.get(target.id);
    if (sender?.kind === "automated") author = "automated";
    name = sender?.name ?? (author === "automated" ? "Automation" : undefined);
  }
  return {
    ok: true,
    part: { type: "reply_to", messageId, author, ...(name ? { name } : {}), text },
    promptLine: replyContextLine({
      createdAt: target.createdAt,
      sender:
        author === "automated" && name
          ? promptSafeSourceName(name)
          : (name ?? (author === "guardian" ? "Guardian" : "Rome")),
      text: agentText,
    }),
  };
}
