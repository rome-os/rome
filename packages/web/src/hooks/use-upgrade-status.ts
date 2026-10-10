import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

export const UPGRADE_STATUS_IDLE_POLL_MS = 15_000;
export const UPGRADE_STATUS_ACTIVE_POLL_MS = 3_000;
/** Per-request deadline on each status/completion probe. A restart can leave a
 * request half-open indefinitely, and the next poll is only scheduled once the
 * current one settles — without this bound a single hung request would end the
 * loop. */
export const UPGRADE_STATUS_POLL_TIMEOUT_MS = 10_000;
/** Deadline on the consent verbs. Sits above the server's 15s Rome Cloud relay
 * budget, so a slow-but-honest ack still lands; past it the request is treated
 * as severed (the restart `/now` initiates can kill the very connection that
 * would carry its ack). */
export const UPGRADE_VERB_TIMEOUT_MS = 20_000;
/** How long the client waits for the restarted server before the banner turns
 * into the dismissable "taking longer than expected" state. Polling continues
 * past this — the timeout changes the message, never the recovery loop. */
export const UPGRADE_RESTART_TIMEOUT_MS = 5 * 60_000;

export type UpgradePhase = "idle" | "countdown" | "updating";

/** Mirrors the server's UpgradeStatusSnapshot, plus the local receive time. */
export interface UpgradeStatus {
  phase: UpgradePhase;
  targetVersion: string | null;
  /** Epoch ms when the countdown auto-proceeds; null outside `countdown`. */
  deadline: number | null;
  /** Server clock when the snapshot was emitted. */
  serverNow: number;
  /** Local Date.now() when this snapshot arrived — lets the banner render the
   * timer off server time, correcting for browser clock skew. */
  receivedAt: number;
}

/** What the banner renders. `countdown` mirrors the server; `updating` and
 * `stalled` are client-local — they must survive the server restarting, which
 * no server-held phase can. */
export interface UpgradeBannerState {
  phase: "countdown" | "updating" | "stalled";
  targetVersion: string | null;
  deadline: number | null;
  serverNow: number;
  receivedAt: number;
}

export interface UseUpgradeStatusResult {
  /** Null when the banner should be hidden. */
  state: UpgradeBannerState | null;
  /** Both verbs resolve `false` when the request failed (network error or a
   * non-2xx such as Rome Cloud rejecting the cutover) — the banner is left
   * standing, and the caller owes the guardian visible feedback. */
  updateNow: () => Promise<boolean>;
  defer: () => Promise<boolean>;
  /** Hide the stalled banner. Recovery polling continues; a later fresh offer
   * or completed restart resets the dismissal. */
  dismissStalled: () => void;
}

const upgradeStatusSchema = z.object({
  phase: z.enum(["idle", "countdown", "updating"]),
  targetVersion: z.string().nullable(),
  deadline: z.number().nullable(),
  serverNow: z.number(),
});

const buildInfoSchema = z.object({
  version: z.string().nullable(),
});

type ServerUpgradeStatus = z.infer<typeof upgradeStatusSchema>;

/** Estimated server clock "now", from the last snapshot's server/local pair —
 * the single skew-correction formula, shared with the banner's timer. */
export function estimatedServerNow(status: { serverNow: number; receivedAt: number }): number {
  return status.serverNow + (Date.now() - status.receivedAt);
}

function deadlineElapsed(status: UpgradeStatus): boolean {
  return status.deadline !== null && estimatedServerNow(status) >= status.deadline;
}

/**
 * Single polling loop against `/api/system/upgrade/status/snapshot` — slow
 * (15s) while idle, fast (3s) while a countdown or restart is in flight. The
 * same poll doubles as the post-cutover health probe. A replacement process
 * reports `idle`, which clears the banner. If a rolling replacement still
 * routes status to a draining process, `/api/build-info` confirming the target
 * version clears it instead.
 *
 * The restart is tracked as *client-local* state (`updatingSince`), entered on
 * any of: the `now` verb acking, a polled snapshot reporting `updating` (the
 * old process after a deadline-path cutover), or the rendered countdown
 * crossing its deadline (consent-by-silence with no ack to observe). It exits
 * when a poll reports a resolved phase or confirms that the target build is
 * already running.
 */
