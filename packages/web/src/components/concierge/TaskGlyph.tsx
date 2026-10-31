import { Circle, CircleAlert, CircleCheck, CircleDot, CircleX, Clock } from "lucide-react";
import type { ConciergeTaskState } from "@rome/api-types/concierge";
import { cn } from "@/lib/utils";

const GLYPHS = {
  needs_user: CircleAlert,
  doing: CircleDot,
  next: Circle,
  watching: Clock,
  done: CircleCheck,
  dropped: CircleX,
} satisfies Record<ConciergeTaskState, typeof Circle>;

/**
 * The mark at a task row's leading edge, one shape per state. Only the one
 * that needs the guardian takes the warning colour. The group heading already
 * names the state, so the mark is not read out.
 */
export function TaskGlyph({ state }: { state: ConciergeTaskState }) {
  const Glyph = GLYPHS[state];
  return (
    <Glyph
      className={cn(
        "size-4 shrink-0",
        state === "needs_user" ? "text-warning" : "text-subtle-foreground",
      )}
      aria-hidden
    />
  );
}
