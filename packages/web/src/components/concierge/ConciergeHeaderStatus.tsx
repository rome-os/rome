import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
 * The middle of a Concierge chat's floating header, centred top to bottom: the
 * mascot in a round badge, a small name tag overlapping the badge's lower
 * edge, and under it, a capsule with what the Concierge is doing right now.
 * The name and the status are separate, so a short name stays under the
 * mascot whatever the status's length. Idle, the status capsule is gone, and
 * the mascot only blinks. The status line is a live region, so a screen
 * reader hears it change; idle, it stays in the page, read but not drawn.
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
  activity,
  badge = true,
  onOpenAgent,
}: {
  name: ReactNode;
  activity: ConciergeActivity;
  /** Whether the mascot's badge shows. Without it the name tag takes the badge's row. */
  badge?: boolean;
  /**
   * Opens the Agent page. The badge is its button, or the name tag while the
   * badge is gone.
   */
  onOpenAgent?: () => void;
}) {
  const { t } = useTranslation("chat");
  const status = statusText(activity, t);
  const busy = activity.kind !== "idle";
  const openLabel = typeof name === "string" ? t("concierge.agent.open", { name }) : undefined;
  // A button where it opens the Agent page, else a plain box.
  const Opener = onOpenAgent ? "button" : "div";
  const opener = (here: boolean) =>
    onOpenAgent && here
      ? {
          type: "button" as const,
          onClick: onOpenAgent,
          "aria-label": openLabel,
          title: openLabel,
        }
      : {};
  const focusRing =
    "outline-none outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";
  return (
    <div data-concierge-header-status data-activity={activity.kind} className="contents">
      {badge ? (
        <Opener
          data-concierge-header-badge
          {...opener(true)}
          className={cn(
            "pointer-events-auto col-start-2 row-start-1 flex size-11 items-center justify-center justify-self-center rounded-full",
            FLOATING_SURFACE,
            onOpenAgent && focusRing,
          )}
        >
          {/* About 60% of the badge, so the bob and the squash keep inside it. */}
          <RomeMascot alive={busy && activity.kind !== "needsYou"} className="h-6.5 w-auto" />
        </Opener>
      ) : null}
      <Opener
        data-concierge-header-name
        {...opener(!badge)}
        className={cn(
          !badge && onOpenAgent && focusRing,
          badge ? "row-start-2 -mt-1" : "row-start-1",
          // Above the badge, so the tag covers the badge's edge, not the reverse.
          "pointer-events-auto relative z-10 col-start-2 flex h-5 min-w-0 max-w-full items-center justify-self-center rounded-full px-2",
          FLOATING_SURFACE,
        )}
      >
        {/* Eight CJK characters at the tag's own size, then an ellipsis. */}
        <span className="max-w-[8em] truncate text-aux font-medium text-foreground">{name}</span>
      </Opener>
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
