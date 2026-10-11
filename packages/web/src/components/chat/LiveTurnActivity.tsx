import { LoaderGrid, useElapsedTimer } from "@rome-os/ui/loading-state";
import { useTranslation } from "react-i18next";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { TranscriptEntry } from "@/components/chat/TranscriptEntry";
import { getThinkingBlockPreview } from "@/components/chat/entries/ThinkingBlock";

export function LiveTurnActivity({
  snapshot,
  textThroughOrdinal = -1,
  hasText,
  entranceKey,
  startedAt,
}: {
  snapshot: TraceSnapshot | null;
  textThroughOrdinal?: number;
  hasText: boolean;
  /** When set, the typing bubble pops in once for this key (see `useEntrance`). */
  entranceKey?: string;
  /** The active turn's stable start, supplied by the chat stream metadata. */
  startedAt?: number;
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
  const thinking = t("trace.summary.activity.thinking");
  const status = label ?? thinking;
  // The loader alone says the agent is running, so plain thinking stays
  // screen-reader-only. Keep the keyed status span's original fade and
  // truncation rather than the shared component's default shimmering label.
  const step = status === thinking ? null : status;
  const typing = (
    <div
      className="flex h-6 items-center gap-2 pl-3 md:max-w-md text-aux text-muted-foreground"
      role="status"
      aria-label="Working"
    >
      <LoaderGrid variant="Orbit" />
      {step ? (
        <span
          key={step}
          className="rome-status-fade min-w-0 truncate text-aux text-muted-foreground"
        >
          {step}
        </span>
      ) : (
        <span className="sr-only">{thinking}</span>
      )}
      <Elapsed startedAt={startedAt} />
    </div>
  );
  if (!entranceKey) return typing;
  return (
    <TranscriptEntry entryKey={entranceKey} live kind="bubble">
      {typing}
    </TranscriptEntry>
  );
}

function Elapsed({ startedAt }: { startedAt?: number }) {
  const elapsed = useElapsedTimer(true, startedAt);
  return (
    <span
      aria-hidden="true"
      data-slot="loading-state-elapsed"
      className="shrink-0 whitespace-nowrap font-mono text-aux text-muted-foreground tabular-nums"
    >
      {elapsed}
    </span>
  );
}
