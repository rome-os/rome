import { createLogger, type Logger } from "../logger.js";
import type { DashboardAccessStore, VisitorAllowList } from "./dashboard-access-store.js";
import {
  cloudBearer,
  getInstanceToken,
  instanceCredentialId,
  onInstanceTokenChanged,
} from "./instance-identity.js";
import { normalizePublicAccessEmail } from "./public-access-config.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

export type { VisitorAllowList } from "./dashboard-access-store.js";

export interface VisitorAllowListSyncDeps {
  /** The stable name of this instance's Rome Cloud enrollment, or null when it has none. */
  getEnrollmentId?: () => string | null;
  /** A bearer for one request. Null while linked is a passing gap, such as a signer restart. */
  getToken?: () => string | null | Promise<string | null>;
  getOrigin?: () => string | null;
  /** Subscribes to the instance linking, unlinking, or changing its credential. */
  onLinkChanged?: (listener: () => void) => () => void;
  /**
   * Stores a revision past `floor` and returns the list under it. Called when
   * Rome Cloud holds a higher revision than the one sent.
   */
  raiseRevisionPast?: (floor: number) => Promise<VisitorAllowList>;
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, "debug" | "info" | "warn">;
  /** Wait before each retry. The last entry repeats until a send settles. */
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
}

type SendOutcome =
  | { kind: "ok"; cloudRevision: number | null }
  | { kind: "rejected" | "skipped" | "retry" };

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
    if (!this.queue(list)) return;
    this.failures = 0;
    this.clearRetry();
    this.kick();
  }

  // Makes `list` the one to send. False when a newer one is already queued.
  private queue(list: VisitorAllowList): boolean {
    if (this.latest && list.revision < this.latest.revision) return false;
    const emails = Array.from(
      new Set(
        list.emails
          .map(normalizePublicAccessEmail)
          .filter((email): email is string => email !== null),
      ),
    ).sort();
    this.latest = { emails, revision: list.revision };
    return true;
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
        if (outcome.kind === "retry") {
          this.scheduleRetry();
          return;
        }
        // Rome Cloud holds a higher revision than this instance stored, so it
        // ignored the list. Store a revision past it and send the list again.
        if (
          outcome.kind === "ok" &&
          outcome.cloudRevision !== null &&
          outcome.cloudRevision > list.revision &&
          this.deps.raiseRevisionPast
        ) {
          if (await this.raisePast(outcome.cloudRevision)) continue;
          this.scheduleRetry();
          return;
        }
        // Only an accepted list settles. A skipped or refused one is sent again
        // on the next push: a save, a boot, or the instance linking.
        if (outcome.kind === "ok" && enrollment) {
          this.settled = { enrollment, generation, revision: list.revision };
        }
        return;
      }
    } finally {
      this.draining = false;
    }
  }

  // Queues the stored list under a revision past `floor`. False when storing it failed.
  private async raisePast(floor: number): Promise<boolean> {
    try {
      const raised = await this.deps.raiseRevisionPast?.(floor);
      if (raised) this.queue(raised);
      this.log.info("visitor allow-list revision raised past Rome Cloud's", {
        revision: raised?.revision ?? null,
        cloudRevision: floor,
      });
      return true;
    } catch (err) {
      this.log.warn("visitor allow-list revision raise failed", {
        cloudRevision: floor,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
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
      return { kind: "skipped" };
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
      return { kind: "retry" };
    }
    if (!token) {
      this.log.warn("visitor allow-list sync failed", {
        ...fields,
        outcome: "no_bearer",
        attempt: this.failures + 1,
      });
      return { kind: "retry" };
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
      return { kind: "retry" };
    }
    if (response.ok) {
      // `revision` is what Rome Cloud now holds. `unmatched` lists emails with no
      // Rome Cloud account, and only its size is logged.
      const body = (await response.json().catch(() => null)) as {
        revision?: unknown;
        unmatched?: unknown;
      } | null;
      const cloudRevision =
        typeof body?.revision === "number" && Number.isSafeInteger(body.revision)
          ? body.revision
          : null;
      this.log.info("visitor allow-list synced", {
        ...fields,
        outcome: "ok",
        cloudRevision,
        unmatched: Array.isArray(body?.unmatched) ? body.unmatched.length : null,
      });
      return { kind: "ok", cloudRevision };
    }
    await response.body?.cancel().catch(() => {});
    const transient = response.status >= 500 || response.status === 408 || response.status === 429;
    this.log.warn("visitor allow-list sync failed", {
      ...fields,
      outcome: transient ? "retrying" : "rejected",
      status: response.status,
      attempt: this.failures + 1,
    });
    return { kind: transient ? "retry" : "rejected" };
  }
}

/** Queues the stored allow-list. Boot and instance linking call this. */
export async function syncStoredVisitorAllowList(
  store: Pick<DashboardAccessStore, "read">,
  sync: Pick<VisitorAllowListSync, "push">,
): Promise<void> {
  sync.push(await store.read());
}
