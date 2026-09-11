import { createLogger } from "../logger.js";
import type {
  LinkedInParticipantInput,
  LinkedInParticipantProfileSyncState,
  LinkedInThreadParticipantInput,
} from "./linkedin-sync.js";

const log = createLogger("linkedin-profile-sync");

export const DEFAULT_LINKEDIN_PROFILE_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
export const DEFAULT_LINKEDIN_PROFILE_RETRY_BASE_MS = 5 * 60_000;
export const DEFAULT_LINKEDIN_PROFILE_RETRY_MAX_MS = 6 * 60 * 60_000;

export interface LinkedInParticipantProfileStore {
  getParticipantProfileSyncStates(
    participantIds: string[],
  ): Promise<Map<string, LinkedInParticipantProfileSyncState>>;
  upsertParticipantProfile(participant: LinkedInParticipantInput): Promise<void>;
  recordParticipantProfileSyncFailure(
    participant: LinkedInThreadParticipantInput,
    failureCount: number,
    retryAt: Date,
  ): Promise<void>;
}

export interface LinkedInParticipantProfileSynchronizerOptions {
  refreshIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Test seam for freshness and retry deadlines. */
  now?: () => Date;
}

export type LinkedInParticipantProfileSyncResult = "synced" | "fresh" | "backoff" | "failed";

/**
 * Account-scoped profile cache shared by every LinkedIn thread in this
 * process. The durable store carries freshness across restarts; `inFlight`
 * closes the smaller race where concurrent threads expose the same account.
 * This consumes basic metadata already attached to messaging responses; it
 * never calls LinkedIn's separate `contact-info` profile endpoint.
 */
export class LinkedInParticipantProfileSynchronizer {
  private readonly refreshIntervalMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<LinkedInParticipantProfileSyncResult>>();

  constructor(
    private readonly store: LinkedInParticipantProfileStore,
    opts: LinkedInParticipantProfileSynchronizerOptions = {},
  ) {
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_LINKEDIN_PROFILE_REFRESH_INTERVAL_MS;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_LINKEDIN_PROFILE_RETRY_BASE_MS;
    this.retryMaxMs = opts.retryMaxMs ?? DEFAULT_LINKEDIN_PROFILE_RETRY_MAX_MS;
    this.now = opts.now ?? (() => new Date());
  }

  async sync(
    participants: LinkedInParticipantInput[],
  ): Promise<Map<string, LinkedInParticipantProfileSyncResult>> {
    const unique = new Map(
      participants.map((participant) => [participant.participantId, participant]),
    );
    const entries = await Promise.all(
      [...unique.values()].map(
        async (participant) =>
          [participant.participantId, await this.syncOne(participant)] as const,
      ),
    );
    return new Map(entries);
  }

  private syncOne(
    participant: LinkedInParticipantInput,
  ): Promise<LinkedInParticipantProfileSyncResult> {
    const existing = this.inFlight.get(participant.participantId);
    if (existing) return existing;

    const attempt = this.attempt(participant).finally(() => {
      if (this.inFlight.get(participant.participantId) === attempt) {
        this.inFlight.delete(participant.participantId);
      }
    });
    this.inFlight.set(participant.participantId, attempt);
    return attempt;
  }

  private async attempt(
    participant: LinkedInParticipantInput,
  ): Promise<LinkedInParticipantProfileSyncResult> {
    const now = this.now();
    let state: LinkedInParticipantProfileSyncState | undefined;
    try {
      state = (await this.store.getParticipantProfileSyncStates([participant.participantId])).get(
        participant.participantId,
      );
    } catch (error) {
      return this.handleFailure(participant, undefined, now, error);
    }
    if (state?.profileSyncRetryAt && state.profileSyncRetryAt.getTime() > now.getTime()) {
      return "backoff";
    }
    if (
      state?.lastSuccessfulSyncAt &&
      now.getTime() - state.lastSuccessfulSyncAt.getTime() < this.refreshIntervalMs
    ) {
      return "fresh";
    }

    try {
      await this.store.upsertParticipantProfile(participant);
      return "synced";
    } catch (error) {
      return this.handleFailure(participant, state, now, error);
    }
  }

  private async handleFailure(
    participant: LinkedInParticipantInput,
    state: LinkedInParticipantProfileSyncState | undefined,
    now: Date,
    error: unknown,
  ): Promise<LinkedInParticipantProfileSyncResult> {
    const failureCount = (state?.profileSyncFailureCount ?? 0) + 1;
    const retryAt = new Date(now.getTime() + this.retryDelayMs(failureCount));
    try {
      await this.store.recordParticipantProfileSyncFailure(
        { participantId: participant.participantId, isSelf: participant.isSelf },
        failureCount,
        retryAt,
      );
    } catch (recordError) {
      log.warn("linkedin profile sync failure state could not be recorded", {
        participantId: participant.participantId,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
    log.warn("linkedin participant profile sync failed", {
      participantId: participant.participantId,
      failureCount,
      retryAt: retryAt.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }

  private retryDelayMs(failureCount: number): number {
    const exponent = Math.min(Math.max(0, failureCount - 1), 30);
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
  }
}
