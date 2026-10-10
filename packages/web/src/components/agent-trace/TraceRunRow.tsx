import type { TraceEventDto, TraceRunSegment } from "@rome/api-types/trace-segments";
import { formatDuration } from "./CollapsedTraceSummary";
import { CollapsibleTraceRow } from "./CollapsibleTraceRow";

export function TraceRunRow({
  run,
  renderRunBlocks,
  live = false,
}: {
  run: TraceRunSegment;
  renderRunBlocks: (blocks: TraceEventDto[], live: boolean) => React.ReactNode;
  live?: boolean;
}) {
  const durationStr = formatDuration(run.durationMs);
  return (
    <CollapsibleTraceRow
      defaultOpen
      icon={<img src={run.app.iconUrl} alt="" className="h-3.5 w-3.5" />}
      label={run.app.name}
      labelSuffix={
        run.count > 1 ? (
          <span className="flex-none font-mono text-aux text-subtle-foreground">×{run.count}</span>
        ) : null
      }
      meta={
        durationStr ? (
          <span className="flex-none font-mono text-aux font-normal tracking-wide text-subtle-foreground">
            {durationStr}
          </span>
        ) : null
      }
    >
      {renderRunBlocks(run.blocks, live)}
    </CollapsibleTraceRow>
  );
}
