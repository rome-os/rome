import { Circle, CircleAlert, CircleCheck, CircleStop, CircleX, Clock } from "lucide-react";
import type { ConciergeTaskStatusResult } from "@rome/api-types/concierge-task-status";
import { cn } from "@/lib/utils";

/**
 * The running mark: an open ring that spins, in the running blue softened as
 * the other status hues are. It is the one glyph that moves, so work under
 * way reads at a glance.
 */
export function RunningSpinner({ className }: { className?: string }) {
  return (
    <span className={cn("rome-status-spin flex shrink-0", className)} aria-hidden>
      <svg viewBox="0 0 16 16" fill="none" className="size-full text-running/80">
        <circle
          cx="8"
          cy="8"
          r="5.5"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="1.75"
        />
        <path
          d="M8 2.5A5.5 5.5 0 1 1 2.5 8"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/**
 * The mark of a task chat's status, one shape per status, and per reason once
 * it ended: needs you CircleAlert, active the spinner, later Clock, done
 * CircleCheck, failed CircleX, stopped CircleStop, no response Circle. Needs
 * you takes the warning colour, active the running blue, done green and
 * failed red, each at 80% so a small mark beside text reads softer than the
 * full-strength token; later, stopped and no response stay grey. The iOS app
 * uses the same colours (`TaskMarkTone`). The same marks stand in a task link
 * and in the Tasks view's rows. The group heading and the row's line already
 * say the status, so the mark is not read out.
 */
export function TaskGlyph({
  status,
  className,
  tone = "subtle",
}: {
  status: ConciergeTaskStatusResult;
  className?: string;
  /** The colour of the quiet marks: `subtle` in a row, `muted` in a task link, which sits on text. */
  tone?: "subtle" | "muted";
}) {
  if (status.status === "active") return <RunningSpinner className={cn("size-4", className)} />;
  const Glyph =
    status.status === "needs_you"
      ? CircleAlert
      : status.status === "later"
        ? Clock
        : status.endReason === "done"
          ? CircleCheck
          : status.endReason === "no_response"
            ? Circle
            : status.endReason === "stopped"
              ? CircleStop
              : CircleX;
  return (
    <Glyph
      className={cn(
        "size-4 shrink-0",
        status.status === "needs_you"
          ? "text-warning/80"
          : status.status === "ended" && status.endReason === "done"
            ? "text-success/80"
            : status.status === "ended" && status.endReason === "failed"
              ? "text-destructive/80"
              : tone === "muted"
                ? "text-muted-foreground"
                : "text-subtle-foreground",
        className,
      )}
      aria-hidden
    />
  );
}
