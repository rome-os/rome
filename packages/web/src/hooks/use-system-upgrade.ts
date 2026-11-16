import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/fetch-json";

/** Mirrors the Rome Cloud upgrade-check contract relayed by GET /api/system/upgrade/check. */
export interface UpgradeCheck {
  current: { version: string | null; sha: string | null };
  latest: { version: string };
  upgradeAvailable: boolean;
}

export const UPGRADE_CHECK_PATH = "/api/system/upgrade/check";

const RESTART_POLL_INTERVAL_MS = 3_000;
const RESTART_PROBE_TIMEOUT_MS = 5_000;
// Give up waiting for the new backend after this long and point the viewer
// at Rome Cloud instead — the upgrade may have failed server-side, and polling
// forever reads as "still working" when nobody is. Matches the iOS app and
// Rome Cloud: a cold image pull plus a slow migration can take this long.
export const RESTART_TIMEOUT_MS = 40 * 60_000;
// Above the server's 15 s Rome Cloud relay budget, so an honest answer still
// lands; past it the request is treated as lost and they can retry
// (a duplicate is rejected as `upgrade_in_progress`).
const UPGRADE_REQUEST_TIMEOUT_MS = 20_000;

export interface SystemUpgrade {
  /** Starts the upgrade to `target`, the latest version the viewer confirmed. */
  upgrade: (target: string) => void;
  /** True while the upgrade request is in flight. */
  pending: boolean;
  /** Rome Cloud rejected the target as stale (409); the caller's re-check is running. */
  targetConflict: boolean;
  /** The failed upgrade request's message, or null. */
  error: string | null;
  /** Clears `targetConflict` and `error`. */
  reset: () => void;
  /** The version Rome is restarting into; non-null once the upgrade was accepted. */
  restartingTo: string | null;
  /** The restart did not come back on `restartingTo` within RESTART_TIMEOUT_MS. */
  restartTimedOut: boolean;
  /**
   * The version the backend came back on, when the hook was asked to report
   * the finish rather than reload. Null until then, and always null with
   * `finish: "reload"`.
   */
  upgradedTo: string | null;
  /**
   * After a timeout, asks again for `restartingTo`: the backend already on it
   * finishes, an upgrade still running resumes the wait, and anything else
   * sends the request again.
   */
  retry: () => void;
  /** True while a retry is checking or asking. */
  retrying: boolean;
}

export interface SystemUpgradeOptions {
  /**
   * What happens once the backend reports the target version. `reload`, the
   * default, loads the page again. `report` sets `upgradedTo` and leaves the
   * page as it is, so the viewer reloads when it suits them. `report` also
   * reads a 409 `upgrade_in_progress` as an upgrade already on its way.
   */
  finish?: "reload" | "report";
}

/**
 * The confirmed upgrade: POST /api/system/upgrade, then wait for the
 * restarted backend to report the target version, and reload the page or
 * report it (`finish`). Shared by the Settings section, which reloads, and
 * the sidebar's upgrade row, which reports.
 *
 * `recheck` re-runs the caller's upgrade check: a 409 `target_not_latest`
 * means a newer version was published between check and confirm, so the
 * caller shows the new latest and asks the viewer to confirm again.
 */
export function useSystemUpgrade(
  recheck: () => unknown,
  { finish = "reload" }: SystemUpgradeOptions = {},
): SystemUpgrade {
  const { t } = useTranslation("settings");
  const [targetConflict, setTargetConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A fresh object per accepted request, so a retry for the same target
  // starts a fresh wait.
  const [wait, setWait] = useState<{ target: string } | null>(null);
  const restartingTo = wait?.target ?? null;
  const [restartTimedOut, setRestartTimedOut] = useState(false);
  const [upgradedTo, setUpgradedTo] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const accept = (target: string) => setWait({ target });

  const mutation = useMutation({
    mutationFn: (target: string) => requestUpgrade(target, t("system.upgradeFailedFallback")),
    onSuccess: (data) => accept(data.target),
    onError: (err, target) => {
      if (finish === "report" && err.message === "upgrade_in_progress") {
        accept(target);
        return;
      }
      if (err.message === "target_not_latest") {
        setTargetConflict(true);
        void recheck();
        return;
      }
      setError(err.name === "TimeoutError" ? "request_timeout" : err.message);
    },
  });

  useEffect(() => {
    if (wait === null) return;
    const { target } = wait;
    setRestartTimedOut(false);
    let cancelled = false;
    let timer: number | undefined;
    // Wall-clock deadline: a slow probe (up to its own 5 s timeout) must not
    // stretch the wait past RESTART_TIMEOUT_MS.
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    const controller = new AbortController();
    // Reload only when the backend reports the version we're upgrading into.
    // Health reachability alone can't distinguish "upgrade finished" from the
    // old backend still serving (or a transient blip), but the old backend can
    // never report the target version, so this signal is race-free. The
    // self-rearming timeout keeps at most one probe in flight.
    const poll = async () => {
      const version = await probeVersion(
        AbortSignal.any([controller.signal, AbortSignal.timeout(RESTART_PROBE_TIMEOUT_MS)]),
      );
      const upgraded = version === target;
      if (cancelled) return;
      if (upgraded) {
        if (finish === "report") setUpgradedTo(target);
        else window.location.reload();
        return;
      }
      if (Date.now() >= deadline) {
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
  }, [wait, finish]);

  const retry = async () => {
    const target = restartingTo;
    if (target === null || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      // The upgrade may have landed after the wait gave up; asking again
      // would then start a second one to the version already running.
      if ((await probeVersion(AbortSignal.timeout(RESTART_PROBE_TIMEOUT_MS))) === target) {
        setRestartTimedOut(false);
        if (finish === "report") setUpgradedTo(target);
        else window.location.reload();
        return;
      }
      await requestUpgrade(target, t("system.upgradeFailedFallback"));
      accept(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "upgrade_in_progress") accept(target);
      else if (message === "target_not_latest") {
        // A newer release came out meanwhile: drop this one, and the
        // caller's re-check offers the new one to confirm.
        setWait(null);
        setRestartTimedOut(false);
        void recheck();
      } else
        setError(err instanceof Error && err.name === "TimeoutError" ? "request_timeout" : message);
    } finally {
      setRetrying(false);
    }
  };

  return {
    upgrade: (target) => {
      setError(null);
      setTargetConflict(false);
      mutation.mutate(target);
    },
    pending: mutation.isPending,
    targetConflict,
    error,
    reset: () => {
      setError(null);
      setTargetConflict(false);
    },
    restartingTo,
    restartTimedOut,
    upgradedTo,
    retry: () => void retry(),
    retrying,
  };
}

function requestUpgrade(target: string, fallback: string) {
  return fetchJson<{ status: string; target: string }>("/api/system/upgrade", {
    method: "POST",
    json: { target },
    signal: AbortSignal.timeout(UPGRADE_REQUEST_TIMEOUT_MS),
    fallback,
  });
}

/** The version the backend reports, or null when it does not answer. */
async function probeVersion(signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/api/build-info", {
      cache: "no-store",
      credentials: "include",
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string | null };
    return body.version ?? null;
  } catch {
    // Backend unreachable mid-restart.
    return null;
  }
}
