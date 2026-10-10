import { useTranslation } from "react-i18next";
import type { TraceSubagentSummary } from "@rome/api-types/trace-segments";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/components/agent-trace/CollapsedTraceSummary";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { artifactLocalName } from "@/lib/artifact-name";

function SubagentTraceSummary({ node }: { node: TraceSubagentSummary }) {
  const { t } = useTranslation("activity");
  if (node.status === "running") {
    return <span className="shimmer">{t("trace.summary.activity.thinking")}</span>;
  }

  const duration = formatDuration(node.traceSummary?.totalDurationMs);
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

export function DelegatedSubagentGroup({
  subagents,
  selected,
  agentIconByName,
  onOpenSubagentTrace,
}: {
  subagents: TraceSubagentSummary[];
  selected?: { sessionId: string; turnId: string | null } | null;
  agentIconByName?: ReadonlyMap<string, string | null>;
  onOpenSubagentTrace: (node: TraceSubagentSummary) => void;
}) {
  const { t } = useTranslation("activity");
  return (
    <ul
      aria-label={t("trace.subagents.ariaLabel")}
      className="flex min-w-0 items-center overflow-hidden"
    >
      {subagents.map((node) => {
        const key = `${node.sessionId}:${node.turnId}`;
        const label = artifactLocalName(node.agentName);
        const isSelected =
          selected?.sessionId === node.sessionId && selected.turnId === node.turnId;
        return (
          <li key={`${node.toolUseId}:${key}`} className="flex min-w-0 items-center">
            <span
              data-subagent-separator
              aria-hidden="true"
              className="mx-2 shrink-0 text-aux text-border-strong"
            >
              |
            </span>
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
              onClick={() => void onOpenSubagentTrace(node)}
              // `shrink` defeats the primitive's base `shrink-0`: the row is
              // overflow-hidden, so without it a crowded list drops whole chips
              // off the end instead of narrowing every chip.
              className="group/subagent min-w-0 shrink max-w-48 justify-start text-left"
            >
              <AgentAvatar
                iconUrl={agentIconByName?.get(node.agentName) ?? null}
                label={label}
                className="size-3 shrink-0 rounded-4 opacity-70 transition-opacity after:rounded-4 group-hover/subagent:opacity-100"
              />
              <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap">
                <span className="shrink-0 text-aux text-muted-foreground transition-colors group-hover/subagent:text-foreground">
                  {label}
                </span>
                <span
                  data-subagent-trace-summary
                  className="truncate text-aux text-subtle-foreground"
                >
                  <SubagentTraceSummary node={node} />
                </span>
              </span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
