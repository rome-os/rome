import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, Check, ChevronRight, Clock, Radio, X } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { artifactLocalName } from "@/lib/artifact-name";
import { Badge } from "@/components/ui/badge";
import { List, ListRow } from "@/components/ui/list-row";
import { formatDuration } from "@/components/agent-trace/CollapsedTraceSummary";
import { ActionExecutionTree } from "@/components/agent-trace/ActionExecutionTree";
import {
  describeOutcome,
  describeTrigger,
  isScheduleTrigger,
  relativeTime,
  type Routine,
  type RoutineRun,
} from "@/lib/routine-language";
import { useRoutines, useRoutineRuns, useRoutineRunTrace } from "@/hooks/use-routines";
import { PageShell, PageBody, PageHeader } from "@/shell/PageShell";

// Detail view for one routine: a plain-language header over its run history,
// where each run expands to the reconstructed action-execution trace.
export default function RoutineDetailPage() {
  const { t } = useTranslation("routines");
  const { id = "" } = useParams();
  // Reuse the cached list rather than a per-routine endpoint — a deep link just
  // triggers the list fetch, which is small and already the source of truth.
  const { routines, isLoading } = useRoutines();
  const routine = (routines as Routine[] | null)?.find((r) => r.id === id) ?? null;

  return (
    <PageShell>
      <PageBody>
        <Link
          to="/routines"
          className="inline-flex items-center gap-1 text-ui text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("detail.back")}
        </Link>

        {isLoading && !routine ? (
          <p className="text-ui text-subtle-foreground">{t("loading")}</p>
        ) : !routine ? (
          <p className="text-ui text-subtle-foreground">{t("detail.notFound")}</p>
        ) : (
          <>
            <RoutineHeader routine={routine} t={t} />
            <section className="space-y-3">
              <h2 className="text-section text-foreground">{t("detail.runHistory")}</h2>
              <RunHistoryList routineId={routine.id} />
            </section>
          </>
        )}
      </PageBody>
    </PageShell>
  );
}

function RoutineHeader({ routine, t }: { routine: Routine; t: TFunction }) {
  const triggerPhrase = describeTrigger(routine.trigger);
  const outcomePhrase = describeOutcome(routine.actionName, routine.args);
  const trimmed = routine.name.trim();
  // Mirror the card: agent-created routines often name themselves after the
  // action, so fall back to the humanized outcome as the title.
  const hasName =
    trimmed !== "" &&
    trimmed !== routine.actionName &&
    trimmed !== artifactLocalName(routine.actionName);
  const title = hasName ? trimmed : outcomePhrase.charAt(0).toUpperCase() + outcomePhrase.slice(1);
  const TriggerIcon = isScheduleTrigger(routine.trigger) ? Clock : Radio;

  return (
    <PageHeader
      title={title}
      titleAside={!routine.enabled && <Badge variant="muted">{t("routine.badgeDisabled")}</Badge>}
      description={
        <span className="flex items-center gap-1">
          <TriggerIcon className="size-3.5 flex-shrink-0" aria-hidden />
          <span className="min-w-0">
            <span>{triggerPhrase}</span>
            {hasName && (
              <>
                <span className="text-subtle-foreground"> · </span>
                <span>{outcomePhrase}</span>
              </>
            )}
          </span>
        </span>
      }
    />
  );
}

function RunHistoryList({ routineId }: { routineId: string }) {
  const { t } = useTranslation("routines");
  const { runs, isLoading, error } = useRoutineRuns(routineId, true, 25);

  if (isLoading) {
    return <p className="text-aux text-subtle-foreground">{t("history.loading")}</p>;
  }
  if (error) {
    return <p className="text-aux text-destructive-fg">{t("history.error")}</p>;
  }
  if (!runs || runs.length === 0) {
    return <p className="text-aux text-subtle-foreground">{t("history.empty")}</p>;
  }
  return (
    // A run history is a list in the document too, so the section is the `<ul>`
    // rather than a `<div>` beside one, and the hairline stays the section's.
    <List asChild className="overflow-hidden rounded-12 border border-border">
      <ul>
        {runs.map((run) => (
          <RunRow key={run.id} routineId={routineId} run={run} />
        ))}
      </ul>
    </List>
  );
}

// Recent runs read better relative ("5 minutes ago"); older ones are clearer as
// an absolute timestamp ("Jun 23, 2:04 PM") than a vague "yesterday"/weekday.
// Threshold: under 60 minutes old → relative, otherwise absolute.
const RELATIVE_WINDOW_MS = 60 * 60_000;

function runWhen(dateStr: string): string {
  const target = new Date(dateStr).getTime();
  if (Number.isNaN(target)) return relativeTime(dateStr);
  if (Math.abs(Date.now() - target) < RELATIVE_WINDOW_MS) return relativeTime(dateStr);
  return new Date(target).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function runText(run: RoutineRun, t: TFunction): string {
  const when = runWhen(run.firedAt);
  switch (run.status) {
    case "running":
      return t("history.running");
    case "pending_approval":
      return t("history.pending", { when });
    case "cancelled":
      return t("history.cancelled", { when });
    default:
      return t("history.ran", { when });
  }
}

function RunStatusIcon({ status }: { status: RoutineRun["status"] }) {
  switch (status) {
    case "success":
      return <Check className="h-4 w-4 flex-none text-success-fg" aria-hidden />;
    case "error":
      return <X className="h-4 w-4 flex-none text-destructive-fg" aria-hidden />;
    case "running":
      return <Spinner label="Routine run in progress" className="flex-none text-info-fg" />;
    case "pending_approval":
      return <Clock className="h-4 w-4 flex-none text-warning-fg" aria-hidden />;
    default:
      return <span className="h-2 w-2 flex-none rounded-full bg-muted-foreground" aria-hidden />;
  }
}

// One run: a status line that expands to its action-execution trace. The trace
// is lazy — only fetched once the row is opened.
function RunRow({ routineId, run }: { routineId: string; run: RoutineRun }) {
  const { t } = useTranslation("routines");
  const [open, setOpen] = useState(false);
  const { trace, isLoading, error } = useRoutineRunTrace(routineId, run.id, open);
  const duration = formatDuration(run.durationMs ?? undefined);

  return (
    <li>
      <ListRow asChild interactive size="sm">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronRight
            className={`h-4 w-4 flex-none text-subtle-foreground transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          <RunStatusIcon status={run.status} />
          <span className="min-w-0 flex-1 truncate text-foreground">{runText(run, t)}</span>
          {duration && (
            <span className="flex-none font-mono text-aux text-muted-foreground">{duration}</span>
          )}
        </button>
      </ListRow>

      {/* The run-level error reads even when the trace is collapsed. Both this
          and the trace panel below hang off the row, so they take the row's own
          `sm` inset on the right and start under its status icon on the left. */}
      {run.error && (
        <p className="px-2 pb-2 pl-9 font-mono text-aux text-destructive-fg">{run.error}</p>
      )}

      {open && (
        <div className="border-t border-border-subtle bg-surface-muted/30 px-2 py-3 pl-9">
          <h3 className="mb-2 text-aux text-subtle-foreground">{t("detail.trace")}</h3>
          {isLoading ? (
            <p className="text-aux text-subtle-foreground">{t("detail.traceLoading")}</p>
          ) : error ? (
            <p className="text-aux text-destructive-fg">{t("detail.traceError")}</p>
          ) : !trace || trace.roots.length === 0 ? (
            <p className="text-aux text-subtle-foreground">{t("detail.noTrace")}</p>
          ) : (
            <ActionExecutionTree roots={trace.roots} />
          )}
        </div>
      )}
    </li>
  );
}
