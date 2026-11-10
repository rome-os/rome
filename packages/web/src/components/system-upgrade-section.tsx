import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import {
  RESTART_TIMEOUT_MS,
  UPGRADE_CHECK_PATH,
  type UpgradeCheck,
  useSystemUpgrade,
} from "@/hooks/use-system-upgrade";
import { offeredVersion } from "@/hooks/use-upgrade-available";
import { fetchJson } from "@/lib/fetch-json";

/** Mirrors GET /api/build-info from @rome/core (build identity + boot version report). */
interface BuildInfoResponse {
  version: string | null;
  sha: string | null;
  builtAt: string | null;
  upgradedSinceLastBoot: boolean;
  previousVersion: string | null;
}

export function SystemUpgradeSection() {
  const { t } = useTranslation("settings");
  // The shared upgrade copy names what restarts; this page speaks of the product.
  const name = t("appName", { ns: "common" });
  const [checkRequested, setCheckRequested] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const buildQuery = useQuery({
    queryKey: ["build-info"] as const,
    queryFn: ({ signal }) =>
      fetchJson<BuildInfoResponse>("/api/build-info", {
        signal,
        fallback: t("system.buildInfoFailed"),
      }),
  });

  const checkQuery = useQuery({
    queryKey: ["system-upgrade-check"] as const,
    enabled: checkRequested,
    retry: false,
    queryFn: ({ signal }) =>
      fetchJson<UpgradeCheck>(UPGRADE_CHECK_PATH, {
        signal,
        fallback: t("system.checkFailedFallback"),
      }),
  });

  const upgrade = useSystemUpgrade(() => checkQuery.refetch());
  const { restartingTo, restartTimedOut, targetConflict } = upgrade;

  const build = buildQuery.data ?? null;
  // A failed re-check must not leave the previous result on screen: React
  // Query keeps the last successful data on refetch failure, so gate on the
  // absence of an error rather than on data alone.
  const check = checkQuery.error ? null : (checkQuery.data ?? null);
  const latest = check?.latest.version ?? null;
  // Same rule as the sidebar arrow, so the two never disagree on one screen.
  const offered = check ? offeredVersion(check) : null;

  if (restartingTo !== null) {
    return (
      <div className="flex flex-col gap-3">
        {restartTimedOut ? (
          <Alert variant="warning">
            <AlertTitle>{t("system.restartTimeoutTitle")}</AlertTitle>
            <AlertDescription>
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
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="info">
            <AlertTitle>{t("system.restartingTitle", { name })}</AlertTitle>
            <AlertDescription>
              {t("system.restartingBody", { name, version: restartingTo })}
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  function startCheck() {
    upgrade.reset();
    setConfirmOpen(false);
    if (checkRequested) void checkQuery.refetch();
    else setCheckRequested(true);
  }

  return (
    <div className="flex flex-col gap-3">
      {build?.upgradedSinceLastBoot && build.version && (
        <Alert variant="success">
          <AlertDescription>
            {t("system.upgradedNotice", { from: build.previousVersion, to: build.version })}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-ui text-muted-foreground">{t("system.currentVersion")}</p>
            {!build && buildQuery.error ? (
              <div className="mt-1 flex items-center gap-2">
                <p className="text-ui text-destructive-fg">{t("system.buildInfoFailed")}</p>
                <Button variant="outline" size="xs" onClick={() => void buildQuery.refetch()}>
                  {t("system.retry")}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-ui text-foreground">
                  {build ? (build.version ?? t("system.versionUnknown")) : "…"}
                </p>
                {build?.builtAt && (
                  <p className="mt-1 text-aux text-muted-foreground">
                    {t("system.builtAt", { builtAt: formatBuildDate(build.builtAt) })}
                  </p>
                )}
              </>
            )}
          </div>
          {build && build.version === null ? (
            // An unversioned build (source run, test image) has no identity to
            // compare against a release, so core rejects both upgrade verbs —
            // don't offer the check at all.
            <p className="max-w-xs text-ui text-muted-foreground">
              {t("system.upgradeUnsupported")}
            </p>
          ) : (
            // Disabled until build-info resolves: whether this build supports
            // upgrades at all is unknown until then, and on an unversioned build
            // a fast click would reach the check the UI is meant to suppress.
            <Button
              variant="outline"
              onClick={startCheck}
              disabled={!build || checkQuery.isFetching}
            >
              {checkQuery.isFetching ? t("system.checking") : t("system.checkButton")}
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3 empty:hidden">
        {checkQuery.error && <CheckErrorNotice message={checkQuery.error.message} />}

        {check && offered === null && (
          <p className="text-ui text-muted-foreground">
            {t("system.upToDate", { version: check.latest.version })}
          </p>
        )}

        {offered && (
          <Alert variant="info" className="flex flex-wrap items-center justify-between gap-3 p-4">
            <AlertDescription className="flex-1">
              {t("system.upgradeAvailable", { version: offered })}
            </AlertDescription>
            <Button
              onClick={() => {
                upgrade.reset();
                setConfirmOpen(true);
              }}
            >
              {t("system.upgradeButton", { version: offered })}
            </Button>
          </Alert>
        )}

        {targetConflict && latest && (
          <Alert variant="warning">
            <AlertDescription>{t("system.targetChanged", { version: latest })}</AlertDescription>
          </Alert>
        )}

        {upgrade.error && (
          <p className="text-ui text-destructive-fg">
            {t("system.upgradeFailed", { message: upgrade.error })}
          </p>
        )}
      </div>

      {latest && (
        <RomeConfirmDialog
          // A failed request closes the confirmation and reports inline below.
          open={confirmOpen && upgrade.error === null}
          title={t("system.confirmTitle", { name, version: latest })}
          description={t("system.confirmDescription", { name })}
          confirmLabel={t("system.confirmButton")}
          // Disabled while the POST is in flight (a second activation would
          // resubmit) and during the 409 recovery re-check, when `latest` is
          // still the stale target Rome Cloud just rejected.
          confirmDisabled={upgrade.pending || checkQuery.isFetching}
          onCancel={() => {
            setConfirmOpen(false);
            upgrade.reset();
          }}
          onConfirm={() => upgrade.upgrade(latest)}
        />
      )}
    </div>
  );
}

function CheckErrorNotice({ message }: { message: string }) {
  const { t } = useTranslation("settings");
  // The core relay encodes legible non-error states as error codes; render the
  // ones a guardian can act on as inline copy rather than a raw failure.
  if (message === "pantheon_unconfigured") {
    return <p className="text-ui text-muted-foreground">{t("system.notManaged")}</p>;
  }
  if (message === "unversioned_build") {
    return <p className="text-ui text-muted-foreground">{t("system.upgradeUnsupported")}</p>;
  }
  if (message === "latest_unresolvable") {
    return <p className="text-ui text-warning-fg">{t("system.unresolvable")}</p>;
  }
  return <p className="text-ui text-destructive-fg">{t("system.checkFailed", { message })}</p>;
}

function formatBuildDate(builtAt: string): string {
  const date = new Date(builtAt);
  if (Number.isNaN(date.getTime())) return builtAt;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
