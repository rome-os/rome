import { Section, SectionHeader, SectionTitle } from "@rome-os/ui/page";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { fetchJson } from "@/lib/fetch-json";

/** Mirrors GET /api/build-info from @rome/core (build identity + boot version report). */
interface BuildInfoResponse {
  version: string | null;
  sha: string | null;
  builtAt: string | null;
  upgradedSinceLastBoot: boolean;
  previousVersion: string | null;
}

/** Mirrors the Rome Cloud upgrade-check contract relayed by GET /api/system/upgrade/check. */
interface UpgradeCheck {
  current: { version: string | null; sha: string | null };
  latest: { version: string };
  upgradeAvailable: boolean;
}

const RESTART_POLL_INTERVAL_MS = 3_000;
const RESTART_PROBE_TIMEOUT_MS = 5_000;
// Give up waiting for the new backend after this long and point the guardian
// at Rome Cloud instead — the upgrade may have failed server-side, and polling
// forever reads as "still working" when nobody is.
const RESTART_TIMEOUT_MS = 10 * 60_000;
const MAX_RESTART_POLLS = RESTART_TIMEOUT_MS / RESTART_POLL_INTERVAL_MS;

export function SystemUpgradeSection() {
  const { t } = useTranslation("settings");
  const [checkRequested, setCheckRequested] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [targetConflict, setTargetConflict] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  // The version we're restarting into; non-null switches the section into the
  // "Rome is restarting" state and starts polling for the new backend.
  const [restartingTo, setRestartingTo] = useState<string | null>(null);
  const [restartTimedOut, setRestartTimedOut] = useState(false);

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
      fetchJson<UpgradeCheck>("/api/system/upgrade/check", {
        signal,
        fallback: t("system.checkFailedFallback"),
      }),
  });

  const upgradeMutation = useMutation({
    mutationFn: (target: string) =>
      fetchJson<{ status: string; target: string }>("/api/system/upgrade", {
        method: "POST",
        json: { target },
        fallback: t("system.upgradeFailedFallback"),
      }),
    onSuccess: (data) => {
      setConfirmOpen(false);
      setRestartingTo(data.target);
    },
    onError: (err) => {
      if (err.message === "target_not_latest") {
        // A newer version was published between check and confirm. Re-fetch so
        // the dialog shows the new latest, and ask the guardian to re-confirm.
        setTargetConflict(true);
        void checkQuery.refetch();
        return;
      }
      setConfirmOpen(false);
      setUpgradeError(err.message);
    },
  });

  useEffect(() => {
    if (restartingTo === null) return;
    setRestartTimedOut(false);
    let cancelled = false;
    let timer: number | undefined;
    let polls = 0;
    const controller = new AbortController();
    // Reload only when the backend reports the version we're upgrading into.
    // Health reachability alone can't distinguish "upgrade finished" from the
    // old backend still serving (or a transient blip), but the old backend can
    // never report the target version, so this signal is race-free. The
    // self-rearming timeout keeps at most one probe in flight.
    const poll = async () => {
      let upgraded = false;
      try {
        const res = await fetch("/api/build-info", {
          cache: "no-store",
          credentials: "include",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(RESTART_PROBE_TIMEOUT_MS),
          ]),
        });
        if (res.ok) {
          const body = (await res.json()) as { version?: string | null };
          upgraded = body.version === restartingTo;
        }
      } catch {
        // Backend unreachable mid-restart; keep polling.
      }
      if (cancelled) return;
      if (upgraded) {
        window.location.reload();
        return;
      }
      polls += 1;
      if (polls >= MAX_RESTART_POLLS) {
        setRestartTimedOut(true);
        return;
      }
      timer = window.setTimeout(poll, RESTART_POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(poll, RESTART_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [restartingTo]);

  const build = buildQuery.data ?? null;
  // A failed re-check must not leave the previous result on screen: React
  // Query keeps the last successful data on refetch failure, so gate on the
  // absence of an error rather than on data alone.
  const check = checkQuery.error ? null : (checkQuery.data ?? null);
  const latest = check?.latest.version ?? null;

  if (restartingTo !== null) {
    return (
      <Section>
        <SectionHeader>
          <SectionTitle>{t("system.title")}</SectionTitle>
        </SectionHeader>
        {restartTimedOut ? (
          <Alert variant="warning">
            <AlertTitle>{t("system.restartTimeoutTitle")}</AlertTitle>
            <AlertDescription>
              {t("system.restartTimeoutBody", {
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
            <AlertTitle>{t("system.restartingTitle")}</AlertTitle>
            <AlertDescription>
              {t("system.restartingBody", { version: restartingTo })}
            </AlertDescription>
          </Alert>
        )}
      </Section>
    );
  }

  function startCheck() {
    setUpgradeError(null);
    setTargetConflict(false);
    setConfirmOpen(false);
    if (checkRequested) void checkQuery.refetch();
    else setCheckRequested(true);
  }

  return (
    <Section>
      <SectionHeader>
        <SectionTitle>{t("system.title")}</SectionTitle>
      </SectionHeader>

      {build?.upgradedSinceLastBoot && build.version && (
        <Alert variant="success" className="mb-4">
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

      <div className="mt-3 space-y-3">
        {checkQuery.error && <CheckErrorNotice message={checkQuery.error.message} />}

        {check && !check.upgradeAvailable && (
          <p className="text-ui text-muted-foreground">
            {t("system.upToDate", { version: check.latest.version })}
          </p>
        )}

        {check && check.upgradeAvailable && latest && (
          <Alert variant="info" className="flex flex-wrap items-center justify-between gap-3 p-4">
            <AlertDescription className="flex-1">
              {t("system.upgradeAvailable", { version: latest })}
            </AlertDescription>
            <Button onClick={() => setConfirmOpen(true)}>
              {t("system.upgradeButton", { version: latest })}
            </Button>
          </Alert>
        )}

        {targetConflict && latest && (
          <Alert variant="warning">
            <AlertDescription>{t("system.targetChanged", { version: latest })}</AlertDescription>
          </Alert>
        )}

        {upgradeError && (
          <p className="text-ui text-destructive-fg">
            {t("system.upgradeFailed", { message: upgradeError })}
          </p>
        )}
      </div>

      {latest && (
        <RomeConfirmDialog
          open={confirmOpen}
          title={t("system.confirmTitle", { version: latest })}
          description={t("system.confirmDescription")}
          confirmLabel={t("system.confirmButton")}
          // Disabled while the POST is in flight (a second activation would
          // resubmit) and during the 409 recovery re-check, when `latest` is
          // still the stale target Rome Cloud just rejected.
          confirmDisabled={upgradeMutation.isPending || checkQuery.isFetching}
          onCancel={() => {
            setConfirmOpen(false);
            setTargetConflict(false);
          }}
          onConfirm={() => {
            setUpgradeError(null);
            setTargetConflict(false);
            upgradeMutation.mutate(latest);
          }}
        />
      )}
    </Section>
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
