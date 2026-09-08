import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon, ChevronRightIcon } from "@radix-ui/react-icons";
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

export function AgentTrace({
  summary,
  segments,
  loading = false,
  error = null,
  onFirstOpen,
  defaultOpen = false,
  live = false,
  renderInlineBlock,
  renderRunBlocks,
}: {
  summary: TraceSummary;
  segments: TraceSegment[] | null;
  loading?: boolean;
  error?: string | null;
  onFirstOpen?: () => void;
  defaultOpen?: boolean;
  live?: boolean;
  renderInlineBlock: (block: TraceBlockDto, key: string) => React.ReactNode;
  renderRunBlocks: (blocks: TraceBlockDto[], live: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasOpenedRef = useRef(defaultOpen);

  // Zero-tool turns: skip the trace shell and just emit the inline blocks
  // in stream order. Only applicable when segments are loaded.
  if (segments && summary.totalSteps === 0) {
    return (
      <>
        {segments.map((seg) =>
          seg.kind === "block" ? (
            <span key={seg.id}>{renderInlineBlock(seg.block, seg.id)}</span>
          ) : null,
        )}
      </>
    );
  }

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !hasOpenedRef.current) {
      hasOpenedRef.current = true;
      onFirstOpen?.();
    }
  };

  return (
    <div className={`rounded-8 ${open ? "bg-surface-muted/60 px-1 py-1" : ""}`}>
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full select-text items-center gap-2 rounded-8 px-2 py-1 text-left hover:bg-surface-muted/80"
      >
        <CollapsedTraceSummary summary={summary} segments={segments ?? undefined} live={live} />
        <span className="ml-auto flex-none text-subtle-foreground">
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      </button>
      {open && (
        <div className="mt-1 px-2 pb-1">
          <TraceBody
            segments={segments}
            loading={loading}
            error={error}
            renderInlineBlock={renderInlineBlock}
            renderRunBlocks={renderRunBlocks}
            live={live}
          />
        </div>
      )}
    </div>
  );
}

export function CollapsedTraceButton({
  summary,
  segments,
  onClick,
  live = false,
  compact = false,
}: {
  summary?: TraceSummary;
  segments?: TraceSegment[];
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
        <CollapsedTraceContent summary={summary} segments={segments} live={live} compact />
      </Button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="transition-all flex w-full select-text items-center gap-2 rounded-8 py-1 px-0 text-left hover:px-2 hover:bg-surface-muted/80"
    >
      <CollapsedTraceContent summary={summary} segments={segments} live={live} />
      <span className="ml-auto flex-none text-subtle-foreground">
        <ChevronRightIcon />
      </span>
    </button>
  );
}

function CollapsedTraceContent({
  summary,
  segments,
  live,
  compact = false,
}: {
  summary?: TraceSummary;
  segments?: TraceSegment[];
  live: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation("activity");

  if (summary?.terminalError) {
    return <TraceErrorSummary error={summary.terminalError} />;
  }
  if (compact && (live || summary)) {
    return (
      <CollapsedTraceSummary
        summary={summary ?? { distinctApps: [], totalSteps: 0, invocationCounts: {} }}
        live={live}
        compact
      />
    );
  }
  if (summary && !isEmptySummary(summary)) {
    return (
      <CollapsedTraceSummary summary={summary} segments={segments} live={live} compact={compact} />
    );
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
  return (
    <div className={compact ? "text-aux text-subtle-foreground" : "text-ui text-subtle-foreground"}>
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
