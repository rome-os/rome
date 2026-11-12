import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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

/** The build identity, update check, and upgrade behind `SystemVersionRow`. */
function useVersionCheck() {
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

  const build = buildQuery.data ?? null;
  // A failed re-check must not leave the previous result on screen: React
  // Query keeps the last successful data on refetch failure, so gate on the
  // absence of an error rather than on data alone.
  const check = checkQuery.error ? null : (checkQuery.data ?? null);
  const latest = check?.latest.version ?? null;
  // Same rule as the sidebar arrow, so the two never disagree on one screen.
  const offered = check ? offeredVersion(check) : null;

  function startCheck() {
    upgrade.reset();
    setConfirmOpen(false);
    if (checkRequested) void checkQuery.refetch();
    else setCheckRequested(true);
  }

  return {
    t,
    name,
    buildQuery,
    checkQuery,
    upgrade,
    build,
    check,
    latest,
    offered,
    confirmOpen,
    setConfirmOpen,
    startCheck,
  };
}

type VersionCheck = ReturnType<typeof useVersionCheck>;

function UpgradeConfirmDialog({ versionCheck }: { versionCheck: VersionCheck }) {
  const { t, name, latest, confirmOpen, setConfirmOpen, upgrade, checkQuery } = versionCheck;
  if (!latest) return null;
  return (
    <RomeConfirmDialog
      // A failed request closes the confirmation and reports inline. An
      // accepted one closes it too, so Confirm cannot send a second request.
      open={confirmOpen && upgrade.error === null && upgrade.restartingTo === null}
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
  );
}

/** The version, update check, and upgrade as one settings row, for pages that
 * group it with other rows. */
export function SystemVersionRow() {
  const versionCheck = useVersionCheck();
  const {
    t,
    name,
    buildQuery,
    checkQuery,
    upgrade,
    build,
    check,
    latest,
    offered,
    setConfirmOpen,
    startCheck,
  } = versionCheck;
  const { restartingTo, restartTimedOut, targetConflict } = upgrade;
  const unversioned = build !== null && build.version === null;

  let status: ReactNode = null;
  if (restartingTo !== null) {
    status = restartTimedOut ? (
      <span role="alert" className="text-warning-fg">
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
      </span>
    ) : (
      <span role="status">{t("system.restartingBody", { version: restartingTo })}</span>
    );
  } else if (upgrade.error) {
    status = (
      <span className="text-destructive-fg">
        {t("system.upgradeFailed", { message: upgrade.error })}
      </span>
    );
  } else if (targetConflict && latest) {
    status = (
      <span className="text-warning-fg">{t("system.targetChanged", { version: latest })}</span>
    );
  } else if (checkQuery.error) {
    status = <CheckErrorNotice message={checkQuery.error.message} />;
  } else if (offered) {
    status = t("system.upgradeAvailable", { version: offered });
  } else if (check) {
    status = t("system.upToDate", { version: check.latest.version });
  } else if (unversioned) {
    status = t("system.upgradeUnsupported");
  } else if (build?.upgradedSinceLastBoot && build.version) {
    status = (
      <span className="text-success-fg">
        {t("system.upgradedNotice", { from: build.previousVersion, to: build.version })}
      </span>
    );
  }

  return (
    <FormRow>
      <FormRowHeading>
        <FormRowLabel>{t("system.currentVersion")}</FormRowLabel>
        {!build && buildQuery.error ? (
          <FormRowDescription className="text-destructive-fg">
            {t("system.buildInfoFailed")}
          </FormRowDescription>
        ) : (
          <FormRowDescription>
            {build ? (build.version ?? t("system.versionUnknown")) : "…"}
            {build?.builtAt &&
              ` · ${t("system.builtAt", { builtAt: formatBuildDate(build.builtAt) })}`}
          </FormRowDescription>
        )}
        {status && <FormRowDescription>{status}</FormRowDescription>}
      </FormRowHeading>
      <FormRowControl>
        {restartingTo !== null ? null : !build && buildQuery.error ? (
          <Button variant="outline" size="sm" onClick={() => void buildQuery.refetch()}>
            {t("system.retry")}
          </Button>
        ) : offered && !checkQuery.isFetching ? (
          <Button
            size="sm"
            onClick={() => {
              upgrade.reset();
              setConfirmOpen(true);
            }}
          >
            {t("system.upgradeButton", { version: offered })}
          </Button>
        ) : unversioned ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={startCheck}
            disabled={!build || checkQuery.isFetching}
          >
            {checkQuery.isFetching ? t("system.checking") : t("system.checkButton")}
          </Button>
        )}
      </FormRowControl>
      <UpgradeConfirmDialog versionCheck={versionCheck} />
    </FormRow>
  );
}

function CheckErrorNotice({ message }: { message: string }) {
  const { t } = useTranslation("settings");
  // The core relay encodes legible non-error states as error codes; render the
  // ones the viewer can act on as inline copy rather than a raw failure.
  if (message === "pantheon_unconfigured") {
    return <span className="text-muted-foreground">{t("system.notManaged")}</span>;
  }
  if (message === "unversioned_build") {
    return <span className="text-muted-foreground">{t("system.upgradeUnsupported")}</span>;
  }
  if (message === "latest_unresolvable") {
    return <span className="text-warning-fg">{t("system.unresolvable")}</span>;
  }
  return <span className="text-destructive-fg">{t("system.checkFailed", { message })}</span>;
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
