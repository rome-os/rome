import { useRef } from "react";
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
 * `startedAtMs` is the parent trace's start time for the call; without it the
 * first step's start stands in.
 *
 * With `retain`, a run that was seen running keeps its last numbers after it
 * finishes, with the elapsed time frozen where the run ended, until the caller
 * has a stored summary to show instead. A finished stream holds no connection,
 * so retaining costs only the buffered segments. A run that was never seen
 * running opens no stream.
 */
export function useSubagentProgress({
  turnId,
  running,
  startedAtMs,
  retain = false,
}: {
  turnId: string;
  running: boolean;
  startedAtMs?: number | null;
  retain?: boolean;
}): SubagentProgress {
  const { t } = useTranslation("activity");
  const wasRunning = useRef(false);
  if (running) wasRunning.current = true;
  const retained = !running && retain && wasRunning.current;
  const stream = useTurnStream(turnId, { enabled: running || retained });
  // The clock stops where the run ended: at the stream's `done`, or when the
  // caller reports it no longer running, whichever comes first.
  const endedAt = useRef<number | null>(null);
  const ended = stream.done || !running;
  if (ended && endedAt.current === null) endedAt.current = Date.now();
  const now = useNow(!ended);
  if (!running && !retained) {
    return { label: null, currentStep: null, segments: stream.segments };
  }

  const steps = stream.summary?.totalSteps ?? 0;
  const startMs = startedAtMs ?? firstStepStartMs(stream.segments);
  const elapsed =
    startMs === null ? null : formatDuration(Math.max(0, (endedAt.current ?? now) - startMs));
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
