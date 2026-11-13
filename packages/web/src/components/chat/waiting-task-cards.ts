import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import type { TaskCard } from "@rome/api-types/chat";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatMessage } from "@/lib/chat-types";

/**
 * The messages of a Concierge chat whose task card holds what its task waits
 * on its owner for, read from the server's facts alone: the task's open wait
 * (its `openWait`, while it needs its owner) and the card Rome filled in. Only
 * the newest card of each task chat counts, as only that one takes an answer.
 * A card still mounting counts as soon as its message is here.
 */
export function waitingTaskCardMessages(
  messages: readonly ChatMessage[],
  tasks: readonly ConciergeTaskDto[],
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
  for (const [chatId, { messageId, card }] of newest) {
    if (!card || card.kind === "unavailable") continue;
    const now = live.get(`${card.kind}:${card.id}`) ?? card;
    if (now.kind === "unavailable" || now.outcome) continue;
    const task = tasks.find((candidate) => candidate.chat?.id === chatId);
    const wait = task?.openWait;
    if (task?.status !== "needs_you" || !wait || wait.id !== now.id) continue;
    waiting.add(messageId);
  }
  return waiting;
}
