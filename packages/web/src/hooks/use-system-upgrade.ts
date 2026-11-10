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
// Give up waiting for the new backend after this long and point the guardian
// at Rome Cloud instead — the upgrade may have failed server-side, and polling
// forever reads as "still working" when nobody is. Matches the iOS app and
// Rome Cloud: a cold image pull plus a slow migration can take this long.
export const RESTART_TIMEOUT_MS = 40 * 60_000;
const MAX_RESTART_POLLS = RESTART_TIMEOUT_MS / RESTART_POLL_INTERVAL_MS;
// Above the server's 15 s Rome Cloud relay budget, so an honest answer still
// lands; past it the request is treated as lost and the guardian can retry
// (a duplicate is rejected as `upgrade_in_progress`).
const UPGRADE_REQUEST_TIMEOUT_MS = 20_000;

export interface SystemUpgrade {
  /** Starts the upgrade to `target`, the latest version the guardian confirmed. */
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
}

/**
 * The guardian-confirmed upgrade: POST /api/system/upgrade, then wait for the
 * restarted backend to report the target version and reload the page. Shared
 * by the Settings section and the sidebar's upgrade dialog.
 *
 * `recheck` re-runs the caller's upgrade check: a 409 `target_not_latest`
 * means a newer version was published between check and confirm, so the
 * caller shows the new latest and asks the guardian to confirm again.
 */
export function useSystemUpgrade(recheck: () => unknown): SystemUpgrade {
  const { t } = useTranslation("settings");
  const [targetConflict, setTargetConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restartingTo, setRestartingTo] = useState<string | null>(null);
  const [restartTimedOut, setRestartTimedOut] = useState(false);

  const mutation = useMutation({
    mutationFn: (target: string) =>
      fetchJson<{ status: string; target: string }>("/api/system/upgrade", {
        method: "POST",
        json: { target },
        signal: AbortSignal.timeout(UPGRADE_REQUEST_TIMEOUT_MS),
        fallback: t("system.upgradeFailedFallback"),
      }),
    onSuccess: (data) => setRestartingTo(data.target),
    onError: (err) => {
      if (err.message === "target_not_latest") {
        setTargetConflict(true);
        void recheck();
        return;
      }
      setError(err.name === "TimeoutError" ? "request_timeout" : err.message);
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
  };
}
