import { useTranslation } from "react-i18next";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { TranscriptEntry } from "@/components/chat/TranscriptEntry";
import { getThinkingBlockPreview } from "@/components/chat/entries/ThinkingBlock";

export function LiveTurnActivity({
  snapshot,
  textThroughOrdinal = -1,
  hasText,
  entranceKey,
}: {
  snapshot: TraceSnapshot | null;
  textThroughOrdinal?: number;
  hasText: boolean;
  /** When set, the typing bubble pops in once for this key (see `useEntrance`). */
  entranceKey?: string;
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
  // The typing bubble stands for plain thinking on its own. A specific step,
  // such as a thinking preview or the app in use, shows beside it.
  const typing = (
    <div className="flex min-w-0 items-center gap-2" role="status" aria-label="Working">
      <ChatBubble
        tone="received"
        className="flex h-10 shrink-0 items-center gap-1 py-0"
        aria-hidden
      >
        <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" />
        <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" />
        <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" />
      </ChatBubble>
      <span
        className={
          label ? "shimmer line-clamp-1 min-w-0 text-aux text-muted-foreground" : "sr-only"
        }
      >
        {label ?? t("trace.summary.activity.thinking")}
      </span>
    </div>
  );
  if (!entranceKey) return typing;
  return (
    <TranscriptEntry entryKey={entranceKey} live kind="bubble">
      {typing}
    </TranscriptEntry>
  );
}
