// LinkedIn inbox poller. Channel contract: docs/architecture/channels.md.
//
// LinkedIn has no push surface Rome can subscribe to: the session lives in the
// server-side Chrome profile and opencli reads the messaging UI through it. So
// ingestion is a poll — each tick lists the inbox, diffs the listing against
// the mirror's per-thread watermarks, and snapshots only the threads whose
// latest message moved. The cadence is deliberately jittered (a fresh uniform
// delay in [min, max] every tick, not a fixed interval) so the traffic pattern
// does not look like a metronome to LinkedIn.
//
// Fault taxonomy (mirrors the whatsapp/telegram-user split):
//   - an auth wall / signed-out session → `onAuthRejected` (the Talker maps it
//     to CredentialRejected{ grant: "session" } → renew-probe → degrade);
//   - anything else (CDP down, timeout, shape drift) is transient: it never
//     touches grant state. After two consecutive failed ticks the poller
//     reports a runtime degradation so the dashboard shows amber "Degraded"
//     with the reason, and the next successful tick clears it.

import { createLogger } from "../logger.js";
import {
  OpencliAuthError,
  parseInbox,
  parseThreadParticipants,
  parseThreadSnapshot,
  type LinkedInInboxRow,
  type RunOpencli,
} from "./linkedin-cli.js";
import {
  LinkedInParticipantProfileSynchronizer,
  type LinkedInParticipantProfileSynchronizerOptions,
} from "./linkedin-profile-sync.js";
import {
  linkedInMemberIdFromProfileUrl,
  type LinkedInParticipantInput,
  type LinkedInSyncSink,
  type LinkedInThreadCursor,
} from "./linkedin-sync.js";

const log = createLogger("linkedin");

const DEFAULT_INBOX_LIMIT = 40;
const DEFAULT_THREAD_FETCH_LIMIT = 25;
const DEFAULT_MAX_SNAPSHOTS_PER_TICK = 6;
const DEFAULT_MEMBERSHIP_REFRESH_INTERVAL_MS = 60 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 240_000;
/** One failed tick is routine (a Chrome restart, a slow page); the guardian is
 *  warned once failures look persistent. */
const DEGRADE_AFTER_CONSECUTIVE_FAILURES = 2;

export interface LinkedInPollerCallbacks {
  /** The session behind the browser is signed out; the epoch owner decides
   *  what that means for the grant. */
  onAuthRejected(cause: OpencliAuthError): void;
}

export interface LinkedInPollerOptions {
  sink: LinkedInSyncSink;
  run: RunOpencli;
  /** Every tick draws a fresh uniform delay in [min, max]. */
  minIntervalMs: number;
  maxIntervalMs: number;
  inboxLimit?: number;
  threadFetchLimit?: number;
  maxSnapshotsPerTick?: number;
  /** Minimum age of an authoritative membership read before refreshing it. */
  membershipRefreshIntervalMs?: number;
  /** Account-scoped profile freshness and retry policy. */
  profileSync?: LinkedInParticipantProfileSynchronizerOptions;
  /** Test seam for the jitter draw. */
  random?: () => number;
}

/** A fresh uniform delay in [minMs, maxMs]. */
export function pollDelayMs(minMs: number, maxMs: number, random: () => number): number {
  return Math.round(minMs + random() * (Math.max(maxMs, minMs) - minMs));
}

/**
 * Whether a thread's inbox listing has moved past the mirror's watermark. A
 * never-snapshotted thread is always stale (first connect backfills the
 * inbox a capped batch per tick). Listing rows that carry no timestamp fall
 * back to the preview text.
 */
export function threadNeedsSnapshot(
  row: LinkedInInboxRow,
  cursor: LinkedInThreadCursor | undefined,
): boolean {
  if (!cursor || cursor.lastSyncedAt === null) return true;
  if (row.lastMessageAt) {
    if (!cursor.lastMessageAt) return true;
    return row.lastMessageAt.getTime() !== cursor.lastMessageAt.getTime();
  }
  return (row.lastMessagePreview ?? "") !== (cursor.lastMessagePreview ?? "");
}

export class LinkedInInboxPoller {
  private readonly sink: LinkedInSyncSink;
  private readonly run: RunOpencli;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly inboxLimit: number;
  private readonly threadFetchLimit: number;
  private readonly maxSnapshotsPerTick: number;
  private readonly membershipRefreshIntervalMs: number;
  private readonly profileSynchronizer: LinkedInParticipantProfileSynchronizer | null;
  private readonly random: () => number;

  private callbacks: LinkedInPollerCallbacks | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  /** Only ever true between a stop() and the next start(): it aborts the
   *  in-flight tick's snapshot loop and suppresses rescheduling. */
  private stopped = false;
  private ticking = false;
  /** The message-derived participant seed is a one-shot, not a per-tick cost. */
  private participantsSeeded = false;
  private consecutiveFailures = 0;
  private lastFailureMessage: string | null = null;
  private nextRunAt: Date | null = null;

