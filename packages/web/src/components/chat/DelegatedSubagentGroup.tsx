import { useTranslation } from "react-i18next";
import type { TraceSegment, TraceSubagentSummary } from "@rome/api-types/trace-segments";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/components/agent-trace/CollapsedTraceSummary";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { useSubagentProgress, type SubagentProgress } from "@/hooks/use-subagent-progress";
import { artifactLocalName } from "@/lib/artifact-name";
import { subagentStartMs } from "@/lib/subagent-progress";

function SubagentTraceSummary({
  node,
  progress,
}: {
  node: TraceSubagentSummary;
  progress: SubagentProgress;
}) {
  const { t } = useTranslation("activity");
  if (node.status === "running") {
    return progress.label ? (
      <span>{progress.label}</span>
    ) : (
      <span className="shimmer">{t("trace.summary.activity.thinking")}</span>
    );
  }

  const duration = formatDuration(node.traceSummary?.totalDurationMs);
  // Between the run ending and the stored summary joining in, the last live
  // numbers stand in for it rather than dropping to a bare "completed".
  if (node.status === "completed" && !node.traceSummary && progress.label) {
    return <span>{progress.label}</span>;
  }
  if (node.status !== "completed") {
    const status = t(`trace.subagents.status.${node.status}`);
    return <span>{duration ? `${status}${t("trace.summary.joiner")}${duration}` : status}</span>;
  }

  if (node.traceSummary && node.traceSummary.totalSteps > 0) {
    const steps = t(
      node.traceSummary.totalSteps === 1
        ? "trace.summary.stepsSingle"
        : "trace.summary.stepsMultiple",
      { count: node.traceSummary.totalSteps },
    );
    return <span>{duration ? `${steps}${t("trace.summary.joiner")}${duration}` : steps}</span>;
  }
  return <span>{duration ?? t("trace.subagents.status.completed")}</span>;
}

function SubagentChip({
  node,
  selected,
  iconUrl,
  parentSegments,
  onOpenSubagentTrace,
}: {
  node: TraceSubagentSummary;
  selected?: { sessionId: string; turnId: string | null } | null;
  iconUrl: string | null;
  parentSegments?: readonly TraceSegment[];
  onOpenSubagentTrace: (node: TraceSubagentSummary) => void;
}) {
  const { t } = useTranslation("activity");
  const label = artifactLocalName(node.agentName);
  const isSelected = selected?.sessionId === node.sessionId && selected.turnId === node.turnId;
  const progress = useSubagentProgress({
    turnId: node.turnId,
    running: node.status === "running",
    startedAtMs: subagentStartMs(parentSegments, node.toolUseId),
    retain: !node.traceSummary,
  });
  return (
    <li
      data-subagent-separator
      // The separator is the li's own left edge, drawn by `before`, and the li
      // is pulled 8px left over the row's 16px gap. Where it follows another item
      // on the same line the separator sits mid-gap. Where it starts a line,
      // the whole edge lies outside the row, which clips it, so a wrapped item
      // never begins with a bar. No measuring needed.
      className="relative -ml-2 flex min-w-0 max-w-full items-center pl-2 before:absolute before:left-0 before:top-1/2 before:h-3 before:-translate-y-1/2 before:border-l before:border-border-strong"
    >
      <Button
        type="button"
        // Selection is a variant swap, not a per-site override: ghost's
        // own `hover:bg-muted` would otherwise make a hovered sibling
        // indistinguishable from the aria-current chip. `outline` carries
        // a border that ghost never has, so the two stay apart whether or
        // not the pointer is over them.
        variant={isSelected ? "outline" : "ghost"}
        size="xs"
        aria-current={isSelected ? "true" : undefined}
        aria-label={t("trace.subagents.openTrace", { agent: label })}
        title={progress.currentStep ?? undefined}
        onClick={() => void onOpenSubagentTrace(node)}
        // `shrink` defeats the primitive's base `shrink-0` so a chip wider than
        // the whole row, the only case that still needs it, truncates rather than
        // overflowing. Otherwise the row wraps the chip to its own line.
        className="group/subagent min-w-0 max-w-full shrink justify-start text-left"
      >
        <AgentAvatar
          iconUrl={iconUrl}
          label={label}
          className="size-3 shrink-0 rounded-4 opacity-70 transition-opacity after:rounded-4 group-hover/subagent:opacity-100"
        />
        <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap">
          <span className="shrink-0 text-aux text-muted-foreground transition-colors group-hover/subagent:text-foreground">
            {label}
          </span>
          <span data-subagent-trace-summary className="truncate text-aux text-subtle-foreground">
            <SubagentTraceSummary node={node} progress={progress} />
          </span>
        </span>
      </Button>
    </li>
  );
}

export function DelegatedSubagentGroup({
  subagents,
  selected,
  agentIconByName,
  parentSegments,
  onOpenSubagentTrace,
}: {
  subagents: TraceSubagentSummary[];
  selected?: { sessionId: string; turnId: string | null } | null;
  agentIconByName?: ReadonlyMap<string, string | null>;
  /** The parent trace's segments, which time a running subagent's elapsed clock. */
  parentSegments?: readonly TraceSegment[];
  onOpenSubagentTrace: (node: TraceSubagentSummary) => void;
}) {
  const { t } = useTranslation("activity");
  return (
    <ul
      aria-label={t("trace.subagents.ariaLabel")}
      // `contents` hands the chips to the header line, which wraps and clips them.
      className="contents"
    >
      {subagents.map((node) => (
        <SubagentChip
          key={`${node.toolUseId}:${node.sessionId}:${node.turnId}`}
          node={node}
          selected={selected}
          iconUrl={agentIconByName?.get(node.agentName) ?? null}
          parentSegments={parentSegments}
          onOpenSubagentTrace={onOpenSubagentTrace}
        />
      ))}
    </ul>
  );
}
