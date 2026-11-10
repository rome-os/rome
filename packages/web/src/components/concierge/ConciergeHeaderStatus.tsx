import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { RomeMascot } from "./RomeMascot";

/** The kinds that are work under way, whose status line shimmers. */
const WORKING = new Set<ConciergeActivity["kind"]>(["working", "tool", "tasks"]);

/**
 * The translucent surface every piece of a Concierge chat's floating header
 * sits on: the mascot's badge, the name pill and the round buttons. It blurs
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
 * The middle of a Concierge chat's floating header: the mascot in a round
 * badge, and under it, overlapping it, a pill with the chat's name and what
 * the Concierge is doing right now. Idle, the pill holds the name alone and
 * the mascot only blinks. The status line is a live region, so a screen
 * reader hears it change.
 *
 * Its root lays out as `contents`: the badge and the pill are items of the
 * header's grid, the badge in its first row and the pill in its second, and
 * the side buttons centre on the badge in the first row.
 */
export function ConciergeHeaderStatus({
  name,
  activity,
}: {
  name: ReactNode;
  activity: ConciergeActivity;
}) {
  const { t } = useTranslation("chat");
  const status = statusText(activity, t);
  const busy = activity.kind !== "idle";
  return (
    <div data-concierge-header-status data-activity={activity.kind} className="contents">
      <div
        data-concierge-header-badge
        className={cn(
          "pointer-events-auto col-start-2 row-start-1 flex size-14 items-center justify-center justify-self-center rounded-full",
          FLOATING_SURFACE,
        )}
      >
        {/* About 60% of the badge, so the bob and the squash keep inside it. */}
        <RomeMascot alive={busy && activity.kind !== "needsYou"} className="h-8 w-auto" />
      </div>
      <div
        data-concierge-header-pill
        className={cn(
          "pointer-events-auto relative col-start-2 row-start-2 -mt-2 flex min-w-0 max-w-full flex-col items-center justify-self-center rounded-full px-4 py-1 text-center leading-tight",
          FLOATING_SURFACE,
        )}
      >
        <span className="max-w-full truncate text-ui font-medium text-foreground">{name}</span>
        <span
          aria-live="polite"
          className={cn(
            "max-w-full truncate text-aux",
            activity.kind === "needsYou" ? "text-warning-fg" : "text-muted-foreground",
            // A light band sweeps the line while work is under way; a
            // question waiting on the owner and idle stay still.
            WORKING.has(activity.kind) && "shimmer",
            !status && "sr-only",
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