export function useUpgradeStatus(): UseUpgradeStatusResult {
  const [server, setServer] = useState<UpgradeStatus | null>(null);
  /** Local Date.now() when the client concluded a restart began; null when no
   * restart is believed to be in flight. */
  const [updatingSince, setUpdatingSince] = useState<number | null>(null);
  // A rolling replacement can leave the accepting process serving
  // `updating` after another process is already serving the target build.
  // Remember that target so a later response from the draining process cannot
  // put the completed update back on screen.
  const [completedTarget, setCompletedTarget] = useState<string | null>(null);
  const [stalledDismissed, setStalledDismissed] = useState(false);
  // A 1s tick drives the countdown re-render, the deadline-crossing check, and
  // the stall-boundary re-render; the value is unused.
  const [, setTick] = useState(0);

  const serverRef = useRef(server);
  serverRef.current = server;
  const updatingSinceRef = useRef(updatingSince);
  updatingSinceRef.current = updatingSince;
  const completedTargetRef = useRef(completedTarget);
  completedTargetRef.current = completedTarget;
  // Bumped on every verb acknowledgement. A poll that started before the bump
  // carries pre-verb state — applying it would let a stale countdown overwrite
  // the `updating` ack (and the banner would then sit on a dead countdown
  // through the whole restart), so such responses are discarded.
  const pollGenerationRef = useRef(0);
  /** Non-null while a transport-failed `/now` is ambiguous: the server-side
   * relay may still be pending *behind a live countdown* (the hub only leaves
   * `countdown` once Rome Cloud answers), so until this local deadline passes a
   * polled live countdown is not proof the cutover failed and must not clear
   * the optimistic updating state. */
  const ambiguousNowUntilRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applySnapshot = useCallback((value: ServerUpgradeStatus) => {
    const status: UpgradeStatus = { ...value, receivedAt: Date.now() };
    setServer(status);
    if (
      value.phase === "updating" &&
      value.targetVersion !== null &&
      value.targetVersion === completedTargetRef.current
    ) {
      setUpdatingSince(null);
      setStalledDismissed(false);
      return;
    }
    // Keep the completion marker through idle snapshots. A rolling deployment
    // may still route a later request back to the draining process. A new
    // active phase for any target is the point where the marker is obsolete.
    if (value.phase !== "idle") {
      completedTargetRef.current = null;
      setCompletedTarget(null);
    }
    if (value.phase === "updating") {
      ambiguousNowUntilRef.current = null;
      setUpdatingSince((current) => current ?? Date.now());
      return;
    }
    if (value.phase === "countdown") {
      // A countdown whose deadline already passed is not resolved: the
      // deadline-path cutover is still relaying to Rome Cloud, so a local
      // updating state must not flap back.
      if (deadlineElapsed(status)) return;
      // A *live* countdown normally resolves the phase (fresh offer, or a
      // cross-tab defer) — except inside the ambiguous-`/now` grace window,
      // where the server may still be mid-relay behind this very countdown
      // and about to die; clearing here could strand the restart unseen.
      const grace = ambiguousNowUntilRef.current;
      if (grace !== null && Date.now() < grace) return;
    }
    // `idle`, or a live countdown with no ambiguity left: fully resolved.
    ambiguousNowUntilRef.current = null;
    setUpdatingSince(null);
    setStalledDismissed(false);
  }, []);

  const inUpdating = updatingSince !== null;
  const serverActive =
    server !== null &&
    server.phase !== "idle" &&
    (server.targetVersion === null || server.targetVersion !== completedTarget);
  const stalled =
    updatingSince !== null && Date.now() - updatingSince >= UPGRADE_RESTART_TIMEOUT_MS;
  // Past the stall boundary the restart is overdue and the fast cadence has
  // nothing left to be responsive *for* — relax to the idle rate so a
  // permanently-dead server isn't hammered every 3s by every open tab.
  // Recovery still works; it's just no longer urgent.
  const pollMs =
    !stalled && (inUpdating || serverActive)
      ? UPGRADE_STATUS_ACTIVE_POLL_MS
      : UPGRADE_STATUS_IDLE_POLL_MS;

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let pollTimer: number | null = null;

    const schedulePoll = () => {
      if (disposed) return;
      pollTimer = window.setTimeout(() => void poll(), pollMs);
    };
    const poll = async () => {
      const generation = pollGenerationRef.current;
      // Per-request abort: fires on unmount/cadence change (the outer
      // controller) or on the request deadline, whichever comes first.
      const request = new AbortController();
      const abortRequest = () => request.abort();
      controller.signal.addEventListener("abort", abortRequest);
      const deadline = window.setTimeout(abortRequest, UPGRADE_STATUS_POLL_TIMEOUT_MS);
      try {
        const response = await fetch("/api/system/upgrade/status/snapshot", {
          credentials: "include",
          cache: "no-store",
          signal: request.signal,
        });
        if (!response.ok) throw new Error(`upgrade status request failed: ${response.status}`);
        const parsed = upgradeStatusSchema.parse(await response.json());
        if (disposed || generation !== pollGenerationRef.current) return;
        applySnapshot(parsed);
        if (parsed.phase === "updating" && parsed.targetVersion !== null) {
          // The version is a stronger completion signal than this process's
          // in-memory phase. During a rolling cutover, the status request can
          // reach the draining process while build-info reaches the replacement.
          const buildResponse = await fetch("/api/build-info", {
            credentials: "include",
            cache: "no-store",
            signal: request.signal,
          });
          if (!buildResponse.ok) {
            throw new Error(`build info request failed: ${buildResponse.status}`);
          }
          const build = buildInfoSchema.parse(await buildResponse.json());
          if (
            !disposed &&
            generation === pollGenerationRef.current &&
            build.version === parsed.targetVersion
          ) {
            completedTargetRef.current = parsed.targetVersion;
            setCompletedTarget(parsed.targetVersion);
            setUpdatingSince(null);
            setStalledDismissed(false);
          }
        }
      } catch {
        // Expected while the server restarts mid-upgrade; transient otherwise.
        // Either way the loop keeps going — recovery is the next successful poll.
      } finally {
        window.clearTimeout(deadline);
        controller.signal.removeEventListener("abort", abortRequest);
        schedulePoll();
      }
    };

    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [pollMs, applySnapshot]);

  let state: UpgradeBannerState | null = null;
  if (updatingSince !== null) {
    state =
      stalled && stalledDismissed
        ? null
        : {
            phase: stalled ? "stalled" : "updating",
            targetVersion: server?.targetVersion ?? null,
            deadline: null,
            serverNow: server?.serverNow ?? Date.now(),
            receivedAt: server?.receivedAt ?? Date.now(),
          };
  } else if (server !== null && server.phase === "countdown") {
    state = { ...server, phase: "countdown" };
  }

  // While the banner is visible, tick every second: it re-renders the
  // countdown timer, watches for the deadline crossing zero (the server
  // proceeds on its own at that moment — consent-by-silence — so the client
  // enters the local updating state without waiting for an ack that will
  // never come), and carries the render across the stall boundary. Gated on
  // the *rendered* state, so a dismissed/hidden banner stops ticking — the
  // poll loop alone owns recovery from there.
  const bannerVisible = state !== null;
  useEffect(() => {
    if (!bannerVisible) return;
    const id = window.setInterval(() => {
      setTick((n) => n + 1);
      const current = serverRef.current;
      if (
        updatingSinceRef.current === null &&
        current !== null &&
        current.phase === "countdown" &&
        deadlineElapsed(current)
      ) {
        setUpdatingSince(Date.now());
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [bannerVisible]);

  const act = useCallback(
    async (verb: "now" | "defer"): Promise<boolean> => {
      // Bounded like the polls — `/now` is the request most likely to be
      // severed, since the restart it initiates can kill the connection
      // before the ack lands. Without the deadline a half-open POST would
      // pin the banner's busy state forever.
      const request = new AbortController();
      const deadline = window.setTimeout(() => request.abort(), UPGRADE_VERB_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/system/upgrade/${verb}`, {
          method: "POST",
          credentials: "include",
          signal: request.signal,
        });
        // A received non-2xx is a definitive rejection (Rome Cloud said no):
        // the countdown stands and the guardian sees the retry hint.
        if (!response.ok) return false;
        const parsed = upgradeStatusSchema.safeParse(await response.json());
        if (mountedRef.current === false) return true;
        // The response body is the ack: `now` answers with phase `updating`
        // once Rome Cloud accepts, `defer` with the reverted phase. Applying it
        // here gives instant feedback instead of waiting for the next poll;
        // the generation bump invalidates any snapshot poll still in flight.
        if (parsed.success) {
          pollGenerationRef.current += 1;
          applySnapshot(parsed.data);
        }
        return true;
      } catch {
        // Transport failure is ambiguous for `now`: Rome Cloud may have
        // accepted and the resulting restart severed the ack — or the server
        // may still be mid-relay, answering polls with the live countdown for
        // up to its 15s Rome Cloud budget. Enter the local updating state
        // optimistically and hold it through a grace window covering that
        // budget (live countdowns don't clear it until the window passes, and
        // in-flight polls are invalidated). If the relay truly failed, the
        // countdown outlives the grace and the banner self-corrects; if it
        // succeeded, the restart's failing polls change nothing and the
        // banner is already telling the truth. `defer` has no restart to
        // blame, so its failure is reported.
        if (verb === "now" && mountedRef.current && serverRef.current?.phase === "countdown") {
          ambiguousNowUntilRef.current = Date.now() + UPGRADE_VERB_TIMEOUT_MS;
          pollGenerationRef.current += 1;
          setUpdatingSince((current) => current ?? Date.now());
          return true;
        }
        return false;
      } finally {
        window.clearTimeout(deadline);
      }
    },
    [applySnapshot],
  );
  const updateNow = useCallback(() => act("now"), [act]);
  const defer = useCallback(() => act("defer"), [act]);
  const dismissStalled = useCallback(() => setStalledDismissed(true), []);

  return { state, updateNow, defer, dismissStalled };
}
