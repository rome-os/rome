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
  /** Wait after a newly registered visitor signs in before resending, so a burst sends once. */
  resyncDelayMs?: number;
  timeoutMs?: number;
}

type SendOutcome =
  | {
      kind: "ok";
      /** The revision Rome Cloud holds after the request. */
      cloudRevision: number | null;
      /** Whether Rome Cloud stored this list. Null from a Rome Cloud that predates the field. */
      applied: boolean | null;
      /** Listed emails with no Rome Cloud account, when Rome Cloud reports them. */
      unmatched: string[] | null;
    }
  | { kind: "rejected" | "skipped" | "retry" };

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const DEFAULT_RESYNC_DELAY_MS = 2_000;

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
  // What Rome Cloud last applied, and under which enrollment. A link change or
  // a due resend bumps the generation, so a list applied before it never counts
  // after it, and a send already in flight is sent again.
  private settled: { enrollment: string; generation: number; revision: number } | null = null;
  private generation = 0;
  // Emails Rome Cloud last reported with no account. Rome Cloud keeps nothing
  // for them, so when one of them signs in the list goes out again for Rome
  // Cloud to match the new account.
  private unmatched = new Set<string>();
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.unsubscribe = (deps.onLinkChanged ?? onInstanceTokenChanged)(() => this.resend());
  }

  /**
   * Tells the sync that a visitor signed in. When Rome Cloud last reported
   * their email with no account, they have made one since, so the list is sent
   * again. Sign-ins in quick succession send it once. Every other sign-in does nothing.
   */
  visitorSignedIn(email: string): void {
    const normalized = normalizePublicAccessEmail(email);
    if (!normalized || !this.unmatched.delete(normalized)) return;
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.log.info("visitor allow-list resent after an invited visitor signed up", {
        revision: this.latest?.revision ?? null,
        stillUnmatched: this.unmatched.size,
      });
      this.resend();
    }, this.deps.resyncDelayMs ?? DEFAULT_RESYNC_DELAY_MS);
    this.resyncTimer.unref?.();
  }

  // Sends the current list again even though Rome Cloud applied it.
  private resend(): void {
    this.generation += 1;
    this.settled = null;
    this.failures = 0;
    this.clearRetry();
    this.kick();
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
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
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
        const generation = this.generation;
        if (!list || this.isSettled(list, enrollment)) return;
        const outcome = await this.send(list);
        // A save during the send queued a newer list, the instance linked
        // again, or a resend fell due: send the current list instead.
        if (
          this.latest !== list ||
          this.generation !== generation ||
          this.enrollmentId() !== enrollment
        )
          continue;
        if (outcome.kind === "retry") {
          this.scheduleRetry();
          return;
        }
        if (outcome.kind !== "ok") {
          // A skipped or refused list is sent again on the next push: a save,
          // a boot, or the instance linking.
          return;
        }
        // Rome Cloud holds a higher revision than this instance stored, as after
        // a database reset or a restore, so it did not store the list. Store a
        // revision past Rome Cloud's and send the list again. A Rome Cloud that
        // predates `applied` is judged by the revision it answers with.
        const applied =
          outcome.applied ??
          (outcome.cloudRevision === null || outcome.cloudRevision <= list.revision);
        if (!applied) {
          if (!this.deps.raiseRevisionPast) return;
          const floor = Math.max(outcome.cloudRevision ?? list.revision, list.revision);
          if (await this.raisePast(floor)) continue;
          this.scheduleRetry();
          return;
        }
        // Only an applied list settles.
        if (enrollment) this.settled = { enrollment, generation, revision: list.revision };
        if (outcome.unmatched) {
          this.unmatched = new Set(
            outcome.unmatched
              .map(normalizePublicAccessEmail)
              .filter((email): email is string => email !== null),
          );
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
      this.settled.generation === this.generation &&
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
      // `revision` is what Rome Cloud now holds, and `applied` whether it stored
      // this list. `unmatched` lists emails with no Rome Cloud account. It is
      // kept in memory to resend the list when one of them signs in, and only
      // its size is logged.
      const body = (await response.json().catch(() => null)) as {
        revision?: unknown;
        applied?: unknown;
        unmatched?: unknown;
      } | null;
      const cloudRevision =
        typeof body?.revision === "number" && Number.isSafeInteger(body.revision)
          ? body.revision
          : null;
      const applied = typeof body?.applied === "boolean" ? body.applied : null;
      const unmatched = Array.isArray(body?.unmatched)
        ? body.unmatched.filter((email): email is string => typeof email === "string")
        : null;
      this.log.info("visitor allow-list synced", {
        ...fields,
        outcome: applied === false ? "not_applied" : "ok",
        cloudRevision,
        unmatched: unmatched?.length ?? null,
      });
      return { kind: "ok", cloudRevision, applied, unmatched };
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
