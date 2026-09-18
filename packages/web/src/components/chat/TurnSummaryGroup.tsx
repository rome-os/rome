import { useCallback, useEffect, useRef, useState } from "react";
import { AlignLeft, Check, Pause, Play } from "lucide-react";
import type { AgentPlan, AgentPlanStep } from "@rome/api-types/trace-segments";
import Markdown from "@/components/chat/ChatMarkdown";
import { CollapsibleCard, CollapsibleSection } from "@/components/chat/CollapsibleCard";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export interface TurnRecapSummary {
  content: string;
  audioUrl?: string;
  audioMimeType?: string;
  audioDurationMs?: number;
}

function StepMarker({ step }: { step: AgentPlanStep }) {
  if (step.status === "completed") {
    return (
      <span className="flex size-5 items-center justify-center text-muted-foreground" aria-hidden>
        <Check className="size-4" strokeWidth={2.25} aria-hidden />
      </span>
    );
  }
  if (step.status === "in_progress") {
    return (
      <span className="flex size-5 items-center justify-center" aria-hidden>
        <span className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
      </span>
    );
  }
  return (
    <span className="flex size-5 items-center justify-center" aria-hidden>
      <span className="size-1.5 rounded-full bg-subtle-foreground" />
    </span>
  );
}

function PlanStateMarker({ complete, progress }: { complete: boolean; progress: number }) {
  if (complete) {
    return (
      <span
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
        aria-hidden
      >
        <Check className="size-3" strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(var(--primary) ${progress}%, var(--border-strong) ${progress}% 100%)`,
      }}
      aria-hidden
    >
      <span className="size-3.5 rounded-full bg-surface" />
    </span>
  );
}

function statusLabel(status: AgentPlanStep["status"]): string {
  if (status === "completed") return "Completed";
  if (status === "in_progress") return "In progress";
  return "Pending";
}

function RecapContent({ recap }: { recap: TurnRecapSummary }) {
  return (
    <>
      {recap.audioUrl ? (
        <RecapAudioPlayer
          audioUrl={recap.audioUrl}
          audioMimeType={recap.audioMimeType}
          audioDurationMs={recap.audioDurationMs}
        />
      ) : null}
      <Markdown className="text-foreground" compact>
        {recap.content}
      </Markdown>
    </>
  );
}

export function TurnSummaryGroup({
  plan,
  recap,
  live = false,
}: {
  plan?: AgentPlan | null;
  recap?: TurnRecapSummary | null;
  live?: boolean;
}) {
  const steps = plan?.steps ?? [];
  const hasPlan = steps.length > 0;
  const completed = steps.filter((step) => step.status === "completed").length;
  const allComplete = hasPlan && completed === steps.length;
  const [planExpanded, setPlanExpanded] = useState(!allComplete);
  const [recapExpanded, setRecapExpanded] = useState(false);

  useEffect(() => {
    setPlanExpanded(!allComplete);
  }, [allComplete]);

  if (!hasPlan && !recap) return null;

  const activeStep = steps.find((step) => step.status === "in_progress");
  const status = live ? "In progress" : allComplete ? "Completed" : "Incomplete";
  const progress = hasPlan ? Math.round((completed / steps.length) * 100) : 0;
  const label = hasPlan && recap ? "Turn summary" : hasPlan ? "Agent plan" : "Turn recap";

  return (
    <>
      {/* Outside the card so a closed plan does not hide it from the reader. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {live && activeStep ? `In progress: ${activeStep.activeText || activeStep.text}` : ""}
      </span>
      <CollapsibleCard className="my-2 text-ui" role="region" aria-label={label}>
        {hasPlan ? (
          <CollapsibleSection
            data-summary-item="plan"
            open={planExpanded}
            onOpenChange={setPlanExpanded}
            title={
              <>
                <PlanStateMarker complete={allComplete} progress={progress} />
                <span className="flex min-w-0 items-baseline gap-2">
                  <h3 className="shrink-0 text-ui text-foreground">Plan</h3>
                  <p
                    className={cn(
                      "truncate text-aux",
                      live || allComplete ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {status}
                  </p>
                </span>
              </>
            }
            meta={
              <span className="shrink-0 text-aux tabular-nums text-muted-foreground">
                {completed} of {steps.length}
              </span>
            }
            bodyClassName="px-4 py-3"
          >
            {plan?.explanation ? (
              <p className="mb-2 pl-7 text-aux text-muted-foreground">{plan.explanation}</p>
            ) : null}
            <ol className="space-y-1">
              {steps.map((step, index) => {
                const visibleText =
                  step.status === "in_progress" && step.activeText ? step.activeText : step.text;
                return (
                  <li
                    key={step.id ?? `${step.text}-${index}`}
                    className="grid min-h-6 grid-cols-[20px_minmax(0,1fr)] items-start gap-2 py-1"
                    aria-label={`${statusLabel(step.status)}: ${visibleText}`}
                  >
                    <StepMarker step={step} />
                    <span
                      className={cn(
                        "transition-colors duration-200 motion-reduce:transition-none",
                        step.status === "completed" && "text-muted-foreground",
                        step.status === "in_progress" && ["text-foreground", live && "shimmer"],
                        step.status === "pending" && "text-subtle-foreground",
                      )}
                    >
                      {visibleText}
                    </span>
                  </li>
                );
              })}
            </ol>
          </CollapsibleSection>
        ) : null}

        {recap ? (
          <CollapsibleSection
            data-summary-item="recap"
            open={recapExpanded}
            onOpenChange={setRecapExpanded}
            title={
              <>
                <span
                  className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                  aria-hidden
                >
                  <AlignLeft className="size-3.5" strokeWidth={2.25} />
                </span>
                <h3 className="truncate text-ui text-foreground">Recap</h3>
              </>
            }
            meta={
              recap.audioDurationMs && recap.audioDurationMs > 0 ? (
                <span className="shrink-0 text-aux tabular-nums text-muted-foreground">
                  {formatTime(recap.audioDurationMs / 1000)}
                </span>
              ) : null
            }
            bodyClassName="px-4 py-3"
          >
            <RecapContent recap={recap} />
          </CollapsibleSection>
        ) : null}
      </CollapsibleCard>
    </>
  );
}

function RecapAudioPlayer({
  audioUrl,
  audioMimeType,
  audioDurationMs,
}: {
  audioUrl: string;
  audioMimeType?: string;
  audioDurationMs?: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(
    audioDurationMs && audioDurationMs > 0 ? audioDurationMs / 1000 : 0,
  );

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }, []);

  const seek = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const el = audioRef.current;
      if (!el || duration <= 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      el.currentTime = ratio * duration;
      setCurrentTime(el.currentTime);
    },
    [duration],
  );

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div className="mb-3 flex items-center gap-2">
      <IconButton
        size="sm"
        onClick={toggle}
        label={isPlaying ? "Pause recap" : "Play recap"}
        icon={
          isPlaying ? (
            <Pause className="size-3" fill="currentColor" strokeWidth={0} />
          ) : (
            <Play className="size-3 translate-x-px" fill="currentColor" strokeWidth={0} />
          )
        }
        className="rounded-full bg-foreground text-background hover:bg-foreground hover:opacity-80"
      />
      <span className="flex-none text-aux tabular-nums text-muted-foreground">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <div
        role="slider"
        aria-label="Seek recap"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        tabIndex={0}
        onClick={seek}
        className="group relative h-4 flex-1"
      >
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        <span
          className="absolute left-0 top-1/2 h-px -translate-y-1/2 bg-foreground"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
      >
        <source src={audioUrl} type={audioMimeType} />
      </audio>
    </div>
  );
}

function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