  constructor(opts: LinkedInPollerOptions) {
    this.sink = opts.sink;
    this.run = opts.run;
    this.minIntervalMs = opts.minIntervalMs;
    this.maxIntervalMs = opts.maxIntervalMs;
    this.inboxLimit = opts.inboxLimit ?? DEFAULT_INBOX_LIMIT;
    this.threadFetchLimit = opts.threadFetchLimit ?? DEFAULT_THREAD_FETCH_LIMIT;
    this.maxSnapshotsPerTick = opts.maxSnapshotsPerTick ?? DEFAULT_MAX_SNAPSHOTS_PER_TICK;
    this.membershipRefreshIntervalMs =
      opts.membershipRefreshIntervalMs ?? DEFAULT_MEMBERSHIP_REFRESH_INTERVAL_MS;
    const getStates = opts.sink.getParticipantProfileSyncStates?.bind(opts.sink);
    const upsertProfile = opts.sink.upsertParticipantProfile?.bind(opts.sink);
    const recordFailure = opts.sink.recordParticipantProfileSyncFailure?.bind(opts.sink);
    this.profileSynchronizer =
      getStates && upsertProfile && recordFailure
        ? new LinkedInParticipantProfileSynchronizer(
            {
              getParticipantProfileSyncStates: getStates,
              upsertParticipantProfile: upsertProfile,
              recordParticipantProfileSyncFailure: recordFailure,
            },
            opts.profileSync,
          )
        : null;
    this.random = opts.random ?? Math.random;
  }

  /** First tick runs immediately (a fresh connect should mirror right away);
   *  each subsequent tick re-draws its own jittered delay. */
  start(callbacks: LinkedInPollerCallbacks): void {
    this.callbacks = callbacks;
    this.stopped = false;
    this.abort = new AbortController();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.callbacks = null;
  }

  /** Runtime health beside the unlocked capability (the WeChat pattern):
   *  non-null while polls are persistently failing without the session being
   *  signed out. */
  getRuntimeDegradation(): { reason: string; retryAt?: string } | null {
    if (this.consecutiveFailures < DEGRADE_AFTER_CONSECUTIVE_FAILURES) return null;
    return {
      reason:
        `LinkedIn sync has failed ${this.consecutiveFailures} times in a row` +
        `${this.lastFailureMessage ? ` (${this.lastFailureMessage})` : ""}. ` +
        "Rome keeps retrying automatically.",
      ...(this.nextRunAt ? { retryAt: this.nextRunAt.toISOString() } : {}),
    };
  }

  /** One poll: list the inbox, upsert the listing, snapshot stale threads.
   *  Public as the unit-test entry point; production ticks come off the timer. */
  async pollOnce(): Promise<void> {
    const signal = this.abort?.signal;
    await this.seedParticipantsOnce();
    const inboxResult = await this.run(
      ["linkedin", "inbox", "--limit", String(this.inboxLimit)],
      signal ? { signal } : {},
    );
    const rows = parseInbox(inboxResult);

    // Read the watermarks BEFORE upserting the listing — the upsert advances
    // `lastMessageAt`, which is exactly the field the diff compares.
    const cursors = await this.sink.getThreadCursors(rows.map((r) => r.threadId));
    const stale = rows
      .filter((row) => threadNeedsSnapshot(row, cursors.get(row.threadId)))
      .sort((a, b) => a.rank - b.rank);

    await this.sink.upsertThreads(
      rows.map((row) => ({
        threadId: row.threadId,
        threadUrl: row.threadUrl,
        personName: row.personName,
        lastMessagePreview: row.lastMessagePreview,
        lastMessageAt: row.lastMessageAt,
        unread: row.unread,
        counterpartyType: row.counterpartyType,
        category: row.category,
      })),
    );

    const batch = stale.slice(0, this.maxSnapshotsPerTick);
    if (stale.length > batch.length) {
      log.info("linkedin snapshot backlog capped for this tick", {
        stale: stale.length,
        synced: batch.length,
      });
    }

    for (const row of batch) {
      if (this.stopped) return;
      await this.snapshotThread(row, cursors.get(row.threadId), signal);
    }
    if (batch.length > 0) {
      log.info("linkedin threads synced", { threads: batch.length });
    }
  }

