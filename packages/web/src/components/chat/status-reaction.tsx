import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  CONCIERGE_STATUS_REACTIONS,
  type ConciergeStatusReaction,
} from "@rome/api-types/concierge";
import type { ChatMessage } from "@/lib/chat-types";

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
  failed: "⚠️",
};

/** How long the mark fades in and out, in ms. Matches `[data-status-reaction]` in globals.css. */
const MARK_FADE_MS = 150;

/**
 * Rome's status reaction on a guardian message in a Concierge chat
 * (docs/domains/chats.md#status-reaction): a round badge on the bubble's
 * bottom-right corner, like a tapback, centered on the bubble's bottom edge so
 * half of it hangs below, clear of the text. It is a child of the bubble, so
 * it stays on the bubble whatever the row around it holds. It takes no room:
 * the guardian's bubbles in a Concierge chat sit far enough apart for it,
 * mark or not (ConciergeGroup.tsx), so the timeline never moves when it comes
 * or goes. It fades in and out, and only shows; it does nothing.
 */
export function StatusReactionBadge({ reaction }: { reaction: ConciergeStatusReaction | null }) {
  const { t } = useTranslation("chat");
  // The last reaction stays drawn while the mark fades out.
  const [shown, setShown] = useState(reaction);
  const [leaving, setLeaving] = useState(false);
  if (reaction && (reaction !== shown || leaving)) {
    setShown(reaction);
    setLeaving(false);
  } else if (!reaction && shown && !leaving) {
    setLeaving(true);
  }
  useEffect(() => {
    if (!leaving) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timer = window.setTimeout(
      () => {
        setShown(null);
        setLeaving(false);
      },
      still ? 0 : MARK_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [leaving]);
  if (!shown) return null;
  const label = t(`concierge.statusReaction.${shown}`);
  return (
    <span
      role="img"
      aria-label={label}
      aria-hidden={leaving || undefined}
      title={label}
      data-status-reaction={shown}
      data-leaving={leaving || undefined}
      // A 24px disc with the emoji at 15px in its own colors, ringed in the
      // chat's background (the chat sets --background to its canvas) so it
      // cuts cleanly into the bubble, with the faintest shadow. Its fill is
      // in globals.css (`[data-status-reaction]`). It has no z-index, so the
      // next bubble's hover toolbar, later in the page, paints over it.
      className="pointer-events-none absolute right-2 -bottom-3 flex size-6 select-none items-center justify-center rounded-full text-section shadow-1 ring-2 ring-background"
    >
      {EMOJI[shown]}
    </span>
  );
}
