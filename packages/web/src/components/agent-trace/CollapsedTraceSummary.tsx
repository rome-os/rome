import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AppRefDto, TraceSummary } from "@rome/api-types/trace-segments";

const MAX_ICONS = 5;

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainder}s`;
}

export function CollapsedTraceSummary({
  summary,
  live = false,
  compact = false,
}: {
  summary: TraceSummary;
  live?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    return <CompactCollapsedSummary summary={summary} live={live} />;
  }
  return <DoneCollapsedSummary summary={summary} />;
}

// A single short line (tiny icons + one label), sized to sit under the agent
// name beside the avatar. Used for both live and done traces in the transcript.
function CompactCollapsedSummary({ summary, live }: { summary: TraceSummary; live: boolean }) {
  const { t } = useTranslation("activity");
  const visible = summary.distinctApps.slice(0, MAX_ICONS);
  const appCount = summary.distinctApps.length;
  const stepCount = summary.totalSteps;

  const appsLabel = t(
    appCount === 1 ? "trace.summary.liveAppsSingle" : "trace.summary.liveAppsMultiple",
    { count: appCount },
  );
  const stepsLabel = t(
    stepCount === 1 ? "trace.summary.stepsSingle" : "trace.summary.stepsMultiple",
    { count: stepCount },
  );
  const durationStr = live ? null : formatDuration(summary.totalDurationMs);
  const label =
    appsLabel +
    t("trace.summary.joiner") +
    stepsLabel +
    (durationStr ? `${t("trace.summary.joiner")}${durationStr}` : "") +
    (summary.stoppedByUser ? t("trace.summary.stoppedSuffix") : "") +
    (summary.terminalError ? t("trace.summary.failedSuffix") : "");

  return (
    <div className="flex w-max items-center gap-2 text-aux text-muted-foreground">
      {visible.length > 0 && (
        <div className="flex flex-none items-center -space-x-1">
          {visible.map((app) => (
            <span
              key={app.id}
              className="z-0 inline-flex size-4 items-center justify-center rounded-4 bg-surface-muted"
            >
              <img src={app.iconUrl} alt="" className="size-3" />
            </span>
          ))}
        </div>
      )}
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}

function DoneCollapsedSummary({ summary }: { summary: TraceSummary }) {
  const { t } = useTranslation("activity");
  const visible = summary.distinctApps.slice(0, MAX_ICONS);
  const overflow = summary.distinctApps.length - visible.length;
  const durationStr = formatDuration(summary.totalDurationMs);
  const appCount = summary.distinctApps.length;
  const stepCount = summary.totalSteps;
  const appsLabel = t(
    appCount === 1 ? "trace.summary.appsUsedSingle" : "trace.summary.appsUsedMultiple",
    { count: appCount },
  );
  const stepsLabel = t(
    stepCount === 1 ? "trace.summary.stepsSingle" : "trace.summary.stepsMultiple",
    { count: stepCount },
  );

  return (
    <div className="flex w-full min-w-0 items-center gap-2 text-aux text-muted-foreground">
      <div className="flex items-center -space-x-2">
        {visible.map((app) => (
          <AppIconTile
            key={app.id}
            app={app}
            invocationCount={summary.invocationCounts[app.id] ?? 0}
          />
        ))}
        {overflow > 0 && (
          <span className="z-10 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-8 bg-surface-muted px-1 text-badge text-muted-foreground">
            +{overflow}
          </span>
        )}
      </div>

      <span className="truncate">
        {appsLabel}
        {t("trace.summary.joiner")}
        {stepsLabel}
        {durationStr ? `${t("trace.summary.joiner")}${durationStr}` : ""}
        {summary.stoppedByUser ? t("trace.summary.stoppedSuffix") : ""}
        {summary.terminalError ? t("trace.summary.failedSuffix") : ""}
      </span>
    </div>
  );
}

function AppIconTile({ app, invocationCount }: { app: AppRefDto; invocationCount: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="z-0 inline-flex h-5 w-5 items-center justify-center rounded-8 bg-surface-muted text-foreground">
          <img src={app.iconUrl} alt="" className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {app.name} · {invocationCount}×
      </TooltipContent>
    </Tooltip>
  );
}

export { formatDuration };
