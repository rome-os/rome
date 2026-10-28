// Builds the snapshot a WebChat reply stores and quotes to the agent.

import { REPLY_TO_TEXT_MAX_LENGTH, type ReplyToPart } from "@rome/api-types/chat";
import { replyContextLine } from "../../core/reply-context.js";
import type { ApiDeps } from "../deps.js";
import { resolveChatSenders } from "./chat-senders.js";

export type ReplyResolution =
  | { ok: true; part: ReplyToPart; promptLine: string }
  | { ok: false; error: string };

interface TextSpan {
  text: string;
  commentary: boolean;
}

/** The readable text of a stored message: text parts, and a task chat card as one line. */
function textSpans(content: string): TextSpan[] {
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part): TextSpan[] => {
    if (!part || typeof part !== "object") return [];
    const { type, content: text, title, chatId, turnPhase } = part as Record<string, unknown>;
    if (type === "text" && typeof text === "string" && text.trim()) {
      return [{ text, commentary: turnPhase === "commentary" }];
    }
    if (type === "task_chat" && typeof title === "string" && typeof chatId === "string") {
      return [{ text: `[Task chat] ${title} (chat ${chatId})`, commentary: false }];
    }
    return [];
  });
}

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

function truncate(text: string): string {
  if (text.length <= REPLY_TO_TEXT_MAX_LENGTH) return text;
  let cut = text.slice(0, REPLY_TO_TEXT_MAX_LENGTH - 1);
  // A cut between the halves of a surrogate pair would store a broken character.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

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
  deps: Pick<ApiDeps, "db" | "settingsRepo" | "webchatRepo">,
  input: { sessionId: string; messageId: string; quote?: string; ownRowOnly: boolean },
): Promise<ReplyResolution> {
  const { sessionId, messageId } = input;
  const target = await deps.webchatRepo.getReplyTarget(sessionId, messageId);
  if (!target) return { ok: false, error: "replyToMessageId is not a message of this chat" };

  let spans = textSpans(target.content);
  if (target.role === "assistant" && target.turnId && !input.ownRowOnly) {
    const rows = await deps.webchatRepo.getTurnChatMessages(sessionId, target.turnId);
    const turnSpans = rows.flatMap((row) =>
      row.role === "assistant" ? textSpans(row.content) : [],
    );
    const answer = turnSpans.filter((span) => !span.commentary);
    spans = answer.length > 0 ? answer : turnSpans;
  }
  const full = spans.map((span) => span.text).join("\n\n");
  if (!full.trim()) return { ok: false, error: "The replied-to message has no text to quote" };

  let text = full;
  if (input.quote !== undefined) {
    const quote = input.quote.trim();
    if (!quote || !normalizeWhitespace(full).includes(normalizeWhitespace(quote))) {
      return { ok: false, error: "replyQuote is not part of the replied-to message" };
    }
    text = quote;
  }
  text = truncate(text);

  const author = target.role === "user" ? "guardian" : "agent";
  let name: string | undefined;
  if (target.role === "user" && target.actor) {
    const senders = await resolveChatSenders(deps, new Map([[target.id, target.actor]]));
    name = senders.get(target.id)?.name ?? undefined;
  }
  return {
    ok: true,
    part: { type: "reply_to", messageId, author, ...(name ? { name } : {}), text },
    promptLine: replyContextLine({
      createdAt: target.createdAt,
      sender: name ?? (author === "guardian" ? "Guardian" : "Assistant"),
      text,
    }),
  };
}
