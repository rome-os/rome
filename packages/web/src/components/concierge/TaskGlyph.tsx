import { Circle, CircleAlert, CircleCheck, CircleDot, CircleX, Clock } from "lucide-react";
import type { ConciergeTaskStatusResult } from "@rome/api-types/concierge-task-status";
import { cn } from "@/lib/utils";

/**
 * The mark at a task row's leading edge, one shape per status, and per reason
 * once it ended. Only the one that needs the guardian takes the warning
 * colour. The group heading and the row's line already say it, so the mark
 * is not read out.
 */
export function TaskGlyph({ status }: { status: ConciergeTaskStatusResult }) {
  const Glyph =
    status.status === "needs_you"
      ? CircleAlert
      : status.status === "active"
        ? CircleDot
        : status.status === "later"
          ? Clock
          : status.endReason === "done"
            ? CircleCheck
            : status.endReason === "no_response"
              ? Circle
              : CircleX;
  return (
    <Glyph
      className={cn(
        "size-4 shrink-0",
        status.status === "needs_you" ? "text-warning" : "text-subtle-foreground",
      )}
      aria-hidden
    />
  );
}
