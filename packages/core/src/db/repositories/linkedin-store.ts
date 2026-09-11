import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  linkedinMessages,
  linkedinParticipants,
  linkedinThreadParticipants,
  linkedinThreads,
} from "../schema.js";
import type { DrizzleDb } from "../index.js";
import { linkedInMemberIdFromProfileUrl } from "../../channels/linkedin-sync.js";
import type {
  LinkedInHistoryMessage,
  LinkedInMessageInput,
  LinkedInParticipantInput,
  LinkedInParticipantProfileSyncState,
  LinkedInParticipantRow,
  LinkedInReplyTarget,
  LinkedInSyncSink,
  LinkedInThreadCursor,
  LinkedInThreadInput,
  LinkedInThreadParticipantInput,
} from "../../channels/linkedin-sync.js";

// The member-id form lives with the poller/store contract, not here: it is the
// address both sides of the mirror agree on. Re-exported so callers reading
// participant rows reach it from the same module those rows come from.
export { linkedInMemberIdFromProfileUrl };

const UPSERT_CHUNK = 200;
const HISTORY_READ_LIMIT = 1000;
const PARTICIPANTS_READ_LIMIT = 10000;

/**
 * One mirrored LinkedIn account, annotated with whether it has been promoted
 * to a curated `persons` entry. `isSelf` rides along rather than being filtered
 * out here: which accounts a caller offers for promotion is its own policy,
 * and the guardian's own row is still a real member of the threads it appears
 * in.
 */
export interface LinkedInParticipantContactRow {
  /** Bare LinkedIn member id — the `channelUserId` promotion writes. */
  participantId: string;
  name: string | null;
  headline: string | null;
  type: string | null;
  isSelf: boolean;
  /** How many mirrored threads this account belongs to. */
  threadCount: number;
  /** The person this account was promoted into, or null when unpromoted. */
  linkedPersonId: string | null;
  linkedPersonName: string | null;
  /**
   * Unix seconds of the newest message on this account's direct threads, or
   * null when the mirror holds none. See {@link DIRECT_THREADS} for why a group
   * thread contributes nothing.
   */
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  /** Mirrored messages on this account's direct threads, both directions. */
  messageCount: number;
}

/** One thread's membership paired with the age of the read that produced it. */
export interface LinkedInThreadParticipantSet {
  participants: LinkedInParticipantRow[];
  /** When the membership was last read from LinkedIn; null when never. */
  lastReadAt: Date | null;
}

/** What one backfill pass touched. */
export interface LinkedInParticipantBackfillResult {
  /** Threads seeded — threads already read authoritatively are skipped. */
  threads: number;
  /** Distinct accounts the seed proved. */
  participants: number;
}

/**
 * Every (thread, counterparty) pair where that counterparty is the only one on
 * the thread — the LinkedIn analog of a WhatsApp 1:1 chat.
 *
 * A thread is what carries messages, and only a direct thread's messages are
 * unambiguously *this* person's history: a timeline entry names no sender, so
 * folding a ten-person thread into one member's dossier would put nine other
 * people's words in their mouth. The People page already holds group chats out
 * of the People surface for the same reason — a group cannot hold a bond.
 *
 * Membership decides it, not LinkedIn's `is_group` flag alone: that flag is
 * null until a thread snapshot reports one, and a thread seeded from stored
 * messages has membership but no snapshot. The flag still gets a veto, so a
 * thread LinkedIn calls a group is never direct however little of its
 * membership has been mirrored.
 *
 * The account owner is not a counterparty: their own row is on every thread
 * they are in, and treating it as one would make every 1:1 thread look like a
 * pair.
 */