  private async snapshotThread(
    row: LinkedInInboxRow,
    cursor: LinkedInThreadCursor | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.run(
      [
        "linkedin",
        "thread-snapshot",
        "--thread-url",
        row.threadUrl,
        "--limit",
        String(this.threadFetchLimit),
      ],
      { timeoutMs: SNAPSHOT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    const messages = parseThreadSnapshot(result);
    await this.sink.upsertMessages(
      messages.map((m) => ({
        messageId: m.messageId,
        threadId: m.threadId,
        sentAt: m.sentAt,
        senderName: m.senderName,
        senderProfileUrl: m.senderProfileUrl,
        senderHeadline: m.senderHeadline,
        senderType: m.senderType,
        senderIsSelf: m.senderIsSelf,
        text: m.text,
        subject: m.subject,
        reactionCount: m.reactionCount,
      })),
    );
    // The snapshot's own participant count is not persisted: the thread's
    // membership read below is what the count is derived from, so storing the
    // snapshot's number too would just be a second answer to the same question.
    await this.sink.markThreadSynced(row.threadId, {
      conversationTitle: messages.find((m) => m.conversationTitle)?.conversationTitle ?? null,
      isGroup: messages.find((m) => m.conversationIsGroup != null)?.conversationIsGroup ?? null,
    });
    await this.syncMessageProfiles(messages);
    await this.syncThreadParticipants(row, cursor, signal);
  }

  private async syncMessageProfiles(
    messages: ReturnType<typeof parseThreadSnapshot>,
  ): Promise<void> {
    if (!this.profileSynchronizer) return;
    const profiles: LinkedInParticipantInput[] = [];
    for (const message of messages) {
      const participantId =
        message.senderParticipantId ?? linkedInMemberIdFromProfileUrl(message.senderProfileUrl);
      if (!participantId) continue;
      profiles.push({
        participantId,
        name: message.senderName,
        headline: message.senderHeadline,
        profileUrl: message.senderProfileUrl,
        type: message.senderType,
        isSelf: message.senderIsSelf,
      });
    }
    await this.profileSynchronizer.sync(profiles);
  }

  /**
   * Read the thread's membership and replace the stored set with it. Runs
   * after the snapshot rather than inside it: the snapshot's per-message rows
   * only prove senders, while this command reads the conversation's own
   * participant list and so also names members who have never posted.
   *
   * A failed read is not fatal. Membership is a cache of a pull-only mirror,
   * so the honest response to a failure is to record nothing — the thread's
   * `participants_last_read_at` simply does not advance and the previous set
   * stays visibly stale — rather than to throw away the messages this tick
   * already mirrored. A signed-out session is the exception: that is not a
   * per-thread hiccup, and the grant owner has to hear about it.
   */
  private async syncThreadParticipants(
    row: LinkedInInboxRow,
    cursor: LinkedInThreadCursor | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const replaceMembership = this.sink.replaceThreadParticipantMembership?.bind(this.sink);
    // No point paying for a crawl whose result nothing can store.
    if (!replaceMembership) return;
    // A snapshot refreshes the send-safety group verdict independently.
    // Authoritative membership has its own thread-scoped clock, so one active
    // conversation does not need a second page load for every message.
    if (
      cursor?.participantsLastReadAt &&
      Date.now() - cursor.participantsLastReadAt.getTime() < this.membershipRefreshIntervalMs
    ) {
      return;
    }

    let participants: ReturnType<typeof parseThreadParticipants>;
    try {
      const result = await this.run(
        ["linkedin", "thread-participants", "--thread-url", row.threadUrl],
        { timeoutMs: SNAPSHOT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      participants = parseThreadParticipants(result);
    } catch (err) {
      if (err instanceof OpencliAuthError) throw err;
      log.warn("linkedin participant read failed; membership left as-is", {
        threadId: row.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    await replaceMembership(
      row.threadId,
      participants.map((p) => ({
        participantId: p.participantId,
        isSelf: p.isSelf,
      })),
    );
    await this.profileSynchronizer?.sync(
      participants.map((participant) => ({
        participantId: participant.participantId,
        name: participant.name,
        headline: participant.headline,
        profileUrl: participant.profileUrl,
        type: participant.type,
        isSelf: participant.isSelf,
      })),
    );
  }

  /**
   * Seed the participant tables from messages the mirror already holds, once
   * per process. Every sender already recorded carries their member id, so an
   * inbox polled before participants existed knows most of its membership
   * without a single new page load. Best-effort: a failed seed must not cost
   * the poll that follows it.
   */
  private async seedParticipantsOnce(): Promise<void> {
    if (this.participantsSeeded) return;
    this.participantsSeeded = true;
    const backfill = this.sink.backfillParticipantsFromMessages?.bind(this.sink);
    if (!backfill) return;
    try {
      await backfill();
    } catch (err) {
      log.warn("linkedin participant backfill failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.pollOnce();
      this.consecutiveFailures = 0;
      this.lastFailureMessage = null;
    } catch (err) {
      if (this.stopped) return; // an aborted in-flight command is not a failure
      if (err instanceof OpencliAuthError) {
        // Grant state owns the user-facing warning from here; the epoch is
        // torn down by the registry, which calls stop().
        this.callbacks?.onAuthRejected(err);
      } else {
        this.consecutiveFailures++;
        this.lastFailureMessage = err instanceof Error ? err.message : String(err);
        log.warn("linkedin poll failed", {
          consecutiveFailures: this.consecutiveFailures,
          error: this.lastFailureMessage,
        });
      }
    } finally {
      this.ticking = false;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delay = pollDelayMs(this.minIntervalMs, this.maxIntervalMs, this.random);
    this.nextRunAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => void this.tick(), delay);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
