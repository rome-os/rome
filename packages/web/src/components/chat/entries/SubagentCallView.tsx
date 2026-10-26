import { useRef, useState } from "react";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import { Link } from "react-router-dom";
import type { TraceSegment } from "@rome/api-types/trace-segments";
import { useSubagentProgress } from "@/hooks/use-subagent-progress";
import { artifactLocalName } from "@/lib/artifact-name";
import {
  describeToolSummary,
  formatStepDuration,
  toolCallDotClass,
  type ToolCallStatus,
} from "./ToolCallView";
import { TraceJsonView } from "./TraceJsonView";

type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

function subagentCallStatus(status: SubagentStatus): ToolCallStatus {
  if (status === "completed") return "ok";
  if (status === "failed") return "error";
  if (status === "cancelled") return "pending";
  return "running";
}

export function SubagentCallView({
  agentName,
  input,
  sessionId,
  turnId,
  status,
  output,
  error,
  durationMs,
  startedAt,
  renderSteps,
  live = false,
}: {
  agentName: string;
  input?: unknown;
  sessionId: string;
  turnId: string;
  status: SubagentStatus;
  output?: unknown;
  error?: { message: string; code?: string };
  durationMs?: number;
  /** ISO start of the call; times the elapsed clock while it runs. */
  startedAt?: string;
  /** Renders the subagent's own steps in the expanded view. */
  renderSteps?: (segments: TraceSegment[], live: boolean) => React.ReactNode;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = status === "running";
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const progress = useSubagentProgress({
    turnId,
    running,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
  });
  // The steps stay on screen when the call finishes, so an open row does not
  // empty the moment the stream closes.
  const lastStepsRef = useRef<TraceSegment[]>([]);
  if (progress.segments.length > 0) lastStepsRef.current = progress.segments;
  const steps = lastStepsRef.current;
  const displayAgentName = artifactLocalName(agentName);
  const summary = describeToolSummary(
    displayAgentName,
    input,
    output ?? error,
    status !== "running",
    (k) => k,
  );
  const duration = formatStepDuration(durationMs);

  return (
    <div
      data-open={open}
      className={`group rounded-8 transition-colors ${
        open ? "bg-surface-muted" : "hover:bg-surface-muted/70"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full select-text items-center gap-2 rounded-8 py-2 pr-3 pl-7 text-left"
      >
        <ChevronRightIcon
          className={`h-3 w-3 flex-none text-subtle-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 flex-none rounded-full ${toolCallDotClass(subagentCallStatus(status), live)}`}
        />
        <span
          className="flex-none font-mono text-aux text-foreground"
          title={displayAgentName === agentName ? undefined : agentName}
        >
          {displayAgentName}
        </span>
        {summary ? (
          <span
            title={summary}
            className="min-w-0 flex-1 truncate font-mono text-aux text-muted-foreground"
          >
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          title={progress.currentStep ?? undefined}
          className="flex-none font-mono text-aux tabular-nums text-subtle-foreground"
        >
          {running && progress.label ? progress.label : status}
        </span>
        {duration && (
          <span className="flex-none font-mono text-aux tracking-wide tabular-nums text-subtle-foreground">
            {duration}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 pt-1 pr-3 pb-3 pl-9">
          <Link
            to={`/sessions/${encodeURIComponent(sessionId)}`}
            className="rounded-8 border border-border bg-surface px-2 py-2 text-aux text-foreground hover:bg-surface-muted"
          >
            <span>{displayAgentName}</span>
            <span className="ml-2 text-muted-foreground">{status}</span>
            <span className="mt-1 block font-mono text-aux text-subtle-foreground">
              {sessionId} / {turnId}
            </span>
          </Link>
          {input !== undefined && (
            <section className="flex flex-col gap-2">
              <span className="px-1 text-aux text-subtle-foreground">Input</span>
              <div className="rounded-8 border border-border bg-surface px-2 py-2">
                <TraceJsonView value={input} />
              </div>
            </section>
          )}
          {renderSteps && steps.length > 0 && (
            <section className="flex flex-col gap-2">
              <span className="px-1 text-aux text-subtle-foreground">Steps</span>
              <div className="rounded-8 border border-border bg-surface px-2 py-2">
                {renderSteps(steps, running)}
              </div>
            </section>
          )}
          {(output !== undefined || error !== undefined) && (
            <section className="flex flex-col gap-2">
              <span className="px-1 text-aux text-subtle-foreground">
                {error ? "Error" : "Output"}
              </span>
              <div className="rounded-8 border border-border bg-surface px-2 py-2">
                <TraceJsonView value={error ?? output} />
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
