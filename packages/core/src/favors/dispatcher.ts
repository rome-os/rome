import type { ActionEngine } from "../apps/actions/engine.js";
import { createLogger } from "../logger.js";
import type { FavorActionDispatchClaim, FavorActionRequestView, FavorService } from "./types.js";

const log = createLogger("favor-dispatcher");
const DEFAULT_SYNC_INTERVAL_MS = 60_000;

interface RunActionRef {
  kind: "run_action";
  name: string;
  args: Record<string, unknown>;
}

function isRunActionRef(value: unknown): value is RunActionRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "run_action" &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).args === "object" &&
    (value as Record<string, unknown>).args !== null &&
    !Array.isArray((value as Record<string, unknown>).args)
  );
}

function isClaimable(view: FavorActionRequestView, now = new Date()): boolean {
  if (view.status !== "settled") return false;
  if (view.dispatchStatus === "queued") return true;
  if (view.dispatchStatus !== "claimed" || !view.dispatchClaimExpiresAt) return false;
  return new Date(view.dispatchClaimExpiresAt) <= now;
}

function claimRenewDelayMs(claimExpiresAt: string): number {
  const remaining = new Date(claimExpiresAt).getTime() - Date.now();
  return Math.max(5_000, Math.floor(remaining / 2));
}

export class FavorDispatchRunner {
  private timer: NodeJS.Timeout | null = null;
  private cursor: string | undefined;
  private running = false;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: {
      favorService: FavorService;
      actionEngine: ActionEngine;
      intervalMs?: number;
      canSync?: () => boolean;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.runOnce(),
      this.deps.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.deps.canSync && !this.deps.canSync()) return;
    if (this.running) return;
    this.running = true;
    try {
      const page = await this.deps.favorService.syncActionRequests(this.cursor);
      this.cursor = page.nextCursor;
      for (const request of page.requests) {
        if (!isClaimable(request) || this.inFlight.has(request.id)) continue;
        this.inFlight.add(request.id);
        void this.dispatch(request.id).finally(() => {
          this.inFlight.delete(request.id);
        });
      }
    } catch (err) {
      log.warn("favor dispatch sync failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }

  private async dispatch(id: string): Promise<void> {
    let claim: FavorActionDispatchClaim;
    try {
      claim = await this.deps.favorService.claimDispatch(id);
    } catch (err) {
      log.warn("favor dispatch claim failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (claim.status !== "claimed") return;

    let renewTimer: NodeJS.Timeout | null = null;
    const scheduleRenewal = (claimExpiresAt: string) => {
      renewTimer = setTimeout(async () => {
        try {
          const renewed = await this.deps.favorService.renewDispatchClaim(id, claim.claimToken);
          scheduleRenewal(renewed.claimExpiresAt);
        } catch (err) {
          log.warn("favor dispatch claim renewal failed", {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, claimRenewDelayMs(claimExpiresAt));
    };
    scheduleRenewal(claim.claimExpiresAt);

    try {
      if (!isRunActionRef(claim.actionRef)) {
        throw new Error(`Unsupported favor action_ref kind "${String(claim.actionRef.kind)}"`);
      }
      const result = await this.deps.actionEngine.run(claim.actionRef.name, claim.actionRef.args, {
        executionId: id,
        rootExecutionId: id,
        initiator: `favor:${id}`,
        sharedContext: {
          favorActionRequestId: id,
          favorActionRefHash: claim.actionRefHash,
          favorDispatchAttempt: claim.dispatchAttempt,
        },
      });
      if (result.status === "ok" || result.status === "place_widget") {
        await this.deps.favorService.reportDispatchResult(id, {
          claimToken: claim.claimToken,
          actionRefHash: claim.actionRefHash,
          status: "succeeded",
          completedAt: new Date().toISOString(),
          outputRef:
            result.status === "ok" ? { data: result.data } : { placement: result.placement },
        });
        return;
      }
      const message =
        result.status === "error"
          ? result.error
          : `Action suspended with status ${result.status}; favor dispatch requires completion`;
      await this.deps.favorService.reportDispatchResult(id, {
        claimToken: claim.claimToken,
        actionRefHash: claim.actionRefHash,
        status: "action_failed",
        completedAt: new Date().toISOString(),
        error: {
          code: result.status,
          message,
          retryable: result.status !== "error",
        },
      });
    } catch (err) {
      await this.deps.favorService
        .reportDispatchResult(id, {
          claimToken: claim.claimToken,
          actionRefHash: claim.actionRefHash,
          status: "action_failed",
          completedAt: new Date().toISOString(),
          error: {
            code: "handler_error",
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
          },
        })
        .catch((reportErr) => {
          log.warn("favor dispatch failure report failed", {
            id,
            error: reportErr instanceof Error ? reportErr.message : String(reportErr),
          });
        });
    } finally {
      if (renewTimer) clearTimeout(renewTimer);
    }
  }
}
