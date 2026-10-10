import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BellRing, CalendarClock, Check, Pause, Play } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  createRoutine,
  deleteRoutine,
  listRoutineRefs,
  setRoutineEnabled,
  type RoutineRef,
} from "@/lib/chat-api";
import type { PreviewPayload, RoutineDraftSpec } from "@/lib/chat-types";

type CardState =
  | { kind: "draft" }
  | { kind: "creating" }
  // `routineId` is unknown only if a create succeeded without returning a row.
  | { kind: "on"; routineId?: string; enabled: boolean }
  | { kind: "error"; message: string };

type Busy = "toggle" | "delete" | null;

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
 * The card for a routine the agent proposed via `propose_routine`.
 *
 * A draft waits for the guardian: "Turn it on" creates the routine through
 * POST /api/routines (which also activates it), so confirmation needs no
 * second agent turn. When the agent already created it on the guardian's
 * explicit instruction (`activate: true`), `routineId` is set and the card
 * opens saved. A saved routine links to its run history and can be paused or
 * deleted from here, so an auto-enabled routine stays visible and reversible.
 *
 * On mount we look up the routine this card created, so a reload shows its
 * live state instead of re-offering to create a duplicate — or offers to turn
 * it on again if it was deleted.
 */
export function RoutineDraftCard({
  draft,
  routineKey,
  routineId,
}: {
  draft: RoutineDraftSpec;
  routineKey?: string;
  routineId?: string;
}) {
  const [state, setState] = useState<CardState>(
    routineId ? { kind: "on", routineId, enabled: true } : { kind: "draft" },
  );
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Set once the guardian creates, pauses or deletes from this card. The mount
  // lookup's snapshot may predate that change, so it must not overwrite it.
  const actedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void listRoutineRefs().then((refs) => {
      // A failed load says nothing about the routine; keep what we know.
      if (cancelled || !refs || actedRef.current) return;
      const created = findCreatedRoutine(refs, draft.name, routineKey);
      setState(
        created
          ? { kind: "on", routineId: created.id, enabled: created.enabled }
          : { kind: "draft" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [draft.name, routineKey]);

  const turnOn = async () => {
    actedRef.current = true;
    setState({ kind: "creating" });
    const result = await createRoutine({
      name: draft.name,
      trigger: draft.trigger,
      actionName: draft.actionName,
      args: draft.args,
      ...(routineKey ? { key: routineKey } : {}),
    });
    if (result.ok) {
      setState({ kind: "on", routineId: result.routineId, enabled: true });
    } else {
      setState({
        kind: "error",
        message: result.error ?? `Couldn't turn it on (${result.status}).`,
      });
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    actedRef.current = true;
    setBusy("toggle");
    const result = await setRoutineEnabled(id, enabled);
    setBusy(null);
    setActionError(result.ok ? null : (result.error ?? null));
    if (result.ok) setState({ kind: "on", routineId: id, enabled });
  };

  // Deleting returns the card to its draft, so "Turn it on" undoes it.
  const remove = async (id: string) => {
    actedRef.current = true;
    setBusy("delete");
    const result = await deleteRoutine(id);
    setBusy(null);
    setConfirmingDelete(false);
    setActionError(result.ok ? null : (result.error ?? null));
    if (result.ok) setState({ kind: "draft" });
  };

  const isSchedule = draft.trigger.type === "schedule";
  const isManual = draft.trigger.type === "manual";
  const TriggerIcon = isManual ? Play : isSchedule ? CalendarClock : BellRing;
  const badgeVariant = isManual ? "muted" : isSchedule ? "brand" : "info";
  const badgeLabel = isManual
    ? "Manual routine"
    : isSchedule
      ? "Scheduled routine"
      : "Event routine";
  const error = state.kind === "error" ? state.message : actionError;

  return (
    <div className="mb-3 overflow-hidden rounded-12 border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-4 py-2">
        <Badge variant={badgeVariant} className="gap-2">
          <TriggerIcon aria-hidden />
          {badgeLabel}
        </Badge>
        {state.kind === "on" &&
          (state.enabled ? (
            <Badge variant="success">
              <Check aria-hidden />
              On
            </Badge>
          ) : (
            <Badge variant="muted">
              <Pause aria-hidden />
              Paused
            </Badge>
          ))}
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
          {/* The real bound action, so the agent's summary can't stand in for it. */}
          <SpecRow label="Action" value={draft.actionName} mono />
        </dl>
      </div>

      {error && (
        <div className="border-t border-destructive-border bg-destructive-bg/60 px-4 py-2 text-aux text-destructive-fg">
          {error}
        </div>
      )}

      {state.kind === "on" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-muted/50 px-4 py-2">
          <p className="min-w-0 text-aux text-muted-foreground">
            {!state.enabled
              ? "Paused. It won’t run until you resume it."
              : isManual
                ? 'Saved. It won’t run on its own — use "Run now" in Routines whenever you want it.'
                : "Saved. Next time it matches, Rome will run it within a minute."}
          </p>
          {state.routineId && (
            <SavedControls
              routineId={state.routineId}
              enabled={state.enabled}
              isManual={isManual}
              busy={busy}
              confirmingDelete={confirmingDelete}
              onToggle={toggle}
              onAskDelete={() => setConfirmingDelete(true)}
              onCancelDelete={() => setConfirmingDelete(false)}
              onDelete={remove}
            />
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

function SavedControls({
  routineId,
  enabled,
  isManual,
  busy,
  confirmingDelete,
  onToggle,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  routineId: string;
  enabled: boolean;
  isManual: boolean;
  busy: Busy;
  confirmingDelete: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}) {
  if (confirmingDelete) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-aux text-foreground">Delete this routine?</span>
        <Button size="sm" variant="ghost" onClick={onCancelDelete} disabled={busy !== null}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => onDelete(routineId)}
          disabled={busy !== null}
        >
          {busy === "delete" && <Spinner data-icon="inline-start" size="sm" label="Deleting" />}
          Delete
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* A manual routine never fires on its own, so there is nothing to pause. */}
      {!isManual && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onToggle(routineId, !enabled)}
          disabled={busy !== null}
        >
          {busy === "toggle" && <Spinner data-icon="inline-start" size="sm" label="Saving" />}
          {enabled ? "Pause" : "Resume"}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onAskDelete} disabled={busy !== null}>
        Delete
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link to={`/routines/${encodeURIComponent(routineId)}`}>
          View run history
          <ArrowRight data-icon="inline-end" />
        </Link>
      </Button>
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

function SpecRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-subtle-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-foreground" : "text-foreground"}>{value}</dd>
    </div>
  );
}
