import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { RomeLogo } from "@/components/logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { UpgradeWhatsNew } from "@/components/upgrade-whats-new";
import type { SystemUpgrade } from "@/hooks/use-system-upgrade";

interface UpgradeDialogProps {
  open: boolean;
  /** The agent's name, which the copy speaks of as what upgrades and restarts. */
  name: string;
  /** The newer release on offer. */
  latest: string | null;
  /** The running release, where "What's new" counts from. */
  current: string | null;
  /** The upgrade check is re-running (after a 409, `latest` is still the rejected target). */
  rechecking: boolean;
  upgrade: SystemUpgrade;
  onClose: () => void;
}

/**
 * The confirmation for an upgrade, and the request it sends. The caller closes
 * it once the request is accepted; the upgrade then runs in the background.
 */
export function UpgradeDialog({
  open,
  name,
  latest,
  current,
  rechecking,
  upgrade,
  onClose,
}: UpgradeDialogProps) {
  const { t } = useTranslation("settings");
  const { t: tFiles } = useTranslation("files");
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // Once the request is out there is nothing to cancel.
  const locked = upgrade.pending;
  const title = t("system.confirmTitle", { name, version: latest });

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!locked) onClose();
      }}
      modal={locked}
      size="md"
      ariaLabel={title}
      initialFocusRef={confirmRef}
      // The notes scroll between the fixed top and the buttons, so a long
      // list never pushes Cancel or Upgrade off the screen.
      className="flex max-h-[calc(100dvh-2rem)] max-w-[min(32rem,calc(100vw-2rem))] flex-col py-6"
    >
      <div className="shrink-0 px-6">
        <RomeLogo className="mb-2 block h-8 w-8 text-foreground" aria-hidden />
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-2">
          {t("system.confirmDescription", { name })}
        </DialogDescription>
      </div>
      {latest ? (
        <UpgradeWhatsNew
          key={latest}
          from={current}
          to={latest}
          className="mt-4 min-h-0 flex-1 overflow-y-auto px-6"
        />
      ) : null}
      <div className="shrink-0 px-6">
        {upgrade.targetConflict && !rechecking && latest ? (
          <Alert variant="warning" className="mt-4">
            <AlertDescription>{t("system.targetChanged", { version: latest })}</AlertDescription>
          </Alert>
        ) : null}
        {upgrade.error ? (
          <p className="mt-4 text-ui text-destructive-fg">
            {t("system.upgradeFailed", { message: upgrade.error })}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={upgrade.pending} onClick={onClose}>
            {tFiles("dialog.cancel")}
          </Button>
          <Button
            ref={confirmRef}
            // Disabled while the POST is in flight (a second activation would
            // resubmit) and during the 409 re-check, when `latest` is still
            // the stale target Rome Cloud just rejected.
            disabled={upgrade.pending || rechecking || !latest}
            onClick={() => {
              if (latest) upgrade.upgrade(latest);
            }}
          >
            {upgrade.pending ? t("system.upgrading") : t("system.confirmButton")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
