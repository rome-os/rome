// VENDORED from rome-internal with documented seams:
//   packages/web/src/components/agent-trace/AgentTrace.tsx
// Import and typography seams are adapted (see ../VENDOR.md "seams"):
//   - "react-i18next"                       -> ../shims/i18n
//   - "@radix-ui/react-icons"               -> ../shims/icons
//   - "@rome/api-types/trace-segments"      -> ../../../trace/types.js
// Re-sync by recopying the source file and re-applying the documented seams.
import { useRef, useState } from "react";
import { useTranslation } from "../shims/i18n";
import { ChevronDownIcon, ChevronRightIcon } from "../shims/icons";
import type { TraceEventDto, TraceSegment, TraceSummary } from "../../../trace/types.js";
import { CollapsedTraceSummary, formatDuration } from "./CollapsedTraceSummary";
import { TraceRunRow } from "./TraceRunRow";

interface AgentGroup {
  agent: string;
  agentDisplayName: string;
  segments: TraceSegment[];
}

function groupByAgent(segments: TraceSegment[]): AgentGroup[] {
  const groups: AgentGroup[] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    if (last && last.agent === seg.agent) {
      last.segments.push(seg);
    } else {
      groups.push({
        agent: seg.agent,
        agentDisplayName: seg.agentDisplayName,
        segments: [seg],
      });
    }
  }
  return groups;
}

function AgentLabel({ displayName }: { displayName: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span
        className={`inline-flex flex-none items-center rounded-full px-2 py-0.5 text-badge font-medium ring-1 bg-surface-muted text-foreground ring-border`}
      >
        {displayName}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

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
  const groups = segments ? groupByAgent(segments) : [];
  return (
    <div className="space-y-2">
      {loading && <div className="text-xs text-subtle-foreground">{t("trace.loading")}</div>}
      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span>{error}</span>
          {onRetry && !loading && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-4 border border-destructive-border px-2 py-0.5 text-destructive-fg hover:bg-destructive-bg"
            >
              {t("trace.retry")}
            </button>
          )}
        </div>
      )}
      {groups.map((group, gi) => (
        <div key={`group-${gi}-${group.agent}`}>
          <AgentLabel displayName={group.agentDisplayName} />
          <div className="space-y-0.5">
            {group.segments.map((seg) =>
              seg.kind === "run" ? (
                <TraceRunRow key={seg.id} run={seg} renderRunBlocks={renderRunBlocks} live={live} />
              ) : (
                <div key={seg.id} className="text-xs text-foreground">
                  {renderInlineBlock(seg.block, seg.id)}
                </div>
              ),
            )}
          </div>
        </div>
      ))}
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
  renderInlineBlock: (block: TraceEventDto, key: string) => React.ReactNode;
  renderRunBlocks: (blocks: TraceEventDto[], live: boolean) => React.ReactNode;
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
        className="flex w-full items-center gap-2 rounded-8 px-2 py-1.5 text-left hover:bg-surface-muted/80"
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
}: {
  summary?: TraceSummary;
  segments?: TraceSegment[];
  onClick: () => void;
  live?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="transition-all flex w-full items-center gap-2 rounded-8 py-1.5 px-0 text-left hover:px-2 hover:bg-surface-muted/80"
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
}: {
  summary?: TraceSummary;
  segments?: TraceSegment[];
  live: boolean;
}) {
  const { t } = useTranslation("activity");

  if (summary?.terminalError) {
    return <TraceErrorSummary error={summary.terminalError} />;
  }
  if (summary && !isEmptySummary(summary)) {
    return <CollapsedTraceSummary summary={summary} segments={segments} live={live} />;
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
  return <StatusPill label={t("trace.thinking")} pulse />;
}

function StatusPill({ label, pulse = false }: { label: string; pulse?: boolean }) {
  return (
    <div className="text-sm text-subtle-foreground">
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
    <div className="flex min-w-0 items-center gap-2 text-sm text-destructive-fg">
      <span className="inline-block h-2 w-2 flex-none rounded-full bg-destructive" />
      <span className="truncate">{t("trace.failedWithReason", { reason: error })}</span>
    </div>
  );
}

function isEmptySummary(summary?: TraceSummary): boolean {
  if (!summary) return true;
  return summary.totalSteps === 0 && summary.distinctApps.length === 0;
}