const DIRECT_THREADS = sql`
  direct_threads AS (
    SELECT tp.thread_id AS threadId, tp.participant_id AS participantId
    FROM linkedin_thread_participants tp
    LEFT JOIN linkedin_threads t ON t.thread_id = tp.thread_id
    LEFT JOIN linkedin_participants p ON p.participant_id = tp.participant_id
    WHERE coalesce(p.is_self, 0) = 0
      AND coalesce(t.is_group, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM linkedin_thread_participants other
        LEFT JOIN linkedin_participants op ON op.participant_id = other.participant_id
        WHERE other.thread_id = tp.thread_id
          AND other.participant_id <> tp.participant_id
          AND coalesce(op.is_self, 0) = 0
      )
  )
`;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Durable store for the LinkedIn inbox mirror (threads + recent message
 * history). Writes are fed by the inbox poller as a {@link LinkedInSyncSink};
 * reads serve the poller's watermarks, the address book's fold over mirrored
 * accounts, and the history talk feature.
 *
 * Reply targets require complete membership and an explicit direct-conversation verdict.
 */
export class LinkedInStoreRepository implements LinkedInSyncSink {
  constructor(private db: DrizzleDb) {}

  async findReplyTarget(
    by: { participantId: string } | { threadId: string },
  ): Promise<LinkedInReplyTarget | null> {
    const scope =
      "participantId" in by
        ? sql`p.participant_id = ${by.participantId}`
        : sql`t.thread_id = ${by.threadId}`;
    const rows = await this.db.all<LinkedInReplyTarget>(sql`
      SELECT t.thread_id AS threadId, t.thread_url AS threadUrl,
        p.participant_id AS participantId, owner.participant_id AS selfParticipantId
      FROM linkedin_threads t
      JOIN linkedin_thread_participants tp ON tp.thread_id = t.thread_id
      JOIN linkedin_participants p ON p.participant_id = tp.participant_id AND p.is_self = 0
      JOIN linkedin_thread_participants self ON self.thread_id = t.thread_id
      JOIN linkedin_participants owner ON owner.participant_id = self.participant_id AND owner.is_self = 1
      WHERE ${scope} AND t.is_group = 0 AND t.participants_last_read_at IS NOT NULL
        AND p.type = 'member' AND owner.type = 'member'
        AND (SELECT count(*) FROM linkedin_thread_participants members WHERE members.thread_id = t.thread_id) = 2
      LIMIT 2`);
    return rows.length === 1 ? rows[0]! : null;
  }

