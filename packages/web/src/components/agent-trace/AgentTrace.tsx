import { useTranslation } from "react-i18next";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import type { TraceBlockDto, TraceSegment, TraceSummary } from "@rome/api-types/trace-segments";
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
  renderInlineBlock: (block: TraceBlockDto, key: string) => React.ReactNode;
  renderRunBlocks: (blocks: TraceBlockDto[], live: boolean) => React.ReactNode;
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

export function CollapsedTraceButton({
  summary,
  onClick,
  live = false,
  compact = false,
}: {
  summary?: TraceSummary;
  onClick: () => void;
  live?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    // A single inline line sized to sit under the agent name beside the avatar.
    return (
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={onClick}
        className="-mx-2 max-w-none select-text justify-start text-left hover:no-underline"
      >
        <CollapsedTraceContent summary={summary} live={live} compact />
      </Button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="transition-all flex w-full select-text items-center gap-2 rounded-8 py-1 px-0 text-left hover:px-2 hover:bg-surface-muted/80"
    >
      <CollapsedTraceContent summary={summary} live={live} />
      <span className="ml-auto flex-none text-subtle-foreground">
        <ChevronRightIcon />
      </span>
    </button>
  );
}

function CollapsedTraceContent({
  summary,
  live,
  compact = false,
}: {
  summary?: TraceSummary;
  live: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation("activity");

  if (summary?.terminalError) {
    return <TraceErrorSummary error={summary.terminalError} />;
  }
  if (compact && live) {
    return (
      <CollapsedTraceSummary
        summary={summary ?? { distinctApps: [], totalSteps: 0, invocationCounts: {} }}
        live={live}
        compact
      />
    );
  }
  if (summary && !isEmptySummary(summary)) {
    return <CollapsedTraceSummary summary={summary} live={live} compact={compact} />;
  }
  if (summary?.stoppedByUser) {
    return <StatusPill label={t("trace.stoppedByUser")} compact={compact} />;
  }
  if (summary?.totalDurationMs !== undefined) {
    return (
      <StatusPill
        label={t("trace.thoughtFor", { duration: formatDuration(summary.totalDurationMs) })}
        compact={compact}
      />
    );
  }
  return <StatusPill label={t("trace.thinking")} pulse compact={compact} />;
}

function StatusPill({
  label,
  pulse = false,
  compact = false,
}: {
  label: string;
  pulse?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    return <span className="text-aux text-muted-foreground">{label}</span>;
  }
  return (
    <div className="text-ui text-subtle-foreground">
      <span
        className={`inline-block h-2 w-2 rounded-full bg-border-strong${pulse ? " animate-pulse" : ""}`}
      />
      &nbsp;<span>{label}</span>
    </div>
  );
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
