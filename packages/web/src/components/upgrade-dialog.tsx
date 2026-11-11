import { Loader2 } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { RomeLogo } from "@/components/logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RESTART_TIMEOUT_MS, type SystemUpgrade } from "@/hooks/use-system-upgrade";

interface UpgradeDialogProps {
  open: boolean;
  /** The agent's name, which the copy speaks of as what upgrades and restarts. */
  name: string;
  /** The newer release on offer; null only once the restart has begun. */
  latest: string | null;
  /** The upgrade check is re-running (after a 409, `latest` is still the rejected target). */
  rechecking: boolean;
  upgrade: SystemUpgrade;
  onClose: () => void;
}

/**
 * Confirm, then run, an upgrade in place: the confirmation, the request in
 * flight, the restart (until the page reloads on the new version), and the
 * restart timeout with its way out to Rome Cloud.
 */
export function UpgradeDialog({
  open,
  name,
  latest,
  rechecking,
  upgrade,
  onClose,
}: UpgradeDialogProps) {
  const { t } = useTranslation("settings");
  const { t: tFiles } = useTranslation("files");
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const { restartingTo, restartTimedOut } = upgrade;
  const restarting = restartingTo !== null && !restartTimedOut;
  // Once the request is out there is nothing to cancel, and closing would hide
  // the only thing telling the viewer the page is about to reload.
  const locked = upgrade.pending || restarting;

  const title =
    restartingTo === null
      ? t("system.confirmTitle", { name, version: latest })
      : restartTimedOut
        ? t("system.restartTimeoutTitle")
        : t("system.restartingTitle", { name });

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!locked) onClose();
      }}
      modal={locked}
      size="sm"
      ariaLabel={title}
      initialFocusRef={confirmRef}
      className="p-6"
    >
      <RomeLogo className="mb-2 block h-8 w-8 text-foreground" aria-hidden />
      <div className="flex items-center gap-2">
        {restarting ? <Loader2 aria-hidden className="size-5 shrink-0 animate-spin" /> : null}
        <DialogTitle>{title}</DialogTitle>
      </div>

      {restartingTo === null ? (
        <>
          <DialogDescription className="mt-2">
            {t("system.confirmDescription", { name })}
          </DialogDescription>
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
        </>
      ) : restartTimedOut ? (
        <>
          <DialogDescription className="mt-2">
            {t("system.restartTimeoutBody", {
              name,
              version: restartingTo,
              minutes: RESTART_TIMEOUT_MS / 60_000,
            })}{" "}
            <a
              href={import.meta.env.ROME_CLOUD_ORIGIN}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {t("system.restartTimeoutAction")}
            </a>
          </DialogDescription>
          <div className="mt-6 flex justify-end">
            <Button ref={confirmRef} variant="outline" onClick={onClose}>
              {t("system.close")}
            </Button>
          </div>
        </>
      ) : (
        <DialogDescription className="mt-2">
          {t("system.restartingBody", { version: restartingTo })}
        </DialogDescription>
      )}
    </Dialog>
  );
}
