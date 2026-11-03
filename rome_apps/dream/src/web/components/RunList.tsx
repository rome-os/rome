import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@rome-os/ui/list-row";
import { cn } from "@rome-os/ui/cn";
import { Skeleton } from "@rome-os/ui/skeleton";
import { Timestamp, useTimestampSettings } from "@rome-os/ui/timestamp";
import type { RunListItem } from "../lib/api";
import { KIND_LABEL, groupByDay, outcomeLine } from "../lib/format";
import { RunIcon } from "./RunIcon";

const PANEL = "overflow-hidden rounded-12 border border-border bg-surface";

export function RunList({
  runs,
  selectedId,
  openId,
  onSelect,
}: {
  runs: RunListItem[];
  /** The run the route names. */
  selectedId: string | null;
  /** The run the detail pane shows, which on a wide screen defaults to the
   *  newest. Highlighted only where that pane is visible. */
  openId: string | null;
  onSelect: (id: string) => void;
}) {
  const { timeZone, locale } = useTimestampSettings();
  const groups = groupByDay(runs, timeZone, locale ?? "en-US");

  return (
    <nav aria-label="Runs" className={PANEL}>
      {groups.map((group) => (
        <div key={group.label} className="border-b border-border-subtle last:border-b-0">
          <h3 className="px-[var(--row-px-md)] pt-3 pb-1 text-aux font-medium text-muted-foreground">
            {group.label}
          </h3>
          <List asChild>
            <ul>
              {group.runs.map((run) => {
                const selected = run.id === selectedId;
                const broken = run.status === "failed" || run.status === "interrupted";
                return (
                  <li key={run.id}>
                    <ListRow
                      asChild
                      interactive
                      selected={selected}
                      className={cn(!selected && run.id === openId && "@4xl:bg-primary/10")}
                    >
                      <button
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        onClick={() => onSelect(run.id)}
                      >
                        <RunIcon run={run} />
                        <ListRowContent>
                          <ListRowTitle className="flex items-baseline justify-between gap-2">
                            <span className="truncate font-medium">{KIND_LABEL[run.kind]}</span>
                            <Timestamp
                              value={run.startedAt}
                              format="time"
                              className="shrink-0 text-aux text-muted-foreground"
                            />
                          </ListRowTitle>
                          <ListRowDescription
                            className={cn("truncate", broken && "text-destructive-fg")}
                          >
                            {outcomeLine(run)}
                          </ListRowDescription>
                        </ListRowContent>
                      </button>
                    </ListRow>
                  </li>
                );
              })}
            </ul>
          </List>
        </div>
      ))}
    </nav>
  );
}

export function RunListSkeleton() {
  return (
    <div className={cn(PANEL, "flex flex-col gap-4 p-4")} aria-busy>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-8" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}
