import { useEffect, useState } from "react";
import { BellRing, CalendarClock, Check, Play } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createRoutine, listRoutineNames } from "@/lib/chat-api";
import type { PreviewPayload, RoutineDraftSpec } from "@/lib/chat-types";
import { useSyncCreatedRoutine } from "@/hooks/use-routines";

type CardState =
  | { kind: "draft" }
  | { kind: "creating" }
  // Definitive success driven by the POST response, so the card can never spin
  // forever if the live routine_created_card push is delayed or dropped.
  | { kind: "created" }
  // Historical guard: a routine of this name already exists and this draft has
  // no companion record, so creation must not be re-offered.
  | { kind: "exists" }
  | { kind: "error"; message: string };

interface RoutineDraftCardProps {
  draft: RoutineDraftSpec;
  sessionId: string;
  turnId: string;
  toolUseId: string;
}

/**
 * The confirm card for a routine the agent proposed via `propose_routine`.
 * Turning it on creates the routine and asks the server to append a durable
 * routine_created_card to this chat. Once that persisted record lands (live, or
 * on reload) render suppresses this draft entirely and shows the record-driven
 * RoutineCreatedCard with the /routines/:id link — this component never owns the
 * completed card's link.
 */
export function RoutineDraftCard({ draft, sessionId, turnId, toolUseId }: RoutineDraftCardProps) {
  const [state, setState] = useState<CardState>({ kind: "draft" });
  const syncCreatedRoutine = useSyncCreatedRoutine();

  // Historical drafts turned on before the persisted routine_created_card record
  // shipped have no companion record, so render still mounts this proposal.
  // Guard the one-click action against creating a duplicate of an already-active
  // routine by settling to a non-clickable state when a routine of this name
  // already exists. This guard never sources the detail link (a historical draft
  // has no record and therefore offers no link); it only disables re-creation.
  useEffect(() => {
    let cancelled = false;
    void listRoutineNames().then((names) => {
      if (cancelled || !names.includes(draft.name)) return;
      setState((prev) => (prev.kind === "draft" ? { kind: "exists" } : prev));
    });
    return () => {
      cancelled = true;
    };
  }, [draft.name]);

  const turnOn = async () => {
    setState({ kind: "creating" });
    const result = await createRoutine({
      name: draft.name,
      trigger: draft.trigger,
      actionName: draft.actionName,
      args: draft.args,
      webchatContext: { sessionId, turnId, toolUseId },
    });
    if (result.ok && result.routine && result.routineId) {
      syncCreatedRoutine(result.routine);
      // Settle from the POST response itself — the routine is created and
      // activated, so never keep spinning if the live push is delayed or lost.
      // The persisted record stays the source of truth for the detail link:
      // when its push lands (or on reload) render replaces this draft with the
      // record-driven RoutineCreatedCard that carries the /routines/:id link.
      setState({ kind: "created" });
      return;
    }
    syncCreatedRoutine(undefined);
    setState({
      kind: "error",
      message: result.error ?? `Couldn't turn it on (${result.status}).`,
    });
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
  const settled = state.kind === "created" || state.kind === "exists";

  return (
    <div className="mb-3 overflow-hidden rounded-12 border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-4 py-2">
        <Badge variant={badgeVariant} className="gap-2">
          <TriggerIcon aria-hidden />
          {badgeLabel}
        </Badge>
        {settled && (
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

      {settled ? (
        <div className="border-t border-border bg-surface-muted/50 px-4 py-2 text-aux text-muted-foreground">
          {isManual
            ? 'Saved. It won’t run on its own — use "Run now" in Routines whenever you want it.'
            : "Saved. Next time it matches, Rome will run it within a minute. Manage it in Routines."}
        </div>
      ) : (
        <div className="flex items-center justify-end border-t border-border bg-surface-muted/60 px-4 py-2">
          <Button
            size="sm"
            onClick={turnOn}
            disabled={state.kind === "creating"}
            aria-label={state.kind === "creating" ? "Turning on routine" : undefined}
          >
            {state.kind === "creating" && <Spinner size="sm" label="Turning on routine" />}
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
