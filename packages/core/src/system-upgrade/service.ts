// Upgrade probe and cutover owner. Process model: docs/architecture/process.md.
//
// `checkAndOffer()` is the body of the nightly `system_upgrade` action: it asks
// Rome Cloud whether a release is pending and,
// if so, opens the consent countdown on the UpgradeStatusHub. The cutover is the
// same service relaying the apply request to Rome Cloud, reached two ways: a
// guardian's `requestNow()` (awaited, so the route can ack "restart initiated"
// or surface the failure) and the hub's deadline elapsing (consent-by-silence).
// Both funnel through one guarded relay; the hub phase moves only on the
// relay's outcome — `updating` after Rome Cloud accepts, unchanged (button path)
// or back to idle (deadline path) when it doesn't.

import { createLogger } from "../logger.js";
import {
  applyUpgrade as defaultApplyUpgrade,
  checkUpgrade as defaultCheckUpgrade,
  type ApplyResult,
  type CheckResult,
} from "./rome-cloud-client.js";
import { UpgradeStatusHub } from "./status-hub.js";

const log = createLogger("system-upgrade");

/** Rome Cloud spends up to 40 minutes on an accepted upgrade: up to 10 pulling
 * images, then up to 30 for the upgrade itself, rollback included. Every path
 * that stops Rome replaces this process. An hour leaves margin for queueing
 * before the upgrade starts. */
export const UPGRADE_RESTART_WINDOW_MS = 60 * 60_000;

export interface SystemUpgradeOfferResult {
  /** Whether an upgrade offer is now (or already was) live. */
  pending: boolean;
  /** Release version being offered, when one is. */
  targetVersion?: string;
}

export type UpgradeNowResult = { ok: true } | { ok: false; error: string };

/** The action-facing surface of the service. The `system_upgrade` action runs
 * in a worker subprocess, so it depends on this interface — satisfied by the
 * real service in the main process and by `SystemUpgradeServiceProxy` (which
 * RPCs back to main) in a worker. */
export interface SystemUpgradeChecker {
  checkAndOffer(): Promise<SystemUpgradeOfferResult>;
}

