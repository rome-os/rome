import { useTranslation } from "react-i18next";
import type { TraceEventDto, TraceSegment, TraceSummary } from "@rome/api-types/trace-segments";
import { Button } from "@/components/ui/button";
import { CollapsedTraceSummary, formatDuration } from "./CollapsedTraceSummary";
import { TraceRunRow } from "./TraceRunRow";

export function TraceBody({
  segments,
  loading = false,
  error = null,
  onRetry,
  renderInlineBlock,
  renderRunBlocks,
  live = false,
}: {
  segments: TraceSegment[] | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  renderInlineBlock: (block: TraceEventDto, key: string) => React.ReactNode;
  renderRunBlocks: (blocks: TraceEventDto[], live: boolean) => React.ReactNode;
  live?: boolean;
}) {
  const { t } = useTranslation("activity");
  return (
    <div className="space-y-2">
      {loading && <div className="text-aux text-subtle-foreground">{t("trace.loading")}</div>}
      {error && (
        <div className="flex items-center gap-2 text-aux text-destructive">
          <span>{error}</span>
          {onRetry && !loading && (
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              {t("trace.retry")}
            </Button>
          )}
        </div>
      )}
      <div className="space-y-1">
        {segments?.map((seg) =>
          seg.kind === "run" ? (
            <TraceRunRow key={seg.id} run={seg} renderRunBlocks={renderRunBlocks} live={live} />
          ) : (
            <div key={seg.id} className="text-aux text-foreground">
              {renderInlineBlock(seg.block, seg.id)}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// A single inline line sized to sit under the agent name beside the avatar.
export function CollapsedTraceButton({
  summary,
  onClick,
  live = false,
}: {
  summary?: TraceSummary;
  onClick: () => void;
  live?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      onClick={onClick}
      className="-mx-2 max-w-none select-text justify-start text-left hover:no-underline"
    >
      <CollapsedTraceContent summary={summary} live={live} />
    </Button>
  );
}

function CollapsedTraceContent({ summary, live }: { summary?: TraceSummary; live: boolean }) {
  const { t } = useTranslation("activity");

  if (summary?.terminalError) {
    return <TraceErrorSummary error={summary.terminalError} />;
  }
  if (live) {
    return (
      <CollapsedTraceSummary
        summary={summary ?? { distinctApps: [], totalSteps: 0, invocationCounts: {} }}
        live={live}
        compact
      />
    );
  }
  if (summary && !isEmptySummary(summary)) {
    return <CollapsedTraceSummary summary={summary} live={live} compact />;
  }
  if (summary?.stoppedByUser) {
    return <StatusPill label={t("trace.stoppedByUser")} />;
  }
  if (summary?.totalDurationMs !== undefined) {
    return (
      <StatusPill
        label={t("trace.thoughtFor", { duration: formatDuration(summary.totalDurationMs) })}
      />
    );
  }
  return <StatusPill label={t("trace.thinking")} />;
}

function StatusPill({ label }: { label: string }) {
  return <span className="text-aux text-muted-foreground">{label}</span>;
}

function TraceErrorSummary({ error }: { error: string }) {
  const { t } = useTranslation("activity");
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui text-destructive-fg">
      <span className="inline-block h-2 w-2 flex-none rounded-full bg-destructive" />
      <span className="truncate">{t("trace.failedWithReason", { reason: error })}</span>
    </div>
  );
}

function isEmptySummary(summary?: TraceSummary): boolean {
  if (!summary) return true;
  return summary.totalSteps === 0 && summary.distinctApps.length === 0;
}
