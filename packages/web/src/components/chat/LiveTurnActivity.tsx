import { useTranslation } from "react-i18next";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { getThinkingBlockPreview } from "@/components/chat/blocks/ThinkingBlock";

export function LiveTurnActivity({
  snapshot,
  textThroughOrdinal = -1,
  hasText,
}: {
  snapshot: TraceSnapshot | null;
  textThroughOrdinal?: number;
  hasText: boolean;
}) {
  const { t } = useTranslation("activity");
  if (snapshot?.summary.turnStatus || snapshot?.summary.terminalError) return null;

  const latest = snapshot?.segments.at(-1);
  let label: string | undefined;
  if (latest && latest.ordinal > textThroughOrdinal) {
    if (latest.kind === "block" && latest.block.type === "thinking") {
      label = getThinkingBlockPreview(
        latest.block.content.trim(),
        t("trace.summary.activity.thinking"),
      );
    } else if (latest.kind === "run") {
      // The trace pairs each result immediately after its invocation, even
      // when parallel tools finish out of order.
      label = t("trace.summary.activity.thinking");
      for (const segment of snapshot!.segments.toReversed()) {
        if (segment.kind !== "run" || segment.ordinal <= textThroughOrdinal) break;
        const pending = segment.blocks.some((block, index) => {
          const next = segment.blocks[index + 1];
          return (
            (block.type === "tool_use" && next?.type !== "tool_result") ||
            (block.type === "subagent_start" && next?.type !== "subagent_result")
          );
        });
        if (pending) {
          label = t("trace.summary.activity.usingApp", { app: segment.app.name });
          break;
        }
      }
    }
  }

  if (!label && (hasText || snapshot?.summary.plan?.steps.length)) return null;
  return (
    <div className="text-body text-muted-foreground" role="status" aria-label="Working">
      <span className="shimmer line-clamp-2 w-fit">
        {label ?? t("trace.summary.activity.thinking")}
      </span>
    </div>
  );
}
