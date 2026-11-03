import type { TraceSummary } from "@rome/api-types/trace-segments";
import { CollapsedTraceButton } from "@/components/agent-trace/AgentTrace";
import type { TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";

export function TraceTrigger({
  messageId,
  sessionId,
  turnId,
  summary,
  onOpen,
}: {
  messageId: string;
  sessionId: string;
  turnId: string | null;
  summary: TraceSummary;
  onOpen: (target: TraceDrawerTarget) => void;
}) {
  return (
    <CollapsedTraceButton
      summary={summary}
      onClick={() => onOpen({ kind: "stored", messageId, sessionId, turnId, summary })}
    />
  );
}
