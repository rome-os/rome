import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BellRing, CalendarClock, ChevronDown, MoreHorizontal, Play } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  createRoutine,
  deleteRoutine,
  listRoutineRefs,
  setRoutineEnabled,
  type RoutineRef,
} from "@/lib/chat-api";
import type { RoutineDraftSpec } from "@/lib/chat-types";
import { useRoutines, useRunRoutineNow } from "@/hooks/use-routines";

type CardState =
  // Until the first lookup settles, the card can't tell a draft from a routine
  // that already exists, so it offers no controls at all.
  | { kind: "checking" }
  | { kind: "draft" }
  | { kind: "creating" }
  // `routineId` is unknown only if a create succeeded without returning a row.
  // `owned`: this card provably made the routine (same key, or created here),
  // so it may pause or delete it; a legacy name match only links to it.
  // `enabled` is null when the routine exists but its state couldn't be read.
  | { kind: "on"; routineId?: string; enabled: boolean | null; owned: boolean }
  | { kind: "error"; message: string };

type Busy = "toggle" | "delete" | "run" | null;

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
 * second agent turn. Before it exists there is no routine page, so the draft
 * carries its own disclosure of what will run: the action's preview and the
 * real bound action id.
 *
 * Once saved, the card is one row: the sentence links to the routine's page
 * (run history and what it runs), next to its status and a menu to pause or
 * delete it, so an auto-enabled routine (`activate: true`, created with this
 * card's key) stays visible and reversible.
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
  const { t } = useTranslation("chat");
  const { t: tRoutines } = useTranslation("routines");
  const [state, setState] = useState<CardState>({ kind: "checking" });
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The Routines page's own run path, so the routine's run history refreshes.
  const runRoutineNow = useRunRoutineNow();
  // Whether a run is going, from the Routines page's list (which a run
  // invalidates): the server doesn't serialize runs, so Run now waits.
  const { routines, refetch: refetchRoutines } = useRoutines();

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
      let enabled: boolean | null = true;
      if (result.status === 409 && result.routineId) {
        const refs = await listRoutineRefs();
        enabled = refs?.find((r) => r.id === result.routineId)?.enabled ?? null;
      }
      setState({ kind: "on", routineId: result.routineId, enabled, owned: true });
    } else {
      setState({
        kind: "error",
        message: result.error ?? t("routineCard.createFailed", { status: result.status }),
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

  // A run that fails is not an HTTP error: the route answers with
  // `status: "error"`, so that counts as a failure too.
  const runNow = async (id: string) => {
    setBusy("run");
    let error: string | null = null;
    try {
      const outcome = await runRoutineNow(id);
      if (outcome.status === "error") error = outcome.error ?? tRoutines("errors.runFailed");
    } catch (err) {
      error = err instanceof Error ? err.message : tRoutines("errors.runFailed");
    }
    setBusy(null);
    setActionError(error);
  };

  const isSchedule = draft.trigger.type === "schedule";
  const isManual = draft.trigger.type === "manual";
  const TriggerIcon = isManual ? Play : isSchedule ? CalendarClock : BellRing;
  const error = state.kind === "error" ? state.message : actionError;
  const saved = state.kind === "on" ? state : null;
  const running = routines?.find((r) => r.id === saved?.routineId)?.lastRun?.status === "running";
  const isDraft = state.kind === "draft" || state.kind === "creating" || state.kind === "error";

  const title = (
    <span className="flex min-w-0 items-start gap-3">
      <span className="flex h-5 shrink-0 items-center">
        <TriggerIcon className="size-4 text-subtle-foreground" aria-hidden />
      </span>
      <span className="min-w-0 text-section text-foreground wrap-anywhere group-hover/title:underline">
        {draft.sentence}
      </span>
    </span>
  );

  return (
    <div
      tabIndex={-1}
      data-chat-pending-card={isDraft ? "" : undefined}
      className="mb-3 rounded-12 border border-border bg-surface px-4 py-3"
    >
      <div
        className={cn(
          "flex items-start justify-between gap-x-4 gap-y-2",
          // A saved row keeps its status and menu beside the title at any
          // width; a draft's button or the delete confirmation may wrap below.
          (!saved || confirmingDelete) && "flex-wrap",
        )}
      >
        {/* Left zone: the only navigation target once the routine exists. */}
        {saved?.routineId ? (
          <Link
            to={`/routines/${encodeURIComponent(saved.routineId)}`}
            className="group/title min-w-0 flex-1 basis-56 rounded-8 outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
          >
            {title}
          </Link>
        ) : (
          <div className="min-w-0 flex-1 basis-56">
            {title}
            {isDraft && (
              // What it watches, and what will run: there is no routine page to
              // open before it exists.
              <p className="mt-1 pl-7 text-aux text-muted-foreground">
                {[draft.watchLabel, draft.filterSummary].filter(Boolean).join(" · ")}
                <span className="text-subtle-foreground"> · </span>
                <button
                  type="button"
                  onClick={() => setDetailsOpen((open) => !open)}
                  aria-expanded={detailsOpen}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  {t("routineCard.details")}
                  <ChevronDown
                    className={cn("size-3.5 transition-transform", detailsOpen && "rotate-180")}
                    aria-hidden
                  />
                </button>
              </p>
            )}
          </div>
        )}

        {/* Right zone: status and actions; never navigates. */}
        {state.kind !== "checking" && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {saved ? (
              confirmingDelete && saved.routineId ? (
                <DeleteConfirmation
                  busy={busy}
                  onCancel={() => setConfirmingDelete(false)}
                  onDelete={() => remove(saved.routineId!)}
                />
              ) : (
                <>
                  <SavedStatus
                    enabled={saved.enabled}
                    isManual={isManual}
                    running={busy === "run"}
                    busy={busy}
                  />
                  {/* A name-only match on an old card may be an unrelated
                      routine: it links, but is never paused or deleted here. */}
                  {saved.owned && saved.routineId && (
                    <SavedMenu
                      enabled={saved.enabled}
                      isManual={isManual}
                      running={running}
                      disabled={busy !== null}
                      onOpen={() => void refetchRoutines()}
                      onToggle={() => toggle(saved.routineId!, !saved.enabled)}
                      onRun={() => runNow(saved.routineId!)}
                      onAskDelete={() => setConfirmingDelete(true)}
                    />
                  )}
                </>
              )
            ) : (
              <Button
                size="sm"
                onClick={turnOn}
                disabled={state.kind === "creating"}
                aria-label={state.kind === "creating" ? t("routineCard.turningOnLabel") : undefined}
              >
                {state.kind === "creating" && (
                  <Spinner
                    data-icon="inline-start"
                    size="sm"
                    label={t("routineCard.turningOnLabel")}
                  />
                )}
                {state.kind === "creating" ? (
                  <span aria-hidden>{t("routineCard.turningOn")}</span>
                ) : (
                  t("routineCard.turnOn")
                )}
              </Button>
            )}
          </div>
        )}
      </div>

      {isDraft && detailsOpen && <DraftDetails draft={draft} />}

      {error && <p className="mt-2 pl-7 text-aux text-destructive-fg">{error}</p>}
    </div>
  );
}

function SavedStatus({
  enabled,
  isManual,
  running,
  busy,
}: {
  enabled: boolean | null;
  isManual: boolean;
  running: boolean;
  busy: Busy;
}) {
  const { t } = useTranslation("chat");
  if (running) {
    return (
      <span className="flex h-5 items-center gap-2 text-aux text-muted-foreground">
        <Spinner size="sm" label={t("routineCard.running")} />
        {t("routineCard.running")}
      </span>
    );
  }
  // A manual routine never fires on its own, so "On" says nothing; Paused still
  // matters, since it can't be run. An unreadable state has no honest label.
  if (enabled === null || (isManual && enabled)) return null;
  return (
    <span className="flex h-5 items-center gap-2 text-aux text-muted-foreground">
      {busy === "toggle" ? (
        <Spinner size="sm" label={t("routineCard.saving")} />
      ) : (
        <span
          className={cn("size-2 rounded-full", enabled ? "bg-success" : "bg-muted-foreground")}
          aria-hidden
        />
      )}
      {enabled ? t("routineCard.on") : t("routineCard.paused")}
    </span>
  );
}

function SavedMenu({
  enabled,
  isManual,
  running,
  disabled,
  onOpen,
  onToggle,
  onRun,
  onAskDelete,
}: {
  enabled: boolean | null;
  isManual: boolean;
  running: boolean;
  disabled: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRun: () => void;
  onAskDelete: () => void;
}) {
  const { t } = useTranslation("chat");
  // An enabled manual routine offers Run now instead of Pause, but not while a
  // run is still going (as on the Routines page; the server doesn't serialize
  // runs). Anything else with a known state offers Pause / Resume.
  const first =
    isManual && enabled ? (
      running ? null : (
        <DropdownMenuItem onSelect={onRun}>{t("routineCard.runNow")}</DropdownMenuItem>
      )
    ) : enabled !== null ? (
      <DropdownMenuItem onSelect={onToggle}>
        {enabled ? t("routineCard.pause") : t("routineCard.resume")}
      </DropdownMenuItem>
    ) : null;
  return (
    // Re-read on open, so a run that ended since the card loaded frees Run now.
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="xs"
          label={t("routineCard.more")}
          icon={<MoreHorizontal />}
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {first}
        {first && <DropdownMenuSeparator />}
        <DropdownMenuItem variant="destructive" onSelect={onAskDelete}>
          {t("routineCard.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteConfirmation({
  busy,
  onCancel,
  onDelete,
}: {
  busy: Busy;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <>
      <span className="text-aux text-foreground">{t("routineCard.deleteConfirm")}</span>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy !== null}>
        {t("routineCard.cancel")}
      </Button>
      <Button size="sm" variant="destructive" onClick={onDelete} disabled={busy !== null}>
        {busy === "delete" && (
          <Spinner data-icon="inline-start" size="sm" label={t("routineCard.deleting")} />
        )}
        {t("routineCard.delete")}
      </Button>
    </>
  );
}

// What a draft will run. The action's own preview is the ground truth and
// stands in for the agent's `thenSummary` prose whenever the action provides
// one; the real bound action id is always shown, so no summary can stand in
// for it.
function DraftDetails({ draft }: { draft: RoutineDraftSpec }) {
  const { t } = useTranslation("chat");
  const preview = draft.preview;
  const body = preview
    ? preview.kind === "sensitive_message"
      ? preview.text
      : preview.summary
    : undefined;
  return (
    <div className="mt-2 space-y-2 pl-7 text-aux">
      {body && <p className="whitespace-pre-wrap text-foreground wrap-anywhere">{body}</p>}
      <dl className="space-y-1">
        {preview?.kind === "sensitive_message" ? (
          <>
            <SpecRow label={t("routineCard.then")} value={t("routineCard.sendMessage")} />
            <SpecRow label={t("routineCard.channel")} value={preview.channel} />
          </>
        ) : preview ? (
          <>
            <SpecRow label={t("routineCard.then")} value={preview.title} />
            {preview.fields?.map((field) => (
              <SpecRow key={field.label} label={field.label} value={field.value} />
            ))}
          </>
        ) : (
          <SpecRow label={t("routineCard.then")} value={draft.thenSummary} />
        )}
        <SpecRow label={t("routineCard.action")} value={draft.actionName} mono />
      </dl>
    </div>
  );
}

function SpecRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-subtle-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-foreground", mono ? "break-all font-mono" : "wrap-anywhere")}>
        {value}
      </dd>
    </div>
  );
}
