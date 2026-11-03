import { BookMarked, Moon } from "lucide-react";
import { cn } from "@rome-os/ui/cn";
import { Spinner } from "@rome-os/ui/spinner";
import type { RunListItem } from "../lib/api";

const sizeClasses = {
  md: "size-8 rounded-8 [&_svg]:size-4",
  lg: "size-10 rounded-12 [&_svg]:size-5",
};

/** The run's kind as a glyph tile; a spinner while it runs, destructive when it did not finish. */
export function RunIcon({
  run,
  size = "md",
}: {
  run: RunListItem;
  size?: keyof typeof sizeClasses;
}) {
  const Icon = run.kind === "dream" ? Moon : BookMarked;
  const broken = run.status === "failed" || run.status === "interrupted";
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        sizeClasses[size],
        broken
          ? "bg-destructive-bg text-destructive-fg"
          : run.kind === "dream"
            ? "bg-primary/10 text-primary"
            : "bg-surface-muted text-muted-foreground",
      )}
    >
      {run.status === "running" ? <Spinner size="sm" /> : <Icon />}
    </span>
  );
}
