import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CHAT_POPOVER_FIT } from "@/components/chat/chat-overlay";
import { ConciergeMessageMeta } from "@/components/chat/ConciergeMessageMeta";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ReplyButton } from "@/components/chat/reply/ReplyButton";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/** Devices that cannot hover, where a tap on the bubble opens its details. */
const NO_HOVER_QUERY = "(hover: none)";

// The popover flips above the button before it reaches the composer pinned to
// the bottom of the viewport. The composer's height varies with its text, so
// this covers one line; a taller composer still sits under the popover.
const POPOVER_COLLISION_PADDING = { top: 12, right: 0, left: 0, bottom: 96 };

// Room the popover needs beside the button: the widest content (time, copy, and
// feedback) plus its offset. Without it the popover opens below the button.
const POPOVER_ROOM_BESIDE = 246;

// The look of the controls floating beside a bubble.
const HOVER_CHIP =
  "rounded-full border border-border bg-surface/95 text-muted-foreground shadow-10 hover:text-foreground";

// A tap on any of these belongs to the thing tapped, not to the bubble.
const INTERACTIVE = "a,button,input,textarea,select,summary,label,[role=button],[role=link]";

/**
 * One Concierge bubble and the details behind it (time, copy, and for the last
 * bubble of an agent turn, feedback). The bubble takes no room for them:
 *
 * - With a pointer that can hover, a Reply button and a "more" button float
 *   beside the bubble on hover or keyboard focus, Reply next to the bubble. The
 *   "more" button opens the details in a popover. Both stay visible while the
 *   popover, or the feedback popover inside it, is open. When the bubble fills
 *   the transcript's width, the buttons sit over the bubble's inner edge
 *   instead of past the transcript. The nearest `@container` is the
 *   transcript, which is what `cqw` measures.
 * - Without hover, tapping the bubble toggles a row of the same details, and
 *   Reply, under it. A tap on a link or control inside the bubble, or one that ends a text
 *   selection, does not toggle. The "more" button stays in the tab order for
 *   keyboards and screen readers but is not drawn.
 *
 * The popover is anchored to the "more" button, never to the bubble: anchored
 * to a tall bubble it would open at the bubble's far end.
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
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set when the popover opens: the transcript's column, which the popover stays
  // inside, and whether the empty space beside the button is wide enough for it.
  const [column, setColumn] = useState<Element | null>(null);
  const [beside, setBeside] = useState(true);

  const onTap = (event: MouseEvent<HTMLElement>) => {
    if (!touch) return;
    if ((event.target as Element).closest(INTERACTIVE)) return;
    if (window.getSelection()?.isCollapsed === false) return;
    setOpen((current) => !current);
  };

  const meta = (
    <ConciergeMessageMeta
      copyText={copyText}
      createdAt={createdAt}
      feedbackTurn={feedbackTurn}
      reply={touch ? reply : null}
      onReply={() => setOpen(false)}
    />
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const columnEl = boxRef.current?.closest("[data-chat-transcript]") ?? null;
          const button = triggerRef.current?.getBoundingClientRect();
          const bounds = columnEl?.getBoundingClientRect();
          setColumn(columnEl);
          // The empty side is right of the agent's button and left of the guardian's.
          if (button && bounds) {
            const room = side === "start" ? bounds.right - button.right : button.left - bounds.left;
            setBeside(room >= POPOVER_ROOM_BESIDE);
          }
        }
        setOpen(next);
      }}
    >
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
          ref={boxRef}
        >
          {children}
          <div
            className={cn(
              "absolute top-[min(50%,1.25rem)] -translate-y-1/2",
              // Not drawn on touch: anchored inside the bubble so its 44px
              // box cannot widen the transcript.
              touch
                ? side === "start"
                  ? "left-0"
                  : "right-0"
                : side === "start"
                  ? "left-[min(100%,calc(100cqw-4rem))] flex gap-1 pl-1"
                  : "right-[min(100%,calc(100cqw-4rem))] flex flex-row-reverse gap-1 pr-1",
            )}
          >
            {touch || !reply ? null : (
              <ReplyButton
                source={reply}
                className={cn(
                  HOVER_CHIP,
                  "opacity-0 transition-opacity group-focus-within/bubble:opacity-100 group-hover/bubble:opacity-100 motion-reduce:transition-none",
                  open && "opacity-100",
                )}
              />
            )}
            <PopoverTrigger asChild>
              <IconButton
                ref={triggerRef}
                size="sm"
                label={t("concierge.messageDetails")}
                icon={<Ellipsis />}
                className={cn(
                  HOVER_CHIP,
                  touch
                    ? "pointer-events-none opacity-0 focus-visible:opacity-100"
                    : "opacity-0 transition-opacity group-focus-within/bubble:opacity-100 group-hover/bubble:opacity-100 aria-expanded:opacity-100 motion-reduce:transition-none",
                )}
              />
            </PopoverTrigger>
          </div>
        </div>
        {touch && open ? <div className="mt-1">{meta}</div> : null}
      </div>
      {touch ? null : (
        <PopoverContent
          // The trigger is the anchor. The popover opens into the empty side of the
          // button, centered on it. A bubble that fills the column leaves no room
          // there, so the popover opens below the button, extending over the
          // bubble and not past the column.
          side={beside ? (side === "start" ? "right" : "left") : "bottom"}
          align={beside ? "center" : side === "end" ? "start" : "end"}
          sideOffset={6}
          collisionBoundary={column ? [column] : undefined}
          collisionPadding={POPOVER_COLLISION_PADDING}
          className={cn("w-auto flex-row items-center gap-0 p-1", CHAT_POPOVER_FIT.className)}
        >
          {meta}
        </PopoverContent>
      )}
    </Popover>
  );
}
