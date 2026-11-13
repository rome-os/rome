import { createContext, useContext } from "react";
import { z } from "zod";
import type { TaskCard } from "@rome/api-types/chat";

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

/** The key a live card is kept under: its kind and id. */
export function cardKey(card: { kind: string; id?: string }): string {
  return `${card.kind}:${card.id ?? ""}`;
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
