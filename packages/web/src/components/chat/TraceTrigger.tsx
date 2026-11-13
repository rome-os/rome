import type { TraceSummary } from "@rome/api-types/trace-segments";
import { CollapsedTraceButton } from "@/components/agent-trace/AgentTrace";
import type { TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";
import { ErrorEventView, hasGuidedErrorCopy } from "./entries/ErrorEventView";

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
  const trigger = (
    <CollapsedTraceButton
      summary={summary}
      onClick={() => onOpen({ kind: "stored", messageId, sessionId, turnId, summary })}
    />
  );
  // A turn that failed with guidance, such as credits used up, shows the same
  // guidance as the banner did while it ran, so a reload keeps the way to fix it.
  if (!summary.terminalError || !hasGuidedErrorCopy(summary.terminalErrorCode)) return trigger;
  return (
    <div>
      {trigger}
      <ErrorEventView
        className="mt-1"
        error={summary.terminalError}
        code={summary.terminalErrorCode}
        provider={summary.terminalErrorProvider}
        reason={summary.terminalErrorReason}
      />
    </div>
  );
}
