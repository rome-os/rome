import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ConciergeActivity } from "./concierge-activity";
import { RomeMascot } from "./RomeMascot";

/**
 * The phone header's middle, which the open Concierge chat fills with its
 * {@link ConciergeHeaderStatus}: the header is drawn outside the chat, and the
 * chat alone knows what its turn is doing.
 */
export const CONCIERGE_PHONE_STATUS_SLOT = "conciergePhoneStatus";

/**
 * The middle of a Concierge chat's header: the mascot, the chat's name and,
 * under it, what the Concierge is doing right now. Idle, it shows the name
 * alone and the mascot only blinks. The status line is a live region, so a
 * screen reader hears it change.
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
    <div
      data-concierge-header-status
      data-activity={activity.kind}
      className="pointer-events-auto flex min-w-0 max-w-full items-center gap-2"
    >
      <RomeMascot alive={busy && activity.kind !== "needsYou"} className="h-6 w-auto" />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-ui font-medium text-foreground">{name}</span>
        <span
          aria-live="polite"
          className={cn(
            "truncate text-aux",
            activity.kind === "needsYou" ? "text-warning-fg" : "text-muted-foreground",
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
        : activity.title;
  }
}
