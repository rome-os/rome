import { useState, type MouseEvent, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConciergeMessageMeta } from "@/components/chat/ConciergeMessageMeta";
import { IconButton } from "@/components/ui/icon-button";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/** Devices that cannot hover, where a tap on the bubble opens its details. */
const NO_HOVER_QUERY = "(hover: none)";

// The look of the details toggle a keyboard reveals on touch devices.
const HOVER_CHIP =
  "rounded-full border border-border bg-surface/95 text-muted-foreground shadow-10 hover:text-foreground";

// A tap on any of these belongs to the thing tapped, not to the bubble.
const INTERACTIVE = "a,button,input,textarea,select,summary,label,[role=button],[role=link]";

/**
 * One Concierge bubble and its details: when it was sent, Reply, a copy button
 * for its text, and for the last bubble of an agent turn, the turn's feedback
 * buttons. The bubble takes no room for them:
 *
 * - With a pointer that can hover, the details are a small toolbar that floats
 *   over the bubble's top edge on hover or keyboard focus, aligned to the
 *   bubble's outer corner and running past its inner side when the bubble is
 *   narrower. It is 26px tall: 12px over the bubble's border, top padding, and
 *   the space above its first line, and 14px above, over the 4px gap and the
 *   bubble above's bottom padding. Two grouped bubbles of body text leave
 *   exactly that between their lines, so it covers no text. The overlap also
 *   bridges the pointer from the bubble to the toolbar. The toolbar takes no
 *   pointer events while hidden, and stays visible while the feedback form it
 *   opens is open.
 * - Without hover, tapping the bubble toggles a row of the same details under
 *   it. A tap on a link or control inside the bubble, or one that ends a text
 *   selection, does not toggle. A details button stays in the tab order for
 *   keyboards and screen readers but is not drawn.
 *
 * `side` is the edge the bubble aligns to: `start` for the agent, `end` for the
 * guardian. `reply` is what the Reply button quotes. `anchorId` makes
 * the bubble the target of a jump from a quote of it.
 */
export function ConciergeBubble({
  side,
  copyText,
  createdAt,
  feedbackTurn,
  reply = null,
  anchorId,
  children,
}: {
  side: "start" | "end";
  copyText: string;
  createdAt: string;
  feedbackTurn: { sessionId: string; turnId: string } | null;
  reply?: ReplySource | null;
  anchorId?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const touch = useMediaQuery(NO_HOVER_QUERY);
  const [open, setOpen] = useState(false);

  const onTap = (event: MouseEvent<HTMLElement>) => {
    if (!touch) return;
    if ((event.target as Element).closest(INTERACTIVE)) return;
    if (window.getSelection()?.isCollapsed === false) return;
    setOpen((current) => !current);
  };

  return (
    <div
      data-timeline-anchor={anchorId}
      className={cn(
        "flex min-w-0 max-w-full flex-col",
        side === "end" ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "group/bubble relative flex min-w-0 max-w-full",
          side === "end" && "justify-end",
          touch && "[-webkit-tap-highlight-color:transparent]",
        )}
        onClick={onTap}
      >
        {children}
        {touch ? (
          // Not drawn: anchored inside the bubble so its 44px box cannot
          // widen the transcript.
          <div
            className={cn(
              "absolute top-[min(50%,1.25rem)] -translate-y-1/2",
              side === "start" ? "left-0" : "right-0",
            )}
          >
            <IconButton
              size="sm"
              label={t("concierge.messageDetails")}
              icon={<Ellipsis />}
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              className={cn(HOVER_CHIP, "pointer-events-none opacity-0 focus-visible:opacity-100")}
            />
          </div>
        ) : (
          <div
            data-bubble-toolbar
            className={cn(
              "absolute bottom-full flex w-max translate-y-3 items-center rounded-8 border border-border bg-surface shadow-4",
              side === "start" ? "left-0" : "right-0",
              "pointer-events-none opacity-0 transition-opacity group-focus-within/bubble:pointer-events-auto group-focus-within/bubble:opacity-100 group-hover/bubble:pointer-events-auto group-hover/bubble:opacity-100 has-data-[state=open]:pointer-events-auto has-data-[state=open]:opacity-100 motion-reduce:transition-none",
            )}
          >
            <ConciergeMessageMeta
              size="xs"
              copyText={copyText}
              createdAt={createdAt}
              feedbackTurn={feedbackTurn}
              reply={reply}
            />
          </div>
        )}
      </div>
      {touch && open ? (
        <div className="mt-1">
          <ConciergeMessageMeta
            copyText={copyText}
            createdAt={createdAt}
            feedbackTurn={feedbackTurn}
            reply={reply}
            onReply={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