export interface SystemUpgradeServiceOptions {
  /** How long the consent countdown runs before proceeding on silence. */
  countdownMs: number;
  /** How long an accepted cutover may leave this process alive before the hub
   * returns to idle. Defaults to `UPGRADE_RESTART_WINDOW_MS`. */
  restartWindowMs?: number;
  /** Whether the automatic nightly flow is enabled for this instance — the
   * `auto_upgrade` rollout gate, evaluated live on each probe so a flip takes
   * effect on the next fire without a restart. Defaults to always-enabled when
   * omitted (tests + ungated construction). */
  isEnabled?: () => Promise<boolean>;
  /** Rome Cloud client seam — overridable in tests. */
  checkUpgrade?: () => Promise<CheckResult>;
  applyUpgrade?: (target: string) => Promise<ApplyResult>;
  /** Forwarded to the hub for deterministic tests. */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class SystemUpgradeService implements SystemUpgradeChecker {
  private readonly hub: UpgradeStatusHub;
  private readonly countdownMs: number;
  private readonly isEnabled: () => Promise<boolean>;
  private readonly checkUpgrade: () => Promise<CheckResult>;
  private readonly applyUpgrade: (target: string) => Promise<ApplyResult>;
  /** Serializes the two cutover entry points: a deadline firing while a
   * guardian's request is mid-relay (or vice versa) must not double-apply.
   * Holding the promise (not just a flag) lets the deadline path adopt an
   * in-flight relay's outcome instead of silently dropping its own turn. */
  private pendingRelay: Promise<UpgradeNowResult> | null = null;

  constructor(options: SystemUpgradeServiceOptions) {
    this.countdownMs = options.countdownMs;
    this.isEnabled = options.isEnabled ?? (async () => true);
    this.checkUpgrade = options.checkUpgrade ?? defaultCheckUpgrade;
    this.applyUpgrade = options.applyUpgrade ?? defaultApplyUpgrade;
    this.hub = new UpgradeStatusHub({
      onDeadline: (target) => {
        void this.cutoverOnDeadline(target);
      },
      restartWindowMs: options.restartWindowMs ?? UPGRADE_RESTART_WINDOW_MS,
      now: options.now,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
    });
  }

  /** Snapshot source + countdown verbs the routes are mounted on. */
  getHub(): UpgradeStatusHub {
    return this.hub;
  }

  /** Nightly probe body. Asks Rome Cloud for a pending release; opens the
   * countdown if one is available. Idempotent: a re-fire while a countdown (or
   * cutover) is already up no-ops, so a 3am re-fire never resets the deadline. */
  async checkAndOffer(): Promise<SystemUpgradeOfferResult> {
    // Gate the automatic flow: a disabled instance never probes Rome Cloud nor
    // opens a countdown. Checked first (and live) so a flipped `auto_upgrade`
    // gate takes effect on the next nightly fire without a restart. Fails
    // closed.
    if (!(await this.isEnabled())) {
      return { pending: false };
    }

    const snapshot = this.hub.getSnapshot();
    if (snapshot.phase !== "idle") {
      // A countdown or cutover is already live — nothing to re-open.
      return { pending: true, targetVersion: snapshot.targetVersion ?? undefined };
    }

    let check: CheckResult;
    try {
      check = await this.checkUpgrade();
    } catch (err) {
      log.warn("upgrade check threw; nothing offered", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { pending: false };
    }

    if (!check.ok) {
      // Unconfigured / unreachable / unversioned are all "nothing to do
      // tonight" from the probe's vantage — log and stand down.
      log.info("upgrade check did not yield an offer", { reason: check.error });
      return { pending: false };
    }
    if (!check.data.upgradeAvailable) {
      return { pending: false };
    }

    const targetVersion = check.data.latest.version;
    this.hub.beginCountdown(targetVersion, this.countdownMs);
    return { pending: true, targetVersion };
  }

  /** Guardian (banner "Update now") — relay the cutover to Rome Cloud and report
   * the verdict. `ok: true` means the restart is genuinely initiated (or there
   * was nothing to do — the verbs stay idempotent for double-clicks and stale
   * tabs). On failure the countdown is left standing: while the deadline is
   * still in the future it stays armed, so the cutover retries on silence and
   * the guardian can retry the button. (If the deadline fired *during* the
   * failed relay, the deadline path adopts the failure and stands down — see
   * `cutoverOnDeadline`.) */
  async requestNow(): Promise<UpgradeNowResult> {
    // A relay is already mid-flight (double-click, or the deadline beat the
    // button): share its outcome rather than acking `ok` against a snapshot
    // that still says countdown.
    if (this.pendingRelay !== null) return await this.pendingRelay;
    const snapshot = this.hub.getSnapshot();
    if (snapshot.phase !== "countdown" || snapshot.targetVersion === null) {
      return { ok: true };
    }
    log.info("upgrade countdown skipped by guardian", { targetVersion: snapshot.targetVersion });
    return await this.relayCutover(snapshot.targetVersion);
  }

  /** Guardian (banner "Remind me later") — defer to the next nightly fire.
   * No-op once a cutover relay is in flight: the apply may already be
   * committing at Rome Cloud, and resetting the hub to idle here would make the
   * later `markRestarting()` no-op — a committed restart the snapshot then
   * denies. Past that point the only truthful outcomes are the relay's own. */
  requestDefer(): void {
    if (this.pendingRelay !== null) return;
    this.hub.defer();
  }

  /** Deadline elapsed with no verdict — same relay, but with no requester to
   * hand the failure to: a failed relay stands the hub down to idle so the
   * next nightly probe re-offers, instead of leaving a dead countdown up.
   *
   * If a guardian relay is already mid-flight, the fired timer is spent and
   * will never re-arm — so rather than bailing, adopt that relay's outcome:
   * on success the hub is already `updating`; on failure it is still
   * `countdown` with no timer left, and only standing down here keeps the
   * offer from being stuck past its deadline forever (the nightly probe
   * no-ops on any non-idle phase). */
  private async cutoverOnDeadline(target: string): Promise<void> {
    const outcome = await (this.pendingRelay ?? this.relayCutover(target));
    if (!outcome.ok) this.hub.standDown();
  }

  /** Relay the apply to Rome Cloud, which orchestrates the restart. Only a 200
   * from Rome Cloud moves the hub to `updating` — after that this process is
   * living on borrowed time, and only the hub's restart window brings it back
   * to idle. */
  private relayCutover(target: string): Promise<UpgradeNowResult> {
    // The clear runs in a microtask, so it always lands after the assignment
    // below even if the relay settles without ever suspending.
    const relay = this.performRelay(target).finally(() => {
      this.pendingRelay = null;
    });
    this.pendingRelay = relay;
    return relay;
  }

  private async performRelay(target: string): Promise<UpgradeNowResult> {
    let result: ApplyResult;
    try {
      result = await this.applyUpgrade(target);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      this.hub.markRestarting();
      return { ok: true };
    }
    log.error("upgrade cutover failed", { target, error: result.error });
    return { ok: false, error: result.error };
  }
}
