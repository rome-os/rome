import { createContext, useContext } from "react";
import { z } from "zod";
import type { TaskCard } from "@rome/api-types/chat";
import type { ConciergeOpenWait } from "@rome/api-types/concierge";

/**
 * A `chat_card_settled` event: a question or approval a task card shows
 * settled. Its `card` replaces the card of every task card that shows the
 * same question or approval.
 */
export const chatCardSettledSchema = z.object({
  sessionId: z.string(),
  card: z
    .object({ kind: z.enum(["question", "approval"]), id: z.string() })
    .passthrough()
    .transform((card) => card as unknown as Exclude<TaskCard, { kind: "unavailable" }>),
});

/**
 * The key a live card is kept under: an approval by its id, a question by the
 * message that asked it as well, since a later turn can ask again under the
 * same tool use id.
 */
export function cardKey(card: { kind: string; id?: string; messageId?: string }): string {
  return card.kind === "question"
    ? `question:${card.messageId ?? ""}:${card.id ?? ""}`
    : `${card.kind}:${card.id ?? ""}`;
}

/**
 * Whether `wait`, a task's open wait, is `card`: the same approval, or the
 * same question asked in the same message, since a later turn can ask again
 * under the same tool use id.
 */
export function isOpenWait(
  wait: ConciergeOpenWait | null | undefined,
  card: Exclude<TaskCard, { kind: "unavailable" }>,
): boolean {
  if (!wait || wait.id !== card.id) return false;
  if (card.kind === "approval") return wait.kind === "approval";
  return wait.kind === "card" && wait.messageId === card.messageId;
}

/** Cards live events settled since the messages loaded, by {@link cardKey}. */
export type LiveTaskCards = ReadonlyMap<string, TaskCard>;

const LiveTaskCardsContext = createContext<LiveTaskCards>(new Map());

export const LiveTaskCardsProvider = LiveTaskCardsContext.Provider;

/** A task card's card as it stands now: the one a live event settled, else the loaded one. */
export function useLiveTaskCard(card: TaskCard | undefined): TaskCard | undefined {
  const live = useContext(LiveTaskCardsContext);
  if (!card || card.kind === "unavailable") return card;
  return live.get(cardKey(card)) ?? card;
}
