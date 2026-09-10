/**
 * Contract between the LinkedIn inbox poller (the producer of opencli sync
 * rows) and whatever persists them. The poller translates `opencli linkedin
 * inbox` / `thread-snapshot` JSON into these plain DTOs and hands them to a
 * `LinkedInSyncSink`; `LinkedInStoreRepository` is the production sink, and
 * tests pass a fake. Keeping the contract here (not in the db layer) lets the
 * poller stay free of any database dependency and makes its unit tests trivial.
 */

export interface LinkedInThreadInput {
  /** LinkedIn thread id — the opaque id inside the messaging thread URL. */
  threadId: string;
  threadUrl: string;
  /** Counterparty display name as the inbox listing reports it. */
  personName?: string | null;
  lastMessagePreview?: string | null;
  /** Timestamp of the thread's latest message per the inbox listing. */
  lastMessageAt?: Date | null;
  unread: boolean;
  /** `member` | `organization` | … as the inbox listing reports it. */
  counterpartyType?: string | null;
  /** LinkedIn inbox categories, e.g. `INBOX,PRIMARY_INBOX`. */
  category?: string | null;
}

export interface LinkedInMessageInput {
  /** LinkedIn message id. Unique within a thread. */
  messageId: string;
  threadId: string;
  sentAt?: Date | null;
  senderName?: string | null;
  senderProfileUrl?: string | null;
  senderHeadline?: string | null;
  /** `member` | `organization` | `agent` | `custom`. */
  senderType?: string | null;
  senderIsSelf: boolean;
  text?: string | null;
  subject?: string | null;
  reactionCount?: number | null;
}

// The obfuscated member id inside a mirrored profile URL —
// `https://www.linkedin.com/in/ACoAA…/`. A vanity handle (`/in/ada-lovelace`)
// deliberately does not match: it is a public alias, not the member id these
// tables key on, and storing one would break the correspondence with
// `channel_mappings.channel_user_id`.
const MEMBER_ID_IN_PROFILE_URL = /\/in\/(ACoAA[A-Za-z0-9_-]+)/;

/** The bare LinkedIn member id inside a stored profile URL, or null. */
export function linkedInMemberIdFromProfileUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return MEMBER_ID_IN_PROFILE_URL.exec(url)?.[1] ?? null;
}

/** One account in a thread's participant list, per the thread snapshot. */
export interface LinkedInParticipantInput {
  /**
   * LinkedIn member id, bare (`ACoAA…`) — not a urn or a profile URL — so it
   * lines up with `channel_mappings.channel_user_id` for `channel: "linkedin"`.
   */
  participantId: string;
  name?: string | null;
  headline?: string | null;
  /** `member` | `organization` | `agent` | `custom`. */
  type?: string | null;
  /**
   * True for the account owner's own entry in the participant list. Required,
   * unlike the fields around it: the store takes the newest answer verbatim
   * rather than coalescing it, so an omitted value would silently clear a
   * stored `true` rather than leave it alone. A participant list always marks
   * its own viewer, so the producer can always answer.
   */
  isSelf: boolean;
}

/** One participant of a thread, person-level facts folded in. */
export interface LinkedInParticipantRow {
  participantId: string;
  name: string | null;
  headline: string | null;
  type: string | null;
  isSelf: boolean;
}

/** The per-thread sync watermark the poller compares inbox listings against. */
export interface LinkedInThreadCursor {
  threadId: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastSyncedAt: Date | null;
}

/** One mirrored message joined with its thread, for the history talk feature. */
export interface LinkedInHistoryMessage {
  messageId: string;
  threadId: string;
  threadName: string | null;
  /** sent_at when LinkedIn reported one, else the mirror's first-seen time. */
  sentAt: Date;
  senderName: string | null;
  senderProfileUrl: string | null;
  senderIsSelf: boolean;
  text: string | null;
  subject: string | null;
}

export interface LinkedInReplyTarget {
  threadId: string;
  threadUrl: string;
  participantId: string;
  selfParticipantId: string;
}

export interface LinkedInSyncSink {
  /** Returns one verified direct thread, or null for absent or ambiguous membership. */
  findReplyTarget?(
    by: { participantId: string } | { threadId: string },
  ): Promise<LinkedInReplyTarget | null>;
  upsertThreads(threads: LinkedInThreadInput[]): Promise<void>;
  upsertMessages(messages: LinkedInMessageInput[]): Promise<void>;
  /** Watermarks for the given threads (absent threads are omitted). */
  getThreadCursors(threadIds: string[]): Promise<Map<string, LinkedInThreadCursor>>;
  /** Record a completed thread snapshot (advances `lastSyncedAt`). Metadata
   *  fields update only when known — null means "the snapshot did not say",
   *  never "unset what an earlier snapshot learned".
   *
   *  The snapshot's participant count is deliberately absent: how many people
   *  are on a thread follows from the membership `upsertThreadParticipants`
   *  stores, and a scalar copied off the snapshot could only disagree with it. */
  markThreadSynced(
    threadId: string,
    opts: {
      /** The raw conversation title (groups); null for 1:1/untitled/unknown. */
      conversationTitle?: string | null;
      /** LinkedIn's authoritative group flag; null when the snapshot predates it. */
      isGroup?: boolean | null;
    },
  ): Promise<void>;
  /** Mirrored history, newest last; `threadId: null` spans every thread. */
  fetchHistory?(threadId: string | null, since: Date): Promise<LinkedInHistoryMessage[]>;
  /**
   * Replace a thread's membership with exactly `participants` (an empty array
   * empties the thread) and record that the membership was read just now.
   *
   * Optional, and the poller treats it as a capability probe: a sink that
   * cannot store membership is never made to pay for the crawl that produces
   * it.
   */
  upsertThreadParticipants?(
    threadId: string,
    participants: LinkedInParticipantInput[],
  ): Promise<void>;
  /**
   * Seed participants from messages the sink already holds — no opencli call.
   * The poller runs this once per start, before it crawls anything.
   */
  backfillParticipantsFromMessages?(): Promise<unknown>;
}
