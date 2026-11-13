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
 * (docs/domains/chats.md#status-reaction), as the iOS app draws it: the emoji
 * in a round badge centered on the bubble's top-left corner, so half of it
 * hangs outside the bubble, clear of its text, with one small dot trailing off
 * it like a thought. It is a child of the bubble, so it stays on the bubble
 * whatever the row around it holds. It takes no room: every guardian bubble
 * in a Concierge chat keeps a fixed gap above it for the badge
 * (GUARDIAN_BUBBLE_GAP in ConciergeGroup.tsx), mark or not, so the timeline
 * never moves when it comes or goes. It grows in and fades out, and only
 * shows; it does nothing.
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
      // A 28px badge centered on the bubble's corner, lighter than the page
      // in both themes so the emoji reads, with a hairline edge.
      className="pointer-events-none absolute -top-3.5 -left-3.5 flex size-7 select-none items-center justify-center rounded-full border-[0.5px] border-surface-foreground/10 bg-surface-elevated text-composer shadow-1 dark:bg-surface-hover"
    >
      {EMOJI[shown]}
      {/* The thought dot, trailing off the badge's lower left. */}
      <span
        aria-hidden="true"
        className="absolute top-6 -left-0.5 size-1.5 rounded-full border-[0.5px] border-surface-foreground/10 bg-surface-elevated dark:bg-surface-hover"
      />
    </span>
  );
}
