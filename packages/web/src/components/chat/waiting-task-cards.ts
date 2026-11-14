import type { TaskCard } from "@rome/api-types/chat";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatMessage } from "@/lib/chat-types";
import { cardKey } from "./entries/live-task-cards";

/**
 * Whether a question or approval card waits on its owner now, read from the
 * card alone: it has no outcome, its wait did not run out, and its task did not
 * end with it open (`closed`, which Rome fills in from the task). Any other
 * card is read-only.
 */
export function cardWaits(
  card: TaskCard | undefined,
): card is Exclude<TaskCard, { kind: "unavailable" }> {
  return (
    card !== undefined &&
    card.kind !== "unavailable" &&
    !card.outcome &&
    !(card.kind === "question" && card.expired) &&
    card.closed !== true
  );
}

/**
 * The messages of a Concierge chat whose card waits on its owner, read from
 * the cards Rome filled in and the live events that settled them since. Only
 * the newest card of each task chat counts, as only that one takes an answer.
 * A card still mounting counts as soon as its message is here.
 */
export function waitingTaskCardMessages(
  messages: readonly ChatMessage[],
  /** Cards live events settled since the messages loaded. */
  live: ReadonlyMap<string, TaskCard> = new Map(),
): Set<string> {
  const newest = new Map<string, { messageId: string; card: TaskCard | undefined }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of parseMessageEntries(message)) {
      if (part.type !== "task_chat" || part.show === "task") continue;
      newest.set(part.chatId, { messageId: message.id, card: part.card });
    }
  }
  const waiting = new Set<string>();
  for (const { messageId, card } of newest.values()) {
    if (!card || card.kind === "unavailable") continue;
    if (cardWaits(live.get(cardKey(card)) ?? card)) waiting.add(messageId);
  }
  return waiting;
}
