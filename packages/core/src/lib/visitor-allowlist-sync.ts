import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger, type Logger } from "../logger.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  normalizeDashboardAccessConfig,
  readDashboardAccessRevision,
} from "./dashboard-access-config.js";
import {
  cloudBearer,
  getInstanceToken,
  instanceCredentialId,
  onInstanceTokenChanged,
} from "./instance-identity.js";
import { normalizePublicAccessEmail } from "./public-access-config.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

export interface VisitorAllowList {
  emails: readonly string[];
  revision: number;
}

export interface VisitorAllowListSyncDeps {
  /** The stable name of this instance's Rome Cloud enrollment, or null when it has none. */
  getEnrollmentId?: () => string | null;
  /** A bearer for one request. Null while linked is a passing gap, such as a signer restart. */
  getToken?: () => string | null | Promise<string | null>;
  getOrigin?: () => string | null;
  /** Subscribes to the instance linking, unlinking, or changing its credential. */
  onLinkChanged?: (listener: () => void) => () => void;
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, "debug" | "info" | "warn">;
  /** Wait before each retry. The last entry repeats until a send settles. */
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
}

type SendOutcome = "ok" | "rejected" | "skipped" | "retry";

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/**
 * Sends the dashboard allow-list to Rome Cloud so it can list this instance to
 * the visitors on it. Rome Cloud uses its copy only to list instances and issue
 * visitor codes. Sign-in still re-checks the instance's own list, so a late or
 * failed sync can only show an instance a visitor cannot open, never let anyone in.
 *
 * Only the newest list is ever sent, and a send never blocks the caller. Logs
 * carry the count, revision, and outcome, never an email.
 */
export class VisitorAllowListSync {
  private latest: VisitorAllowList | null = null;
  // What Rome Cloud last accepted, and under which enrollment. A link change
  // bumps the generation, so a list accepted before it never counts after it.
  private settled: { enrollment: string; generation: number; revision: number } | null = null;
  private linkGeneration = 0;
  private readonly unsubscribe: () => void;
  private draining = false;
  private running: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private readonly log: Pick<Logger, "debug" | "info" | "warn">;

  constructor(private readonly deps: VisitorAllowListSyncDeps = {}) {
    this.log = deps.logger ?? createLogger("visitor-allowlist-sync");
    // A new enrollment, even one with the same credential, starts with an
    // empty list on Rome Cloud, so it gets the current list again.
    this.unsubscribe = (deps.onLinkChanged ?? onInstanceTokenChanged)(() => {
      this.linkGeneration += 1;
      this.settled = null;
      this.failures = 0;
      this.clearRetry();
      this.kick();
    });
  }

  /** Queues a list for delivery and returns at once. An older revision than the queued one is dropped. */
  push(list: VisitorAllowList): void {
    if (this.latest && list.revision < this.latest.revision) return;
    const emails = Array.from(
      new Set(
        list.emails
          .map(normalizePublicAccessEmail)
          .filter((email): email is string => email !== null),
      ),
    ).sort();
    this.latest = { emails, revision: list.revision };
    this.failures = 0;
    this.clearRetry();
    this.kick();
  }

  /** Resolves when no send is in flight. A scheduled retry does not count. */
  async idle(): Promise<void> {
    while (this.draining) await this.running;
  }

  stop(): void {
    this.unsubscribe();
    this.clearRetry();
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    this.running = this.drain();
  }

  // The flag clears in the same synchronous step as the last look at `latest`,
  // so a push either lands before that look or finds the sync idle and starts
  // a new drain. A drain that finishes without awaiting has already cleared the
  // flag by the time `kick` stores its promise.
  private async drain(): Promise<void> {
    try {
      for (;;) {
        const list = this.latest;
        const enrollment = this.enrollmentId();
        const generation = this.linkGeneration;
        if (!list || this.isSettled(list, enrollment)) return;
        const outcome = await this.send(list);
        // A save during the send queued a newer list, or the instance linked
        // again: send the current list to the current enrollment instead.
        if (
          this.latest !== list ||
          this.linkGeneration !== generation ||
          this.enrollmentId() !== enrollment
        )
          continue;
        if (outcome === "retry") {
          this.scheduleRetry();
          return;
        }
        // Only an accepted list settles. A skipped or refused one is sent again
        // on the next push: a save, a boot, or the instance linking.
        if (outcome === "ok" && enrollment) {
          this.settled = { enrollment, generation, revision: list.revision };
        }
        return;
      }
    } finally {
      this.draining = false;
    }
  }

  private scheduleRetry(): void {
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 0;
    this.failures += 1;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private isSettled(list: VisitorAllowList, enrollment: string | null): boolean {
    return (
      this.settled !== null &&
      this.settled.revision === list.revision &&
      this.settled.generation === this.linkGeneration &&
      this.settled.enrollment === enrollment
    );
  }

  private enrollmentId(): string | null {
    // A signer-mode instance whose key is not registered yet still calls Rome
    // Cloud with its instance token, so that token names the enrollment until then.
    return (this.deps.getEnrollmentId ?? (() => instanceCredentialId() ?? getInstanceToken()))();
  }

  private async send(list: VisitorAllowList): Promise<SendOutcome> {
    const fields = { revision: list.revision, count: list.emails.length };
    const origin = (this.deps.getOrigin ?? getRomeCloudOrigin)();
    if (!this.enrollmentId() || !origin) {
      this.log.debug("visitor allow-list sync skipped", {
        ...fields,
        outcome: origin ? "not_linked" : "no_origin",
      });
      return "skipped";
    }

    let token: string | null;
    try {
      token = await (this.deps.getToken ?? cloudBearer)();
    } catch (err) {
      this.log.warn("visitor allow-list sync failed", {
        ...fields,
        outcome: "credential_error",
        error: err instanceof Error ? err.message : String(err),
      });
      return "retry";
    }
    if (!token) {
      this.log.warn("visitor allow-list sync failed", {
        ...fields,
        outcome: "no_bearer",
        attempt: this.failures + 1,
      });
      return "retry";
    }

    let response: Response;
    try {
      response = await (this.deps.fetchImpl ?? fetch)(new URL("/api/instance/visitors", origin), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        cache: "no-store",
        body: JSON.stringify({ emails: list.emails, revision: list.revision }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
      });
    } catch (err) {
      this.log.warn("visitor allow-list sync failed", {
        ...fields,
        outcome: "unreachable",
        attempt: this.failures + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      return "retry";
    }
    await response.body?.cancel().catch(() => {});

    if (response.ok) {
      this.log.info("visitor allow-list synced", { ...fields, outcome: "ok" });
      return "ok";
    }
    const transient = response.status >= 500 || response.status === 408 || response.status === 429;
    this.log.warn("visitor allow-list sync failed", {
      ...fields,
      outcome: transient ? "retrying" : "rejected",
      status: response.status,
      attempt: this.failures + 1,
    });
    return transient ? "retry" : "rejected";
  }
}

/** Queues the stored allow-list. Boot and instance linking call this. */
export async function syncStoredVisitorAllowList(
  settingsRepo: Pick<SettingsRepository, "get">,
  sync: Pick<VisitorAllowListSync, "push">,
): Promise<void> {
  const stored = await settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
  sync.push({
    emails: normalizeDashboardAccessConfig(stored).cloudEmailAccess,
    revision: readDashboardAccessRevision(stored),
  });
}
