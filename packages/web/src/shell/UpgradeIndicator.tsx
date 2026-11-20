import { ArrowUp, CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useConciergeName } from "@/hooks/use-concierge";
import { useDashboardIdentity } from "@/hooks/use-dashboard-identity";
import { useSystemUpgrade } from "@/hooks/use-system-upgrade";
import { useUpgradeAvailable } from "@/hooks/use-upgrade-available";

type RowState =
  | { kind: "available"; version: string }
  | { kind: "updating"; version: string }
  | { kind: "failed"; version: string }
  | { kind: "updated"; version: string };

/**
 * The sidebar's upgrade row, under the Rome logo. Shown to anyone signed in to
 * the dashboard, the guardian or a visitor, whenever Rome Cloud offers a newer
 * release. A click confirms, and the upgrade then runs in the background while
 * the row shows how it goes: updating, a failure with Retry, and at the end
 * "updated" with Reload. The page is not reloaded for the viewer, since a
 * reload drops what they have not sent yet; the row stays until they reload.
 *
 * `labelled` is the rail with names shown: a full row. Without names it is
 * the icon alone, and the tooltip carries the text.
 *
 * `suppressed` hides the offer while the nightly upgrade banner is up, so
 * there is one way in at a time. An upgrade already running here keeps its
 * row.
 */
export function UpgradeIndicator({
  suppressed,
  labelled,
}: {
  suppressed: boolean;
  labelled: boolean;
}) {
  const identity = useDashboardIdentity();
  const kind = identity.data?.kind;
  const { latest, current, recheck, rechecking } = useUpgradeAvailable(
    kind === "guardian" || kind === "visitor",
  );
  const upgrade = useSystemUpgrade(recheck, { finish: "report" });
  const [open, setOpen] = useState(false);
  const name = useConciergeName();

  // An accepted request ends the confirmation for good; the row carries the
  // rest, and nothing reopens the dialog without a click.
  const accepted = upgrade.restartingTo !== null;
  useEffect(() => {
    if (accepted) setOpen(false);
  }, [accepted]);

  const state: RowState | null =
    upgrade.upgradedTo !== null
      ? { kind: "updated", version: upgrade.upgradedTo }
      : upgrade.restartingTo !== null
        ? {
            kind: upgrade.restartTimedOut && !upgrade.retrying ? "failed" : "updating",
            version: upgrade.restartingTo,
          }
        : latest !== null && !suppressed
          ? { kind: "available", version: latest }
          : null;

  return (
    <>
      {state ? (
        <UpgradeRow
          state={state}
          name={name}
          labelled={labelled}
          // A retry that could not be sent keeps the failed row; its reason
          // goes in the tooltip.
          reason={state.kind === "failed" ? upgrade.error : null}
          onClick={() => {
            if (state.kind === "available") {
              upgrade.reset();
              setOpen(true);
            } else if (state.kind === "failed") {
              upgrade.retry();
            } else if (state.kind === "updated") {
              window.location.reload();
            }
          }}
        />
      ) : null}
      <UpgradeDialog
        open={open && latest !== null && !accepted}
        name={name}
        latest={latest}
        current={current}
        rechecking={rechecking}
        upgrade={upgrade}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function UpgradeRow({
  state,
  name,
  labelled,
  reason,
  onClick,
}: {
  state: RowState;
  name: string;
  labelled: boolean;
  reason: string | null;
  onClick: () => void;
}) {
  const { t } = useTranslation("common");
  const { version } = state;
  const icon: ReactNode =
    state.kind === "available" ? (
      <ArrowUp aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
    ) : state.kind === "updating" ? (
      <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
    ) : state.kind === "failed" ? (
      <CircleAlert aria-hidden className="size-3.5 shrink-0" />
    ) : (
      <CircleCheck aria-hidden className="size-3.5 shrink-0" />
    );
  // The row's own line is short and leaves the agent out; the tooltip and
  // the accessible name carry the whole sentence.
  const text =
    state.kind === "available"
      ? t("upgradeIndicator.available", { version })
      : state.kind === "updating"
        ? t("upgradeIndicator.updating", { version })
        : state.kind === "failed"
          ? t("upgradeIndicator.failed")
          : t("upgradeIndicator.updated");
  const sentence =
    state.kind === "available"
      ? t("upgradeIndicator.availableFull", { name, version })
      : state.kind === "updating"
        ? t("upgradeIndicator.updatingFull", { name, version })
        : state.kind === "failed"
          ? reason
            ? t("upgradeIndicator.failedReason", { version, message: reason })
            : t("upgradeIndicator.failedFull", { version })
          : t("upgradeIndicator.updatedFull", { name, version });
  const action =
    state.kind === "failed"
      ? t("upgradeIndicator.retry")
      : state.kind === "updated"
        ? t("upgradeIndicator.reload")
        : null;
  const full = action ? `${sentence} · ${action}` : sentence;

  const shape = labelled
    ? "flex h-8 w-full min-w-0 items-center gap-2 rounded-8 px-2 text-left text-aux font-medium"
    : "flex size-8 items-center justify-center rounded-8";
  const className = `rome-upgrade-row ${shape} transition outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50`;

  const body = labelled ? (
    <>
      {icon}
      {/* One line: the text gives way with an ellipsis, the action at the
          end never does. */}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {action ? <span className="shrink-0 font-semibold">{action}</span> : null}
    </>
  ) : (
    icon
  );

  // Updating is a status, not a control: nothing to click until it ends.
  const element =
    state.kind === "updating" ? (
      <div role="status" aria-label={full} className={className}>
        {body}
      </div>
    ) : (
      <button type="button" aria-label={full} className={className} onClick={onClick}>
        {body}
      </button>
    );

  // Under the logo row: the rail's width with names shown, the logo's
  // column without them. Either way the tooltip says the whole sentence.
  return (
    <div className={labelled ? "shrink-0 px-3 pb-3" : "flex shrink-0 justify-center pb-3"}>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>{element}</TooltipTrigger>
          <TooltipContent side={labelled ? "bottom" : "right"} collisionPadding={8}>
            {full}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
