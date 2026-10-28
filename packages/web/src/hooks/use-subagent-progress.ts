import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "@/components/agent-trace/CollapsedTraceSummary";
import { describeLatestStep, firstStepStartMs } from "@/lib/subagent-progress";
import { useTurnStream } from "./use-turn-stream";

export interface SubagentProgress {
  /** `7 steps · 1m 20s`, or null until the subagent's first step arrives. */
  label: string | null;
  /** The newest call, such as `Bash pnpm test`, for a tooltip. */
  currentStep: string | null;
}

/**
 * Live progress of a running subagent, read from its turn stream (none is opened
 * once it is not running; the stored summary takes over). Elapsed time counts
 * from its first step.
 */
export function useSubagentProgress({
  turnId,
  running,
}: {
  turnId: string;
  running: boolean;
}): SubagentProgress {
  const { t } = useTranslation("activity");
  const stream = useTurnStream(turnId, { enabled: running });
  // The clock ticks each second until the stream ends.
  const [now, setNow] = useState(() => Date.now());
  const ticking = running && !stream.done;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  if (!running) return { label: null, currentStep: null };

  const steps = stream.summary?.totalSteps ?? 0;
  const startMs = firstStepStartMs(stream.segments);
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
  return { label, currentStep: describeLatestStep(stream.segments) };
}
