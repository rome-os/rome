import { useEffect, useState } from "react";
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
  // Until the first lookup settles, the card can't tell a draft from a routine
  // that already exists, so it offers no controls at all.
  | { kind: "checking" }
  | { kind: "draft" }
  | { kind: "creating" }
  // `routineId` is unknown only if a create succeeded without returning a row.
  // `owned`: this card provably made the routine (same key, or created here),
  // so it may pause or delete it; a legacy name match only links to it.
  | { kind: "on"; routineId?: string; enabled: boolean; owned: boolean }
  | { kind: "error"; message: string };

type Busy = "toggle" | "delete" | null;

// Keys the server mints for chat cards (core's CHAT_ROUTINE_KEY_PREFIX). Only a
// card keyed in this namespace may pause or delete what it finds: an app's
// managed routine keys (e.g. `briefing-*`) never belong to a chat card.
const CHAT_ROUTINE_KEY_PREFIX = "chat-routine:";

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
 * explicit instruction (`activate: true`), it used this card's key, so the
 * lookup finds it and the card opens saved. A saved routine links to its run
 * history and can be paused or deleted here, so an auto-enabled routine stays
 * visible and reversible.
 *
 * On mount we look up the routine this card created, so a reload shows its
 * live state instead of re-offering to create a duplicate — or offers to turn
 * it on again if it was deleted. If the lookup fails, the card offers "Turn it
 * on": a keyed create of an existing routine answers with that routine.
 */
export function RoutineDraftCard({
  draft,
  routineKey,
}: {
  draft: RoutineDraftSpec;
  routineKey?: string;
}) {
  const [state, setState] = useState<CardState>({ kind: "checking" });
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listRoutineRefs().then((refs) => {
      if (cancelled) return;
      const created = refs ? findCreatedRoutine(refs, draft.name, routineKey) : undefined;
      setState(
        created
          ? {
              kind: "on",
              routineId: created.id,
              enabled: created.enabled,
              owned: !!routineKey?.startsWith(CHAT_ROUTINE_KEY_PREFIX),
            }
          : { kind: "draft" },
      );
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
      // 409: the keyed routine already existed and was left as it is — it may
      // be paused — so read its real state rather than assume On.
      let enabled = true;
      if (result.status === 409 && result.routineId) {
        const refs = await listRoutineRefs();
        enabled = refs?.find((r) => r.id === result.routineId)?.enabled ?? true;
      }
      setState({ kind: "on", routineId: result.routineId, enabled, owned: true });
    } else {
      setState({
        kind: "error",
        message: result.error ?? `Couldn't turn it on (${result.status}).`,
      });
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setBusy("toggle");
    const result = await setRoutineEnabled(id, enabled);
    setBusy(null);
    setActionError(result.ok ? null : (result.error ?? null));
    if (result.ok) setState({ kind: "on", routineId: id, enabled, owned: true });
  };

  // Deleting returns the card to its draft, so "Turn it on" undoes it.
  const remove = async (id: string) => {
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
              owned={state.owned}
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
      ) : state.kind === "checking" ? null : (
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
  owned,
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
  owned: boolean;
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
  const history = (
    <Button asChild size="sm" variant="outline">
      <Link to={`/routines/${encodeURIComponent(routineId)}`}>
        View run history
        <ArrowRight data-icon="inline-end" />
      </Link>
    </Button>
  );
  // A name-only match on an old card may be an unrelated routine: link to it,
  // but never pause or delete it from here.
  if (!owned) return history;
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
      {history}
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
