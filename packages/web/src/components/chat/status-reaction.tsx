import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  CONCIERGE_STATUS_REACTIONS,
  type ConciergeStatusReaction,
} from "@rome/api-types/concierge";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

/** A `message_status_reaction` event: a message's status reaction changed. */
export const messageStatusReactionSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  statusReaction: z.enum(CONCIERGE_STATUS_REACTIONS).nullable(),
});

/**
 * Status reactions that live events changed since the messages loaded, by
 * message id. Null: the message has none now.
 */
export type LiveStatusReactions = ReadonlyMap<string, ConciergeStatusReaction | null>;

const LiveStatusReactionsContext = createContext<LiveStatusReactions>(new Map());

export const LiveStatusReactionsProvider = LiveStatusReactionsContext.Provider;

/** A message's status reaction as it stands now: the live one, else the loaded one. */
export function useStatusReaction(msg: ChatMessage): ConciergeStatusReaction | null {
  const live = useContext(LiveStatusReactionsContext);
  return live.has(msg.id) ? (live.get(msg.id) ?? null) : (msg.statusReaction ?? null);
}

const EMOJI: Record<ConciergeStatusReaction, string> = {
  working: "👀",
  done: "✅",
  failed: "⚠️",
};

/**
 * Rome's status reaction on a guardian message in a Concierge chat
 * (docs/domains/chats.md#status-reaction): a small badge on the bubble's
 * inner bottom corner, like a tapback. It only shows; it does nothing.
 */
export function StatusReactionBadge({ reaction }: { reaction: ConciergeStatusReaction }) {
  const { t } = useTranslation("chat");
  const label = t(`concierge.statusReaction.${reaction}`);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-status-reaction={reaction}
      className={cn(
        "pointer-events-none absolute -bottom-2 -left-2 z-10 flex size-6 select-none items-center justify-center",
        "rounded-full border border-border bg-surface text-aux shadow-10",
      )}
    >
      {EMOJI[reaction]}
    </span>
  );
}
