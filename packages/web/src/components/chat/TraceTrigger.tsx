import type { TraceSummary } from "@rome/api-types/trace-segments";
import { CollapsedTraceButton } from "@/components/agent-trace/AgentTrace";
import type { TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";

export function TraceTrigger({
  messageId,
  sessionId,
  turnId,
  summary,
  onOpen,
  errorExplained = false,
}: {
  messageId: string;
  sessionId: string;
  turnId: string | null;
  summary: TraceSummary;
  onOpen: (target: TraceDrawerTarget) => void;
  /** A card beside the turn says why it failed, so the line leaves out the raw error. */
  errorExplained?: boolean;
}) {
  return (
    <CollapsedTraceButton
      summary={summary}
      errorExplained={errorExplained}
      onClick={() => onOpen({ kind: "stored", messageId, sessionId, turnId, summary })}
    />
  );
}
