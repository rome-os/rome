import { ArrowUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useConciergeName } from "@/hooks/use-concierge";
import { useDashboardIdentity } from "@/hooks/use-dashboard-identity";
import { useSystemUpgrade } from "@/hooks/use-system-upgrade";
import { useUpgradeAvailable } from "@/hooks/use-upgrade-available";

/**
 * The sidebar's "upgrade available" arrow, beside the Rome logo. Shown to the
 * guardian whenever Rome Cloud offers a newer release; a click confirms and
 * runs the upgrade in a dialog.
 *
 * `suppressed` hides the arrow while the nightly upgrade banner is up, so
 * there is one way in at a time. The dialog stays mounted through it: an
 * upgrade already running here keeps its progress on screen.
 */
export function UpgradeIndicator({
  suppressed,
  tooltipSide,
}: {
  suppressed: boolean;
  tooltipSide: "bottom" | "right";
}) {
  const { t } = useTranslation("common");
  const identity = useDashboardIdentity();
  const { latest, recheck, rechecking } = useUpgradeAvailable(identity.data?.kind === "guardian");
  const upgrade = useSystemUpgrade(recheck);
  const [open, setOpen] = useState(false);
  const name = useConciergeName();
  const label = t("upgradeIndicator.tooltip", { name });

  return (
    <>
      {latest !== null && !suppressed ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                size="sm"
                label={label}
                title={undefined}
                icon={
                  // A filled disc in the sidebar checkmark's green, so the
                  // offer reads at a glance. Status families have no
                  // `-foreground`; `surface` is the token that clears the
                  // glyph bar on `success` in every theme (themes-contrast).
                  <span
                    aria-hidden
                    className="flex size-4 items-center justify-center rounded-full bg-success text-surface"
                  >
                    <ArrowUp className="size-3" strokeWidth={3} />
                  </span>
                }
                onClick={() => {
                  upgrade.reset();
                  setOpen(true);
                }}
              />
            </TooltipTrigger>
            <TooltipContent side={tooltipSide} collisionPadding={8}>
              {label}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      <UpgradeDialog
        open={open && (latest !== null || upgrade.restartingTo !== null)}
        name={name}
        latest={latest}
        rechecking={rechecking}
        upgrade={upgrade}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
