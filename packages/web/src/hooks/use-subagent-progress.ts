import { useTranslation } from "react-i18next";
import type { TraceSegment } from "@rome/api-types/trace-segments";
import { formatDuration } from "@/components/agent-trace/CollapsedTraceSummary";
import { describeLatestStep, firstStepStartMs } from "@/lib/subagent-progress";
import { useNow } from "./use-now";
import { useTurnStream } from "./use-turn-stream";

export interface SubagentProgress {
  /** `7 steps · 1m 20s`, or null until the subagent's first step arrives. */
  label: string | null;
  /** The newest call, such as `Bash pnpm test`, for a tooltip. */
  currentStep: string | null;
  /** The subagent's own segments so far, for rendering its steps. */
  segments: TraceSegment[];
}

/**
 * Live progress of a subagent run, read from its turn stream while it runs.
 * Opens no connection once `running` is false. `startedAtMs` is the parent
 * trace's start time for the call; without it the first step's start stands in.
 */
export function useSubagentProgress({
  turnId,
  running,
  startedAtMs,
}: {
  turnId: string;
  running: boolean;
  startedAtMs?: number | null;
}): SubagentProgress {
  const { t } = useTranslation("activity");
  const stream = useTurnStream(turnId, { enabled: running });
  const now = useNow(running);
  if (!running) return { label: null, currentStep: null, segments: stream.segments };

  const steps = stream.summary?.totalSteps ?? 0;
  const startMs = startedAtMs ?? firstStepStartMs(stream.segments);
  const elapsed = startMs === null ? null : formatDuration(Math.max(0, now - startMs));
  const stepsLabel =
    steps > 0
      ? t(steps === 1 ? "trace.summary.stepsSingle" : "trace.summary.stepsMultiple", {
          count: steps,
        })
      : null;
  const label =
    stepsLabel === null
      ? null
      : elapsed
        ? `${stepsLabel}${t("trace.summary.joiner")}${elapsed}`
        : stepsLabel;
  return { label, currentStep: describeLatestStep(stream.segments), segments: stream.segments };
}