  async upsertThreads(threads: LinkedInThreadInput[]): Promise<void> {
    if (threads.length === 0) return;
    const now = new Date();
    for (const chunk of chunked(threads, UPSERT_CHUNK)) {
      await this.db
        .insert(linkedinThreads)
        .values(
          chunk.map((t) => ({
            threadId: t.threadId,
            threadUrl: t.threadUrl,
            personName: t.personName ?? null,
            lastMessagePreview: t.lastMessagePreview ?? null,
            lastMessageAt: t.lastMessageAt ?? null,
            unread: t.unread,
            counterpartyType: t.counterpartyType ?? null,
            category: t.category ?? null,
            firstSyncedAt: now,
            updatedAt: now,
          })),
        )
        // coalesce(excluded, existing) so a listing row that dropped a field
        // (LinkedIn omits previews for some thread types) never wipes one we
        // already learned. `unread` is a point-in-time flag and always wins.
        .onConflictDoUpdate({
          target: linkedinThreads.threadId,
          set: {
            threadUrl: sql`excluded.thread_url`,
            personName: sql`coalesce(excluded.person_name, person_name)`,
            lastMessagePreview: sql`coalesce(excluded.last_message_preview, last_message_preview)`,
            lastMessageAt: sql`coalesce(excluded.last_message_at, last_message_at)`,
            unread: sql`excluded.unread`,
            counterpartyType: sql`coalesce(excluded.counterparty_type, counterparty_type)`,
            category: sql`coalesce(excluded.category, category)`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }

  async upsertMessages(messages: LinkedInMessageInput[]): Promise<void> {
    if (messages.length === 0) return;
    const now = new Date();
    for (const chunk of chunked(messages, UPSERT_CHUNK)) {
      // Unlike WhatsApp's immutable frames, LinkedIn messages can be edited
      // and reactions accrue after delivery, so a re-snapshot refreshes the
      // mutable fields in place. The naming fields keep their first-seen value.
      await this.db
        .insert(linkedinMessages)
        .values(
          chunk.map((m) => ({
            messageId: m.messageId,
            threadId: m.threadId,
            sentAt: m.sentAt ?? null,
            senderName: m.senderName ?? null,
            senderProfileUrl: m.senderProfileUrl ?? null,
            senderHeadline: m.senderHeadline ?? null,
            senderType: m.senderType ?? null,
            senderIsSelf: m.senderIsSelf,
            text: m.text ?? null,
            subject: m.subject ?? null,
            reactionCount: m.reactionCount ?? null,
            createdAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [linkedinMessages.threadId, linkedinMessages.messageId],
          set: {
            text: sql`coalesce(excluded.text, text)`,
            reactionCount: sql`coalesce(excluded.reaction_count, reaction_count)`,
            sentAt: sql`coalesce(excluded.sent_at, sent_at)`,
          },
        });
    }
  }

  async getThreadCursors(threadIds: string[]): Promise<Map<string, LinkedInThreadCursor>> {
    if (threadIds.length === 0) return new Map();
    const cursors = new Map<string, LinkedInThreadCursor>();
    for (const chunk of chunked(threadIds, UPSERT_CHUNK)) {
      const rows = await this.db
        .select({
          threadId: linkedinThreads.threadId,
          lastMessageAt: linkedinThreads.lastMessageAt,
          lastMessagePreview: linkedinThreads.lastMessagePreview,
          lastSyncedAt: linkedinThreads.lastSyncedAt,
          participantsLastReadAt: linkedinThreads.participantsLastReadAt,
        })
        .from(linkedinThreads)
        .where(inArray(linkedinThreads.threadId, chunk));
      for (const row of rows) cursors.set(row.threadId, row);
    }
    return cursors;
  }

  async markThreadSynced(
    threadId: string,
    opts: {
      conversationTitle?: string | null;
      isGroup?: boolean | null;
    },
  ): Promise<void> {
    const now = new Date();
    // Null metadata means "the snapshot did not say" (an older plugin, an
    // untitled thread), so it never clears what an earlier snapshot learned.
    //
    // A snapshot's participant count is deliberately not stored: the count a
    // reader sees is derived from `linkedin_thread_participants`, and taking a
    // second, unverifiable copy from here is exactly what let the two disagree.
    await this.db
      .update(linkedinThreads)
      .set({
        lastSyncedAt: now,
        updatedAt: now,
        ...(opts.conversationTitle ? { conversationName: opts.conversationTitle } : {}),
        ...(opts.isGroup != null ? { isGroup: opts.isGroup } : {}),
      })
      .where(sql`${linkedinThreads.threadId} = ${threadId}`);
  }

  /**
   * Replace a thread's participant set with exactly `participants`: accounts
   * are upserted into `linkedin_participants`, membership rows are added for
   * everyone in the set, and members no longer in it are dropped. An empty
   * array therefore empties the thread — callers must not pass one for a
   * snapshot that merely failed to report a participant list.
   *
   * The whole replace runs in one transaction, so the set flips as a unit. A
   * failure part-way through would otherwise leave the thread over-inclusive:
   * the new members added, the departed ones never deleted.
   *
   * Account rows outlive membership: a person dropped from one thread keeps
   * their row for the other threads they are in.
   *
   * The same transaction stamps the thread's `participants_last_read_at`. Every
   * call here IS an authoritative read of the membership, and recording it
   * atomically with the set makes it impossible to claim a read that did not
   * land — or to land a set that then looks like it was never read.
   */
  async upsertThreadParticipants(
    threadId: string,
    participants: LinkedInParticipantInput[],
  ): Promise<void> {
    await this.replaceThreadParticipants(threadId, participants, true);
  }

  /**
   * Replace thread membership without treating the attached profile fields as
   * freshly synchronized. The poller uses this path because relationship and
   * profile freshness have separate clocks even though LinkedIn returns both
   * in one conversation response.
   */
  async replaceThreadParticipantMembership(
    threadId: string,
    participants: LinkedInThreadParticipantInput[],
  ): Promise<void> {
    await this.replaceThreadParticipants(threadId, participants, false);
  }

  private async replaceThreadParticipants(
    threadId: string,
    participants: LinkedInThreadParticipantInput[],
    refreshProfiles: boolean,
  ): Promise<void> {
    const now = new Date();
    const unique = new Map(participants.map((p) => [p.participantId, p]));
    const ids = [...unique.keys()];

    await this.db.transaction((tx) => {
      for (const chunk of chunked([...unique.values()], UPSERT_CHUNK)) {
        if (refreshProfiles) {
          const profiles = chunk as LinkedInParticipantInput[];
          tx.insert(linkedinParticipants)
            .values(
              profiles.map((participant) => ({
                participantId: participant.participantId,
                name: participant.name ?? null,
                headline: participant.headline ?? null,
                profileUrl: participant.profileUrl ?? null,
                type: participant.type ?? null,
                isSelf: participant.isSelf,
                lastSuccessfulSyncAt: now,
                profileSyncFailureCount: 0,
                profileSyncRetryAt: null,
                firstSyncedAt: now,
                updatedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: linkedinParticipants.participantId,
              set: {
                name: sql`coalesce(excluded.name, name)`,
                headline: sql`coalesce(excluded.headline, headline)`,
                profileUrl: sql`coalesce(excluded.profile_url, profile_url)`,
                type: sql`coalesce(excluded.type, type)`,
                isSelf: sql`excluded.is_self`,
                lastSuccessfulSyncAt: sql`excluded.last_successful_sync_at`,
                profileSyncFailureCount: 0,
                profileSyncRetryAt: null,
                updatedAt: sql`excluded.updated_at`,
              },
            })
            .run();
        } else {
          tx.insert(linkedinParticipants)
            .values(
              chunk.map((participant) => ({
                participantId: participant.participantId,
                isSelf: participant.isSelf,
                firstSyncedAt: now,
                updatedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: linkedinParticipants.participantId,
              set: {
                isSelf: sql`excluded.is_self`,
                updatedAt: sql`excluded.updated_at`,
              },
            })
            .run();
        }

        tx.insert(linkedinThreadParticipants)
          .values(
            chunk.map((participant) => ({
              threadId,
              participantId: participant.participantId,
              firstSyncedAt: now,
            })),
          )
          .onConflictDoNothing()
          .run();
      }

      tx.delete(linkedinThreadParticipants)
        .where(
          ids.length === 0
            ? eq(linkedinThreadParticipants.threadId, threadId)
            : and(
                eq(linkedinThreadParticipants.threadId, threadId),
                notInArray(linkedinThreadParticipants.participantId, ids),
              ),
        )
        .run();

      tx.update(linkedinThreads)
        .set({ participantsLastReadAt: now, updatedAt: now })
        .where(eq(linkedinThreads.threadId, threadId))
        .run();
    });
  }

  async getParticipantProfileSyncStates(
    participantIds: string[],
  ): Promise<Map<string, LinkedInParticipantProfileSyncState>> {
    const states = new Map<string, LinkedInParticipantProfileSyncState>();
    for (const chunk of chunked([...new Set(participantIds)], UPSERT_CHUNK)) {
      const rows = await this.db
        .select({
          participantId: linkedinParticipants.participantId,
          lastSuccessfulSyncAt: linkedinParticipants.lastSuccessfulSyncAt,
          profileSyncFailureCount: linkedinParticipants.profileSyncFailureCount,
          profileSyncRetryAt: linkedinParticipants.profileSyncRetryAt,
        })
        .from(linkedinParticipants)
        .where(inArray(linkedinParticipants.participantId, chunk));
      for (const row of rows) states.set(row.participantId, row);
    }
    return states;
  }

  /** A successful profile write advances freshness and clears its backoff. */
  async upsertParticipantProfile(participant: LinkedInParticipantInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(linkedinParticipants)
      .values({
        participantId: participant.participantId,
        name: participant.name ?? null,
        headline: participant.headline ?? null,
        profileUrl: participant.profileUrl ?? null,
        type: participant.type ?? null,
        isSelf: participant.isSelf,
        lastSuccessfulSyncAt: now,
        profileSyncFailureCount: 0,
        profileSyncRetryAt: null,
        firstSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: linkedinParticipants.participantId,
        set: {
          name: sql`coalesce(excluded.name, name)`,
          headline: sql`coalesce(excluded.headline, headline)`,
          profileUrl: sql`coalesce(excluded.profile_url, profile_url)`,
          type: sql`coalesce(excluded.type, type)`,
          isSelf: sql`excluded.is_self`,
          lastSuccessfulSyncAt: sql`excluded.last_successful_sync_at`,
          profileSyncFailureCount: 0,
          profileSyncRetryAt: null,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  /** A failed profile write preserves the previous success timestamp. */
  async recordParticipantProfileSyncFailure(
    participant: LinkedInThreadParticipantInput,
    failureCount: number,
    retryAt: Date,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(linkedinParticipants)
      .values({
        participantId: participant.participantId,
        isSelf: participant.isSelf,
        profileSyncFailureCount: failureCount,
        profileSyncRetryAt: retryAt,
        firstSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: linkedinParticipants.participantId,
        set: {
          isSelf: sql`excluded.is_self`,
          profileSyncFailureCount: failureCount,
          profileSyncRetryAt: retryAt,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  /**
   * One thread's membership together with when it was read. Prefer this over
   * {@link getThreadParticipants} wherever the answer's authority matters: a
   * null `lastReadAt` means nothing has ever read this thread's membership, so
   * the rows are at best a seed inferred from stored messages.
   */
  async getThreadParticipantSet(threadId: string): Promise<LinkedInThreadParticipantSet> {
    const [participants, rows] = await Promise.all([
      this.getThreadParticipants(threadId),
      this.db
        .select({ participantsLastReadAt: linkedinThreads.participantsLastReadAt })
        .from(linkedinThreads)
        .where(eq(linkedinThreads.threadId, threadId))
        .limit(1),
    ]);
    return { participants, lastReadAt: rows[0]?.participantsLastReadAt ?? null };
  }

  /**
   * Seed the participant tables from messages already mirrored. Every sender
   * the mirror recorded carries their member id inside
   * `linkedin_messages.sender_profile_url`, so an inbox that has been polled
   * for a while already knows most of its participants without a new crawl.
   *
   * Two properties keep the seed honest:
   *   - it is additive (insert-or-ignore, never a delete), because senders
   *     prove presence but their absence proves nothing; and
   *   - it never stamps `participants_last_read_at`, and skips any thread that
   *     already carries one. A real read is authoritative and must not be
   *     re-polluted by a member who has since left but whose messages remain.
   */
  async backfillParticipantsFromMessages(): Promise<LinkedInParticipantBackfillResult> {
    const now = new Date();
    // Newest message last, so a later message's facts win for a given sender.
    const rows = (await this.db.all(sql`
      SELECT
        m.thread_id AS threadId,
        m.sender_profile_url AS senderProfileUrl,
        m.sender_name AS senderName,
        m.sender_headline AS senderHeadline,
        m.sender_type AS senderType,
        m.sender_is_self AS senderIsSelf
      FROM linkedin_messages m
      JOIN linkedin_threads t ON t.thread_id = m.thread_id
      WHERE t.participants_last_read_at IS NULL
        AND m.sender_profile_url IS NOT NULL
      ORDER BY coalesce(m.sent_at, m.created_at) ASC, m.rowid ASC
    `)) as Array<Record<string, unknown>>;

    const accounts = new Map<string, LinkedInParticipantInput>();
    const memberships = new Map<string, { threadId: string; participantId: string }>();
    for (const row of rows) {
      const participantId = linkedInMemberIdFromProfileUrl(row.senderProfileUrl as string | null);
      if (!participantId) continue;
      const threadId = String(row.threadId);
      accounts.set(participantId, {
        participantId,
        name: (row.senderName as string | null) ?? null,
        headline: (row.senderHeadline as string | null) ?? null,
        profileUrl: (row.senderProfileUrl as string | null) ?? null,
        type: (row.senderType as string | null) ?? null,
        isSelf: Boolean(row.senderIsSelf),
      });
      memberships.set(`${threadId}\u0000${participantId}`, { threadId, participantId });
    }
    if (memberships.size === 0) return { threads: 0, participants: 0 };

    await this.db.transaction((tx) => {
      for (const chunk of chunked([...accounts.values()], UPSERT_CHUNK)) {
        tx.insert(linkedinParticipants)
          .values(
            chunk.map((p) => ({
              participantId: p.participantId,
              name: p.name ?? null,
              headline: p.headline ?? null,
              profileUrl: p.profileUrl ?? null,
              type: p.type ?? null,
              isSelf: p.isSelf,
              firstSyncedAt: now,
              updatedAt: now,
            })),
          )
          // A sender row is weaker evidence than a participant read, so it only
          // fills gaps: an existing fact — including `is_self`, which a real
          // read answers for the viewer — is left exactly as it was.
          .onConflictDoNothing()
          .run();
      }

      for (const chunk of chunked([...memberships.values()], UPSERT_CHUNK)) {
        tx.insert(linkedinThreadParticipants)
          .values(chunk.map((m) => ({ ...m, firstSyncedAt: now })))
          .onConflictDoNothing()
          .run();
      }
    });

    return {
      threads: new Set([...memberships.values()].map((m) => m.threadId)).size,
      participants: accounts.size,
    };
  }

  /**
   * Every stored LinkedIn account, each row saying whether it has already been
   * promoted to a person and what its direct threads last carried. The join is
   * on the member id itself — no translation step — because
   * `linkedin_participants.participant_id` and a `linkedin`
   * `channel_mappings.channel_user_id` are the same identifier by construction.
   *
   * Promotion is a guardian action against these rows, not something this
   * repository performs: a LinkedIn inbox holds many accounts that should
   * never enter the curated person graph, so nothing here writes `persons`.
   *
   * `limit` defaults to a generous cap that suits a single-payload endpoint.
   * Pass `null` to read the table whole, which is what a caller that paginates
   * the result itself wants.
   */
  async listParticipants(
    opts: { limit?: number | null } = {},
  ): Promise<LinkedInParticipantContactRow[]> {
    const limitClause =
      opts.limit === null ? sql`` : sql`LIMIT ${opts.limit ?? PARTICIPANTS_READ_LIMIT}`;
    const rows = (await this.db.all(sql`
      WITH ${DIRECT_THREADS}
      SELECT
        p.participant_id AS participantId,
        p.name AS name,
        p.headline AS headline,
        p.type AS type,
        p.is_self AS isSelf,
        (SELECT COUNT(*) FROM linkedin_thread_participants tp
           WHERE tp.participant_id = p.participant_id) AS threadCount,
        cm.person_id AS linkedPersonId,
        person.display_name AS linkedPersonName,
        (SELECT MAX(coalesce(m.sent_at, m.created_at))
           FROM linkedin_messages m
           JOIN direct_threads d ON d.threadId = m.thread_id
           WHERE d.participantId = p.participant_id) AS lastMessageAt,
        (SELECT coalesce(nullif(m.text, ''), m.subject)
           FROM linkedin_messages m
           JOIN direct_threads d ON d.threadId = m.thread_id
           WHERE d.participantId = p.participant_id
           ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.rowid DESC
           LIMIT 1) AS lastMessagePreview,
        (SELECT COUNT(*)
           FROM linkedin_messages m
           JOIN direct_threads d ON d.threadId = m.thread_id
           WHERE d.participantId = p.participant_id) AS messageCount
      FROM linkedin_participants p
      LEFT JOIN channel_mappings cm
        ON cm.channel = 'linkedin' AND cm.channel_user_id = p.participant_id
      LEFT JOIN persons person ON person.id = cm.person_id
      ORDER BY lower(coalesce(p.name, p.participant_id)) ASC, p.participant_id ASC
      ${limitClause}
    `)) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      participantId: String(r.participantId),
      name: (r.name as string | null) ?? null,
      headline: (r.headline as string | null) ?? null,
      type: (r.type as string | null) ?? null,
      isSelf: Boolean(r.isSelf),
      threadCount: Number(r.threadCount ?? 0),
      linkedPersonId: (r.linkedPersonId as string | null) ?? null,
      linkedPersonName: (r.linkedPersonName as string | null) ?? null,
      lastMessageAt: r.lastMessageAt == null ? null : Number(r.lastMessageAt),
      lastMessagePreview: (r.lastMessagePreview as string | null) ?? null,
      messageCount: Number(r.messageCount ?? 0),
    }));
  }

  /** One thread's participants with their person-level facts, by member id. */
  async getThreadParticipants(threadId: string): Promise<LinkedInParticipantRow[]> {
    const rows = (await this.db.all(sql`
      SELECT
        tp.participant_id AS participantId,
        p.name AS name,
        p.headline AS headline,
        p.type AS type,
        p.is_self AS isSelf
      FROM linkedin_thread_participants tp
      LEFT JOIN linkedin_participants p ON p.participant_id = tp.participant_id
      WHERE tp.thread_id = ${threadId}
      ORDER BY tp.participant_id ASC
    `)) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      participantId: String(r.participantId),
      name: (r.name as string | null) ?? null,
      headline: (r.headline as string | null) ?? null,
      type: (r.type as string | null) ?? null,
      isSelf: Boolean(r.isSelf),
    }));
  }

  /** The reverse lookup: every thread a participant belongs to. */
  async getParticipantThreadIds(participantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ threadId: linkedinThreadParticipants.threadId })
      .from(linkedinThreadParticipants)
      .where(eq(linkedinThreadParticipants.participantId, participantId))
      .orderBy(linkedinThreadParticipants.threadId);
    return rows.map((r) => r.threadId);
  }

  /**
   * Recent mirrored messages for the history talk feature: a bounded
   * chronological slice (newest `HISTORY_READ_LIMIT` kept, returned oldest
   * first). `threadId: null` spans every thread. Rows without a LinkedIn
   * delivery time order (and filter) by the mirror's first-seen time.
   */
  async fetchHistory(threadId: string | null, since: Date): Promise<LinkedInHistoryMessage[]> {
    const sinceSeconds = Math.floor(since.getTime() / 1000);
    const threadClause = threadId != null ? sql`AND m.thread_id = ${threadId}` : sql``;
    const rows = (await this.db.all(sql`
      SELECT
        m.message_id AS messageId,
        m.thread_id AS threadId,
        coalesce(t.conversation_name, t.person_name) AS threadName,
        coalesce(m.sent_at, m.created_at) AS sentAt,
        m.sender_name AS senderName,
        m.sender_profile_url AS senderProfileUrl,
        m.sender_is_self AS senderIsSelf,
        m.text AS text,
        m.subject AS subject
      FROM linkedin_messages m
      LEFT JOIN linkedin_threads t ON t.thread_id = m.thread_id
      WHERE coalesce(m.sent_at, m.created_at) >= ${sinceSeconds} ${threadClause}
      ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.rowid DESC
      LIMIT ${HISTORY_READ_LIMIT}
    `)) as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        messageId: String(r.messageId),
        threadId: String(r.threadId),
        threadName: (r.threadName as string | null) ?? null,
        sentAt: new Date(Number(r.sentAt) * 1000),
        senderName: (r.senderName as string | null) ?? null,
        senderProfileUrl: (r.senderProfileUrl as string | null) ?? null,
        senderIsSelf: Boolean(r.senderIsSelf),
        text: (r.text as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
      }))
      .reverse();
  }
}
