import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { RomeMascot } from "./RomeMascot";

/** The kinds that are work under way, whose status line shimmers. */
const WORKING = new Set<ConciergeActivity["kind"]>(["working", "tool", "tasks"]);

/**
 * The translucent surface every piece of a Concierge chat's floating header
 * sits on: the mascot's badge, the name tag, the status capsule and the round
 * buttons. It blurs
 * the messages scrolling under it, so its text stays readable without a bar.
 */
export const FLOATING_SURFACE =
  "border border-border/60 bg-surface/95 shadow-1 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80";

/**
 * The phone's leading buttons (back to the chat list, the menu), which the
 * shell moves into a Concierge chat's floating header while it shows one.
 */
export const CONCIERGE_LEADING_SLOT = "conciergeHeaderLeading";

/**
 * Where the Mac app's title bar takes a Concierge chat's mascot, name and status, to
 * hang them from its lower edge over the chat.
 */
export const CONCIERGE_TITLEBAR_SLOT = "conciergeTitlebar";

/**
 * The middle of a chat's floating header, centred top to bottom: the agent in
 * a round badge, a small name tag overlapping the badge's lower edge, and, in
 * a Concierge chat, a capsule under it with what the Concierge is doing right
 * now. The name and the status are separate, so a short name stays under the
 * badge whatever the status's length. Idle, the status capsule is gone, and
 * the mascot only blinks. The status line is a live region, so a screen
 * reader hears it change; idle, it stays in the page, read but not drawn.
 *
 * The badge and the name tag are no actions: what a chat opens is in the
 * header's buttons (`ChatHeaderActions`).
 *
 * Its root lays out as `contents`: the pieces are items of the header's grid.
 * The badge takes the first row, where the side buttons centre on it, and
 * the name tag the second. The status takes the third, across all three
 * columns, so its width is a share of the header's and does not widen the
 * middle column the buttons are placed around. Without the badge, the name
 * tag takes the first row and the status the second.
 */
export function ConciergeHeaderStatus({
  name,
  activity = { kind: "idle" },
  badge = true,
  avatar,
  showsActivity = true,
}: {
  name: ReactNode;
  /** What the Concierge is doing; an ordinary chat leaves it idle. */
  activity?: ConciergeActivity;
  /** Whether the badge shows. Without it the name tag takes the badge's row. */
  badge?: boolean;
  /** What the badge holds; the Concierge's mascot when not given. */
  avatar?: ReactNode;
  /**
   * Whether the activity capsule shows under the name: the Concierge's. An
   * ordinary chat's header has none, and its name tag may run longer.
   */
  showsActivity?: boolean;
}) {
  const { t } = useTranslation("chat");
  const status = statusText(activity, t);
  const busy = activity.kind !== "idle";
  const badgeEl = (
    <div
      data-concierge-header-badge
      className={cn(
        "pointer-events-auto col-start-2 row-start-1 flex size-11 items-center justify-center justify-self-center rounded-full",
        FLOATING_SURFACE,
      )}
    >
      {avatar ?? (
        // About 60% of the badge, so the bob and the squash keep inside it.
        <RomeMascot
          alive={busy && activity.kind !== "needsYou"}
          // A touch lighter than the text it sits beside.
          className="h-6.5 w-auto text-foreground/80"
        />
      )}
    </div>
  );
  const nameEl = (
    <div
      data-concierge-header-name
      className={cn(
        badge ? "row-start-2 -mt-1" : "row-start-1",
        // Above the badge, so the tag covers the badge's edge, not the reverse.
        "pointer-events-auto relative z-10 col-start-2 flex h-5 min-w-0 max-w-full items-center justify-self-center rounded-full px-2",
        FLOATING_SURFACE,
      )}
    >
      {/* Eight CJK characters at the tag's own size, then an ellipsis. */}
      {/* A chat title runs to about twice that, and never into the side buttons. */}
      <span
        className={cn(
          "truncate text-aux font-medium text-muted-foreground",
          showsActivity ? "max-w-[8em]" : "max-w-[min(16em,calc(100cqw-16rem))]",
        )}
      >
        {name}
      </span>
    </div>
  );
  return (
    <div data-concierge-header-status data-activity={activity.kind} className="contents">
      {badge ? badgeEl : null}
      {nameEl}
      {showsActivity ? (
        <div
          data-concierge-header-activity
          aria-live="polite"
          className={cn(
            badge ? "row-start-3" : "row-start-2",
            "col-span-3 col-start-1 mt-1 flex h-6 min-w-0 max-w-[70%] items-center justify-self-center rounded-full px-3",
            status ? cn("pointer-events-auto", FLOATING_SURFACE) : "sr-only",
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate text-aux text-muted-foreground",
              // A light band sweeps the line while work is under way; a
              // question waiting on the owner and idle stay still.
              WORKING.has(activity.kind) && "shimmer",
            )}
          >
            {status ?? t("concierge.activity.idle")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function statusText(
  activity: ConciergeActivity,
  t: ReturnType<typeof useTranslation<"chat">>["t"],
): string | null {
  switch (activity.kind) {
    case "idle":
      return null;
    case "needsYou":
      return t("concierge.activity.needsYou");
    case "working":
      return t("concierge.activity.working");
    case "tool":
      return t(`concierge.activity.tool.${activity.tool}`);
    case "tasks":
      return activity.more > 0
        ? t("concierge.activity.tasksMore", { title: activity.title, count: activity.more })
        : t("concierge.activity.tasks", { title: activity.title });
  }
}

/**
 * The link a task chat's header starts with: back to the Concierge chat it
 * reports to, named by that chat. It floats like the header's round buttons.
 */
export function BackToConciergeChat({ to, name }: { to: string; name: string }) {
  const { t } = useTranslation("chat");
  return (
    <Link
      to={to}
      data-back-to-concierge-chat
      aria-label={t("taskLink.backTo", { name })}
      className={cn(
        "pointer-events-auto col-start-1 row-start-1 inline-flex h-[var(--control-h-md)] max-w-48 shrink-0 items-center gap-1 justify-self-start rounded-full pl-2 pr-3 text-ui text-foreground transition hover:bg-surface-hover outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50",
        FLOATING_SURFACE,
      )}
    >
      <ChevronLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </Link>
  );
}
