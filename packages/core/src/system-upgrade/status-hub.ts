// Server-authoritative upgrade consent state. Process model: docs/architecture/process.md.
//
// The hub owns the phase (`idle → countdown → updating`) and the countdown
// deadline. The deadline is authoritative *here*, not on any dashboard: when it
// elapses the hub invokes `onDeadline` on its own, so consent-by-silence holds
// even with no dashboard open. Dashboards read state exclusively by polling
// `GET /api/system/upgrade/status/snapshot`; the verbs are `POST .../now` and
// `.../defer`. There is no push channel — a restart severs any stream mid-
// cutover anyway, so polling is the whole read contract.
//
// `updating` is entered only after Rome Cloud has accepted the cutover, meaning
// this process is scheduled for replacement. The replacement process boots a
// fresh hub in `idle`, which is what a polling dashboard eventually observes.
// Until the process dies, `updating` tells late pollers "don't trust my
// idle-looking silence, a restart is in flight".
//
// Acceptance is not completion: Rome Cloud can accept and then fail before it
// stops this process, for example when the image pull fails. Every path that
// gets as far as stopping Rome replaces this process, so a process still alive
// after the restart window was never replaced. It returns to `idle`, so the
// banner clears and the next nightly probe can offer the release again.

import { createLogger } from "../logger.js";

const log = createLogger("upgrade-status-hub");

export type UpgradePhase = "idle" | "countdown" | "updating";

export interface UpgradeStatusSnapshot {
  phase: UpgradePhase;
  /** Target release version for the in-flight offer/cutover; null when idle. */
  targetVersion: string | null;
  /** Epoch ms when the countdown auto-proceeds; null outside `countdown`. */
  deadline: number | null;
  /** Server clock at snapshot time, so a dashboard renders the timer off server
   * time rather than its own (possibly skewed) clock. */
  serverNow: number;
}

export interface UpgradeStatusHubOptions {
  /** Invoked once when the countdown deadline elapses with no guardian verdict.
   * The callee performs the cutover (relay to Rome Cloud) and reports the outcome
   * back via `markRestarting()` on acceptance or `standDown()` on failure. */
  onDeadline: (targetVersion: string) => void;
  /** How long `updating` waits for this process to be replaced before it gives
   * the accepted cutover up and returns to `idle`. Must outlast Rome Cloud's
   * own upgrade timeout, or a slow but live upgrade reads as failed. */
  restartWindowMs: number;
  /** Time source — injectable for tests. */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class UpgradeStatusHub {
  private phase: UpgradePhase = "idle";
  private targetVersion: string | null = null;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly onDeadline: (targetVersion: string) => void;
  private readonly restartWindowMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(options: UpgradeStatusHubOptions) {
    this.onDeadline = options.onDeadline;
    this.restartWindowMs = options.restartWindowMs;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  }

  getSnapshot(): UpgradeStatusSnapshot {
    return {
      phase: this.phase,
      targetVersion: this.targetVersion,
      deadline: this.deadline,
      serverNow: this.now(),
    };
  }

  /** Open the consent countdown for `targetVersion`. Idempotent: a re-offer
   * while a countdown (or cutover) is already up is a no-op, so the nightly
   * routine re-firing never resets the deadline or stacks timers. Returns
   * whether a new countdown was started. */
  beginCountdown(targetVersion: string, durationMs: number): boolean {
    if (this.phase !== "idle") return false;
    this.phase = "countdown";
    this.targetVersion = targetVersion;
    this.deadline = this.now() + durationMs;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.phase !== "countdown" || this.targetVersion === null) return;
      log.info("upgrade countdown elapsed; proceeding on silence", {
        targetVersion: this.targetVersion,
      });
      // The phase stays `countdown` (with a now-past deadline) while the callee
      // relays to Rome Cloud; only the reported outcome moves it.
      this.onDeadline(this.targetVersion);
    }, durationMs);
    log.info("upgrade countdown started", { targetVersion, durationMs });
    return true;
  }

  /** Guardian deferred — tear the countdown down and return to idle. The
   * re-offer happens on the next nightly routine fire (the re-offer interval is
   * the routine's cadence). No-op unless a countdown is live. */
  defer(): void {
    if (this.phase !== "countdown") return;
    log.info("upgrade countdown deferred by guardian", { targetVersion: this.targetVersion });
    this.reset();
  }

  /** Rome Cloud accepted the cutover: this process is now scheduled for
   * replacement. Leaves `updating` only if the restart window passes with this
   * process still alive — see the header. No-op unless a countdown is live. */
  markRestarting(): void {
    if (this.phase !== "countdown") return;
    log.info("upgrade cutover accepted; awaiting restart", { targetVersion: this.targetVersion });
    this.clear();
    this.phase = "updating";
    this.deadline = null;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.phase !== "updating") return;
      log.warn("accepted upgrade never replaced this process; returning to idle", {
        targetVersion: this.targetVersion,
        restartWindowMs: this.restartWindowMs,
      });
      this.reset();
    }, this.restartWindowMs);
  }

  /** The deadline-path cutover could not be handed to Rome Cloud (rejected or
   * unreachable) — return to idle so the next nightly probe can re-offer.
   * No-op unless a countdown is live. */
  standDown(): void {
    if (this.phase !== "countdown") return;
    log.warn("upgrade cutover failed; standing down", { targetVersion: this.targetVersion });
    this.reset();
  }

  private reset(): void {
    this.clear();
    this.phase = "idle";
    this.targetVersion = null;
    this.deadline = null;
  }

  private clear(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
