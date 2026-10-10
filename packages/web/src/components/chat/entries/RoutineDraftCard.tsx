import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BellRing, CalendarClock, Check, Play } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createRoutine, listRoutineRefs, type RoutineRef } from "@/lib/chat-api";
import type { PreviewPayload, RoutineDraftSpec } from "@/lib/chat-types";

type CardState =
  | { kind: "draft" }
  | { kind: "creating" }
  // `routineId` is unknown only if a create succeeded without returning a row.
  | { kind: "on"; routineId?: string }
  | { kind: "error"; message: string };

/** The routine this card created, if it still exists. Cards carry a unique
 * `routineKey` the routine was created with; cards written before keys existed
 * fall back to the old name match, limited to routines without a key. */
function findCreatedRoutine(
  refs: RoutineRef[],
  name: string,
  routineKey: string | undefined,
): RoutineRef | undefined {
  return routineKey
    ? refs.find((r) => r.key === routineKey)
    : refs.find((r) => r.key === null && r.name === name);
}

/**
 * The confirm card for a routine the agent proposed via `propose_routine`.
 * Turning it on creates the routine through POST /api/routines (which also
 * activates it), so confirmation needs no second agent turn. On mount we look
 * up the routine this card created, so a reload shows "On" with a link to its
 * run history instead of re-offering to create a duplicate.
 */
export function RoutineDraftCard({
  draft,
  routineKey,
}: {
  draft: RoutineDraftSpec;
  routineKey?: string;
}) {
  const [state, setState] = useState<CardState>({ kind: "draft" });

  useEffect(() => {
    let cancelled = false;
    void listRoutineRefs().then((refs) => {
      const created = findCreatedRoutine(refs, draft.name, routineKey);
      if (!cancelled && created) setState({ kind: "on", routineId: created.id });
    });
    return () => {
      cancelled = true;
    };
  }, [draft.name, routineKey]);

  const turnOn = async () => {
    setState({ kind: "creating" });
    const result = await createRoutine({
      name: draft.name,
      trigger: draft.trigger,
      actionName: draft.actionName,
      args: draft.args,
      ...(routineKey ? { key: routineKey } : {}),
    });
    if (result.ok) {
      setState({ kind: "on", routineId: result.routineId });
    } else {
      setState({
        kind: "error",
        message: result.error ?? `Couldn't turn it on (${result.status}).`,
      });
    }
  };

  const isOn = state.kind === "on";
  const isSchedule = draft.trigger.type === "schedule";
  const isManual = draft.trigger.type === "manual";
  const TriggerIcon = isManual ? Play : isSchedule ? CalendarClock : BellRing;
  const badgeVariant = isManual ? "muted" : isSchedule ? "brand" : "info";
  const badgeLabel = isManual
    ? "Manual routine"
    : isSchedule
      ? "Scheduled routine"
      : "Event routine";

  return (
    <div className="mb-3 overflow-hidden rounded-12 border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-4 py-2">
        <Badge variant={badgeVariant} className="gap-2">
          <TriggerIcon aria-hidden />
          {badgeLabel}
        </Badge>
        {isOn && (
          <Badge variant="success">
            <Check aria-hidden />
            On
          </Badge>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-ui text-foreground">{draft.sentence}</p>

        <dl className="space-y-2 text-aux">
          <SpecRow label={isSchedule || isManual ? "Runs" : "Watches"} value={draft.watchLabel} />
          {draft.filterSummary && <SpecRow label="Only when" value={draft.filterSummary} />}
          {draft.preview ? (
            <PreviewRows preview={draft.preview} />
          ) : (
            <SpecRow label="Then" value={draft.thenSummary} />
          )}
        </dl>
      </div>

      {state.kind === "error" && (
        <div className="border-t border-destructive-border bg-destructive-bg/60 px-4 py-2 text-aux text-destructive-fg">
          {state.message}
        </div>
      )}

      {state.kind === "on" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-muted/50 px-4 py-2">
          <p className="min-w-0 text-aux text-muted-foreground">
            {isManual
              ? 'Saved. It won’t run on its own — use "Run now" in Routines whenever you want it.'
              : "Saved. Next time it matches, Rome will run it within a minute."}
          </p>
          {state.routineId && (
            <Button asChild size="sm" variant="outline">
              <Link to={`/routines/${encodeURIComponent(state.routineId)}`}>
                View run history
                <ArrowRight data-icon="inline-end" />
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-end border-t border-border bg-surface-muted/60 px-4 py-2">
          <Button
            size="sm"
            onClick={turnOn}
            disabled={state.kind === "creating"}
            aria-label={state.kind === "creating" ? "Turning on routine" : undefined}
          >
            {state.kind === "creating" && (
              <Spinner data-icon="inline-start" size="sm" label="Turning on routine" />
            )}
            {state.kind === "creating" ? <span aria-hidden>Turning it on…</span> : "Turn it on"}
          </Button>
        </div>
      )}
    </div>
  );
}

// The action's own ground-truth render of what fires — shown in place of the
// agent's `thenSummary` prose whenever the bound action provides a preview.
function PreviewRows({ preview }: { preview: PreviewPayload }) {
  if (preview.kind === "sensitive_message") {
    return (
      <>
        <SpecRow label="Then" value="Send a message" />
        <SpecRow label="Channel" value={preview.channel} />
        <SpecRow label="Message" value={preview.text} />
      </>
    );
  }
  return (
    <>
      <SpecRow label="Then" value={preview.title} />
      {preview.fields?.map((field) => (
        <SpecRow key={field.label} label={field.label} value={field.value} />
      ))}
      {preview.summary && <SpecRow label="Detail" value={preview.summary} />}
    </>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-subtle-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
