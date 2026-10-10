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
  const thinking = t("trace.summary.activity.thinking");
  const status = label ?? thinking;
  // The rising dots alone say the agent is still running, so plain thinking
  // shows nothing else; spelling it out would repeat the dots. A specific
  // step, such as a thinking preview or the app in use, follows the dots on
  // one line, and a long preview is cut to that line.
  const step = status === thinking ? null : status;
  const typing = (
    <ChatBubble
      tone="received"
      className="flex h-10 items-center gap-2 py-0 md:max-w-md"
      role="status"
      aria-label="Working"
    >
      <span className="flex shrink-0 items-center gap-1" aria-hidden>
        <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" />
        <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" />
        <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" />
      </span>
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
    </ChatBubble>
  );
  if (!entranceKey) return typing;
  return (
    <TranscriptEntry entryKey={entranceKey} live kind="bubble">
      {typing}
    </TranscriptEntry>
  );
}
