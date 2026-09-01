import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  real,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { AgentInputState } from "@rome-os/app-runtime";
import { TURN_FEEDBACK_RATINGS } from "@rome/api-types/trace-segments";
import {
  APPROVAL_EXECUTION_STATES,
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
} from "@rome/api-types/approvals";

const DEFAULT_WEBCHAT_PROJECT_NAME = "default";

// Superseded by `routines`. No code reads or writes this table; kept only
// pending a removal + drop migration. Do not add new readers/writers.
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["one-off", "recurring"] }).notNull(),
  tzid: text("tzid").notNull(),
  localTime: text("local_time").notNull(),
  rrule: text("rrule"),
  startTime: integer("start_time", { mode: "timestamp" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp" }),
  actionName: text("action_name").notNull(),
  args: text("args", { mode: "json" }).notNull(), // JSON array
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  channelThreadKey: text("channel_thread_key"),
  /** Which provider produced this conversation's thread, so a resumed session
   *  routes back to the SAME model (e.g. a Codex→Claude fallback continues on
   *  Claude instead of reverting to Codex). Null for legacy/undecided rows. */
  provider: text("provider"),
  providerThreadId: text("provider_thread_id"),
  /** The concrete model that produced the session's last successful turn,
   *  written by the same after-turn provider-info write. Null for legacy
   *  rows and sessions that never completed a turn. Nothing reads it yet. */
  model: text("model"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastActiveAt: integer("last_active_at", { mode: "timestamp" }).notNull(),
  status: text("status", {
    enum: ["active", "completed", "error"],
  }).notNull(),
});

// Provider-native history anchor for one successfully completed Rome turn.
// The checkpoint id is intentionally opaque to core persistence: Codex stores
// its app-server turn id, while Claude stores the final top-level assistant
// message UUID. Fork callers use it to branch at the selected turn instead of
// implicitly branching from the provider thread's current head.
export const sessionTurnCheckpoints = sqliteTable(
  "session_turn_checkpoints",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    provider: text("provider").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.turnId] })],
);

/** The people the guardian knows (docs/concepts/people.md#person). Table name
 *  kept: renaming it needs a migration, and every reader already holds it. */
export const persons = sqliteTable("persons", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  bondLevel: text("bond_level", {
    enum: ["guardian", "inner-circle", "acquaintance", "other"],
  }).notNull(),
  profilePath: text("profile_path"),
  approved: integer("approved", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * Which person each account belongs to — a channel mapping is a
 * [link](docs/concepts/people.md#link), and `channel_user_id` is the account's
 * own [address](docs/concepts/people.md#address).
 *
 * The table, its columns, and its index keep the older names: renaming any of
 * them needs a migration, and `channelMappings` is also the wire field
 * `@rome-os/app-runtime` publishes on `PersonRecord`.
 */
export const channelMappings = sqliteTable(
  "channel_mappings",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .references(() => persons.id)
      .notNull(),
    channel: text("channel").notNull(),
    channelUserId: text("channel_user_id").notNull(),
    displayName: text("display_name"),
  },
  (table) => [
    // One account belongs to exactly one person. Held in the database rather
    // than checked before each write: two concurrent placements of the same
    // waiting sender both read "unlinked" and both insert, and the People page
    // would then show that account under two people at once.
    uniqueIndex("idx_channel_mappings_identity").on(table.channel, table.channelUserId),
  ],
);

// A durable mirror of the WhatsApp contact list, chats, and recent message
// history, fed by Baileys' history sync (`messaging-history.set`) on connect
// and kept current by the ongoing `contacts.*` / `chats.*` / `messages.upsert`
// events. Deliberately separate from the curated `persons` graph: a WhatsApp
// account can have thousands of contacts, so they live here as a browsable
// address book and are promoted to a `persons` row only on guardian action
// (via the `POST /api/people` + `POST /api/people/:id/accounts` flow). The
// bridge key is the JID: a private contact's `jid` equals the `channelUserId`
// inbound messages map to, so a promoted contact is recognized on its next
// message with no extra wiring.
export const waContacts = sqliteTable("wa_contacts", {
  // Contact JID — `@s.whatsapp.net` (phone) or `@lid` form, as Baileys reports it.
  jid: text("jid").primaryKey(),
  phoneNumber: text("phone_number"),
  // Name saved in the guardian's WhatsApp address book.
  name: text("name"),
  // Name the contact set for themselves (push name).
  notify: text("notify"),
  verifiedName: text("verified_name"),
  imgUrl: text("img_url"),
  firstSyncedAt: integer("first_synced_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const waChats = sqliteTable("wa_chats", {
  jid: text("jid").primaryKey(),
  name: text("name"),
  isGroup: integer("is_group", { mode: "boolean" }).notNull().default(false),
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
  unreadCount: integer("unread_count"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const waMessages = sqliteTable(
  "wa_messages",
  {
    // WhatsApp message id (key.id). Unique only within a chat, hence the
    // composite primary key with chatJid.
    id: text("id").notNull(),
    chatJid: text("chat_jid").notNull(),
    // Author JID. For groups this is the participant; for private chats it is
    // the remote party (or the guardian when fromMe).
    senderJid: text("sender_jid"),
    fromMe: integer("from_me", { mode: "boolean" }).notNull().default(false),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
    // 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'reaction' | 'other'.
    type: text("type"),
    text: text("text"),
    hasMedia: integer("has_media", { mode: "boolean" }).notNull().default(false),
    pushName: text("push_name"),
    // For a reaction row, the id of the message it reacts to (`text` holds the
    // emoji). Null for every other type.
    reactsToId: text("reacts_to_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatJid, table.id] }),
    index("idx_wa_messages_chat_ts").on(table.chatJid, table.timestamp),
  ],
);

// A durable mirror of the LinkedIn messaging inbox, fed by the LinkedIn
// connection's opencli poller (`linkedin inbox` listings + per-thread
// `thread-snapshot` reads). Same shape of concern as the wa_* mirror: a
// browsable message store separate from the curated `persons` graph.
// `last_message_at`/`last_message_preview` double as the poller's sync
// watermark — a thread is re-snapshotted when its inbox listing moves past
// them; `last_synced_at` records the last completed snapshot.
export const linkedinThreads = sqliteTable("linkedin_threads", {
  // Opaque LinkedIn thread id (the id inside the messaging thread URL).
  threadId: text("thread_id").primaryKey(),
  threadUrl: text("thread_url").notNull(),
  // Counterparty display name as the inbox listing reports it.
  personName: text("person_name"),
  // The raw conversation title from the thread snapshot — groups only; null
  // for 1:1 threads. (Not the snapshot's `conversation_name` display ladder,
  // which folds counterparty names in and is useless as a group signal.)
  conversationName: text("conversation_name"),
  // LinkedIn's own group flag from the thread snapshot; null until the first
  // snapshot reports it (inbox listings carry no group information).
  isGroup: integer("is_group", { mode: "boolean" }),
  // Deliberately no participant_count column. How many people are on a thread
  // is counted from `linkedin_thread_participants` when it is read, so the
  // membership and its size are one fact and cannot drift apart. The snapshot
  // still reports a count; the mirror no longer keeps a second copy of it.
  lastMessagePreview: text("last_message_preview"),
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
  unread: integer("unread", { mode: "boolean" }).notNull().default(false),
  // 'member' | 'organization' | … as the inbox listing reports it.
  counterpartyType: text("counterparty_type"),
  // LinkedIn inbox categories, e.g. 'INBOX,PRIMARY_INBOX'.
  category: text("category"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  // When this thread's membership was last read from LinkedIn. The participant
  // tables are a cache of a pull-only mirror, so a reader has to be able to
  // tell how old the set is. Null means the membership has never been read
  // authoritatively — including a thread seeded from stored messages, where
  // senders alone cannot prove membership and a lurker is invisible.
  participantsLastReadAt: integer("participants_last_read_at", { mode: "timestamp" }),
  firstSyncedAt: integer("first_synced_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const linkedinMessages = sqliteTable(
  "linkedin_messages",
  {
    // LinkedIn message id. Unique only within a thread, hence the composite
    // primary key with threadId.
    messageId: text("message_id").notNull(),
    threadId: text("thread_id").notNull(),
    // Null when LinkedIn reported no delivery time for the message.
    sentAt: integer("sent_at", { mode: "timestamp" }),
    senderName: text("sender_name"),
    senderProfileUrl: text("sender_profile_url"),
    senderHeadline: text("sender_headline"),
    // 'member' | 'organization' | 'agent' | 'custom'.
    senderType: text("sender_type"),
    senderIsSelf: integer("sender_is_self", { mode: "boolean" }).notNull().default(false),
    text: text("text"),
    // InMail subject line, when present.
    subject: text("subject"),
    reactionCount: integer("reaction_count"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.messageId] }),
    index("idx_linkedin_messages_thread_sent").on(table.threadId, table.sentAt),
  ],
);

// One row per LinkedIn account seen in a thread's participant list. Person-level
// facts live here rather than on the membership row so a name or headline is
// stored once, not once per thread the person appears in.
export const linkedinParticipants = sqliteTable("linkedin_participants", {
  // LinkedIn member id, bare (`ACoAA…`) — no urn: prefix and no profile URL —
  // so it matches `channel_mappings.channel_user_id` for `channel = "linkedin"`
  // and a mirrored participant can be promoted into `persons` with no
  // translation step.
  participantId: text("participant_id").primaryKey(),
  name: text("name"),
  headline: text("headline"),
  // 'member' | 'organization' | 'agent' | 'custom', as the snapshot reports it.
  type: text("type"),
  // True for the account owner's own row in a thread's participant list.
  isSelf: integer("is_self", { mode: "boolean" }).notNull().default(false),
  firstSyncedAt: integer("first_synced_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Thread membership: which accounts belong to which thread. Rows carry no
// person-level facts — those live once on `linkedin_participants`.
export const linkedinThreadParticipants = sqliteTable(
  "linkedin_thread_participants",
  {
    threadId: text("thread_id").notNull(),
    participantId: text("participant_id").notNull(),
    firstSyncedAt: integer("first_synced_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.participantId] }),
    // The primary key already serves thread → participants; this index serves
    // the reverse lookup, participant → the threads they are in.
    index("idx_linkedin_thread_participants_participant").on(table.participantId),
  ],
);

export const sentinelLog = sqliteTable("sentinel_log", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  channel: text("channel").notNull(),
  channelUserId: text("channel_user_id").notNull(),
  displayName: text("display_name"),
  threadId: text("thread_id"),
  text: text("text"),
  action: text("action", {
    enum: ["replied", "ignored", "escalated"],
  }).notNull(),
  response: text("response"),
  reviewed: integer("reviewed", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  type: text("type", { enum: APPROVAL_TYPES }).notNull(),
  status: text("status", { enum: APPROVAL_STATUSES }).notNull(),
  executionState: text("execution_state", { enum: APPROVAL_EXECUTION_STATES })
    .notNull()
    .default("idle"),
  requestedBy: text("requested_by").notNull(),
  description: text("description").notNull(),
  payload: text("payload", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  resolvedBy: text("resolved_by"),
  executedAt: integer("executed_at", { mode: "timestamp" }),
  executionError: text("execution_error"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Guardian-entered named values ("App keys" in Settings → Connections) injected
// into process.env at boot so any installed app can read them. `name` is the
// env var name apps read; `label` is the guardian's human description. Values
// never leave the server through the API — the read surface returns names only.
export const appKeys = sqliteTable("app_keys", {
  name: text("name").primaryKey(),
  label: text("label").notNull(),
  value: text("value").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  scopeType: text("scope_type").notNull(),
  scopeValue: text("scope_value", { mode: "json" }).notNull(),
  rules: text("rules", { mode: "json" }).notNull(),
  priority: integer("priority").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const guardianAuth = sqliteTable("guardian_auth", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // Rome Cloud account this seat is bound to. NULL = a local-fallback
  // seat authenticated by passwordHash; set = a cloud-bound seat. The two are not
  // mutually exclusive — passwordHash stays for fallback even when accountId is set.
  accountId: text("account_id"),
  // Email of the bound cloud account, learned from the id_token at cloud login.
  // NULL for local-fallback seats and for seats bound before this column existed
  // (backfilled on their next cloud sign-in). Display/audit only — never used
  // for authentication.
  email: text("email"),
  // Rome Cloud profile picture for the bound account. Cached locally so the
  // dashboard shell can render offline without fetching Cloud on every load.
  avatarUrl: text("avatar_url"),
  onboardingComplete: integer("onboarding_complete", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const providerAccounts = sqliteTable("provider_accounts", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull().unique(),
  providerAccountId: text("provider_account_id"),
  displayName: text("display_name"),
  email: text("email"),
  login: text("login"),
  avatarUrl: text("avatar_url"),
  scopes: text("scopes", { mode: "json" }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenVersion: integer("token_version").notNull().default(1),
  tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }).notNull(),
});

export const oauthPendingAttempts = sqliteTable(
  "oauth_pending_attempts",
  {
    state: text("state").primaryKey(),
    provider: text("provider").notNull(),
    tenant: text("tenant").notNull(),
    callbackOrigin: text("callback_origin").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
  },
  (table) => [index("idx_oauth_pending_attempts_expires_at").on(table.expiresAt)],
);

export const webchatProjects = sqliteTable("webchat_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
});

// A thin, source-agnostic binding registry: which project is linked to which
// source type, plus an opaque per-source `project_link_extra` payload the owning
// source defines and interprets. The source's native store (for git, `.git` +
// the remote) is the source of truth for operational state — this table only
// records the binding + the source's small persisted bag. A future non-git
// source needs no schema change.
export const projectSyncLinks = sqliteTable("project_sync_links", {
  id: text("id").primaryKey(),
  projectPath: text("project_path").notNull().unique(),
  projectLinkType: text("project_link_type").notNull(),
  projectLinkExtra: text("project_link_extra", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const romeSessions = sqliteTable(
  "rome_sessions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    personaId: text("persona_id"),
    largeModelSelection: text("large_model_selection"),
    projectName: text("project_name").notNull().default(DEFAULT_WEBCHAT_PROJECT_NAME),
    projectPath: text("project_path"),
    // Agent the session is bound to. NULL means the default "main" agent.
    // Locked on first turn so the session can't switch agents mid-thread.
    agentName: text("agent_name"),
    // Distinguishes top-level webchat, handoff child sessions, first-class
    // subagent sessions, external channels, and action/background agent runs.
    type: text("type").notNull().default("webchat"),
    sourceChannel: text("source_channel"),
    sourceThreadId: text("source_thread_id"),
    sourceThreadName: text("source_thread_name"),
    sourceThreadType: text("source_thread_type"),
    // Versioned policy overrides for channel conversations. Agent routing is
    // intentionally not duplicated here; agentName is its canonical column.
    channelSettings: text("channel_settings", { mode: "json" }),
    triggerKind: text("trigger_kind"),
    triggerName: text("trigger_name"),
    triggerActionName: text("trigger_action_name"),
    triggerExecutionId: text("trigger_execution_id"),
    rootActionExecutionId: text("root_action_execution_id"),
    parentActionExecutionId: text("parent_action_execution_id"),
    // Parent relation for fork and subagent sessions. For a subagent,
    // parentTurnId is the Parent turn that originally created the Child
    // session; resumed Child turns carry their exact Parent turn in runtime
    // lifecycle data and the Parent tool_result.
    parentSessionId: text("parent_session_id"),
    parentTurnId: text("parent_turn_id"),
    // JSON handback contract for a 'handoff' session, set at mint time
    // (e.g. `{"schema": {...}, "validate": "workflow_validate"}`). Drives the
    // session's conversational handback tools; NULL for plain chats and
    // contract-less handoffs.
    handoffSpec: text("handoff_spec"),
    // Reversible soft-hide for top-level webchat sessions. NULL = not archived
    // (every existing/other-typed row reads as such). Additive + nullable, and
    // scoped in code to type='webchat' — no other session type sets or reads it.
    // Mirrors the `webchat_projects.archived_at` precedent above.
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    // Server-owned pin state for top-level guardian chats. The timestamp keeps
    // the state nullable and leaves room for deterministic "most recently
    // pinned" ordering without a second column.
    pinnedAt: integer("pinned_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    activityAt: integer("activity_at", { mode: "timestamp" }).notNull(),
    lastSeenActivityAt: integer("last_seen_activity_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_rome_sessions_project_path").on(table.projectPath),
    index("idx_rome_sessions_sidebar_activity").on(
      table.type,
      table.activityAt,
      table.createdAt,
      table.id,
    ),
    index("idx_rome_sessions_project_activity").on(
      table.projectPath,
      table.type,
      table.activityAt,
      table.createdAt,
      table.id,
    ),
    index("idx_rome_sessions_source_channel").on(table.sourceChannel),
    index("idx_rome_sessions_source_thread").on(table.sourceChannel, table.sourceThreadId),
    index("idx_rome_sessions_channel_address")
      .on(table.sourceChannel, table.sourceThreadId)
      .where(
        sql`${table.type} = 'channel' AND ${table.sourceChannel} IS NOT NULL AND ${table.sourceThreadId} IS NOT NULL`,
      ),
    index("idx_rome_sessions_parent_session").on(table.parentSessionId),
  ],
);

export const webchatWorkspaceLayouts = sqliteTable("webchat_workspace_layouts", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => romeSessions.id, { onDelete: "cascade" }),
  layout: text("layout").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// A public, login-free read-only snapshot of selected turns from a chat. The
// primary key IS the bearer token (an unguessable nanoid), so the link is the
// credential — anyone with it can read the snapshot until it's revoked. The
// snapshot is frozen at share time (chat content never updates), but app widgets
// it references render live (their public access is governed separately by
// `publicAccess.allowedApps`, not by this row). `sessionId` ties the share to
// its source chat: deleting that chat deletes its shares too (otherwise a live
// link would be left unrevokable, since shares are only listed per session). A
// non-NULL `revokedAt` = soft-deleted ⇒ the public read returns 404.
export const sharedChats = sqliteTable(
  "shared_chats",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    title: text("title").notNull(),
    // JSON ChatShareSnapshot: the selected turns' ChatMessage[] (parent + any
    // handoff child sessions, each tagged with its sessionId) plus per-trace
    // prebuilt TraceSnapshots, so the public renderer needs no app/agent
    // resolver at read time.
    snapshot: text("snapshot").notNull(),
    // JSON WidgetPlacement[] — the source session's workspace layout, frozen
    // with `type: "desktop"` (browser/noVNC) stripped (it can't be scoped to a
    // share). Drives the public read-only widget strip.
    layout: text("layout").notNull().default("[]"),
    // The source session's project (relative dir under the projects root). The
    // public projects file browser is scoped to THIS directory, not the whole
    // root — so a share exposes one project's files, never every project. NULL
    // ⇒ the session had no project ⇒ public `/projects/*` reads 404.
    projectPath: text("project_path"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => [index("idx_shared_chats_session_id").on(table.sessionId)],
);

export const actionExecutions = sqliteTable("action_executions", {
  id: text("id").primaryKey(),
  rootExecutionId: text("root_execution_id").notNull(),
  actionName: text("action_name").notNull(),
  actionType: text("action_type"), // "system" | "custom"
  status: text("status", {
    enum: ["running", "success", "error", "pending_approval", "cancelled"],
  }).notNull(),
  args: text("args", { mode: "json" }),
  error: text("error"),
  durationMs: integer("duration_ms"),
  initiator: text("initiator"),
  // Authenticated session identity accountable for this execution (a
  // `SessionActor` — guardian / visitor / anonymous), resolved host-side at the
  // HTTP/WS boundary and inherited down the execution chain. NULL = no
  // accountable session anywhere in the chain (agent-autonomous, routine,
  // webhook, startup). Orthogonal to `initiator`, which names the triggering
  // mechanism.
  actor: text("actor", { mode: "json" }),
  parentId: text("parent_id"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp" }),
  cancellationReason: text("cancellation_reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const webhookInvocations = sqliteTable(
  "webhook_invocations",
  {
    executionId: text("execution_id").primaryKey(),
    actionName: text("action_name").notNull(),
    args: text("args", { mode: "json" }),
    callbackUrl: text("callback_url"),
    status: text("status", {
      enum: ["accepted", "running", "success", "error", "pending_approval", "cancelled"],
    }).notNull(),
    result: text("result", { mode: "json" }),
    error: text("error"),
    callbackStatus: text("callback_status", {
      enum: ["not_requested", "pending", "succeeded", "failed"],
    }).notNull(),
    callbackAttemptedAt: integer("callback_attempted_at", { mode: "timestamp" }),
    callbackDeliveredAt: integer("callback_delivered_at", { mode: "timestamp" }),
    callbackResponseStatus: integer("callback_response_status"),
    callbackError: text("callback_error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_webhook_invocations_created_at").on(table.createdAt),
    index("idx_webhook_invocations_action_name").on(table.actionName),
  ],
);

// turnId groups all rows produced by a single agent turn (user prompt +
// assistant reply + trace). Read path orders by the group's earliest
// createdAt, then by createdAt within the group, so concurrent turns A and B
// render as user-A / assistant-A / trace-A / user-B / assistant-B / trace-B
// even if turn B's user row was inserted before turn A's reply rows.
// NULL is allowed for legacy rows and out-of-band inserts (each treated as a
// singleton group ordered solely by createdAt).
export const romeAgentMessages = sqliteTable(
  "rome_agent_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    inputState: text("input_state").$type<AgentInputState>(),
    role: text("role").notNull(), // 'user' | 'assistant' | 'notification' | 'trace'
    content: text("content").notNull(), // JSON array of blocks
    platformMessageId: text("platform_message_id"),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    replyToPlatformMessageId: text("reply_to_platform_message_id"),
    contextInjectedTurnId: text("context_injected_turn_id"),
    triggerKind: text("trigger_kind"),
    triggerName: text("trigger_name"),
    triggerActionName: text("trigger_action_name"),
    triggerExecutionId: text("trigger_execution_id"),
    rootActionExecutionId: text("root_action_execution_id"),
    parentActionExecutionId: text("parent_action_execution_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: real("cost_usd"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_rome_agent_messages_session_id").on(table.sessionId),
    index("idx_rome_agent_messages_turn_id").on(table.turnId),
    index("idx_rome_agent_messages_role_created_at").on(table.role, table.createdAt),
    index("idx_rome_agent_messages_platform_message")
      .on(table.sessionId, table.platformMessageId)
      .where(sql`${table.platformMessageId} IS NOT NULL`),
  ],
);

// Append-only storage for trace content, avoiding the O(N²) cost of storing
// the whole trace as one JSON array on the role='trace' rome_agent_messages
// row and re-serializing it after every agent event — that multi-megabyte
// synchronous rewrite on the main event loop stalls every HTTP request while
// a long turn streams. The trace message row stays a stub (content '[]',
// accounting columns updated incrementally) and each trace block is appended
// here as its own row. Readers merge block rows back into the legacy
// JSON-array shape; traces persisted before this table existed still carry
// their full content on the message row and are served from there unchanged.
export const romeAgentTraceBlocks = sqliteTable(
  "rome_agent_trace_blocks",
  {
    // The role='trace' rome_agent_messages row this block belongs to. Not a FK:
    // the stub row and its first blocks are inserted in one transaction, and
    // rome_agent_messages.id has no cascade contract to rely on.
    messageId: text("message_id").notNull(),
    // 0-based position within the trace. The (messageId, seq) primary key
    // makes replays of a failed append fail loudly instead of silently
    // double-counting accounting totals.
    seq: integer("seq").notNull(),
    // Denormalized so session-scoped deletes and reads don't need a join
    // through rome_agent_messages.
    sessionId: text("session_id").notNull(),
    content: text("content").notNull(), // JSON of a single trace block
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.seq] }),
    index("idx_rome_agent_trace_blocks_session_id").on(table.sessionId),
    // Terminal result/error blocks are the canonical source for actual model
    // attribution. A trace message may contain terminal blocks from both the
    // owning Agent and its subagents, so this index must not enforce uniqueness.
    index("idx_rome_agent_trace_blocks_terminal_message")
      .on(table.messageId)
      .where(sql`json_extract(${table.content}, '$.type') IN ('result', 'error')`),
    index("idx_rome_agent_trace_blocks_turn_end_message")
      .on(table.messageId)
      .where(sql`json_extract(${table.content}, '$.type') = 'turn_end'`),
  ],
);

// UI-state mirror only — the canonical feedback record ships via OTLP logs
// to rome-obs, since the user's SQLite never leaves their VM. The session_id
// FK + ON DELETE CASCADE guarantees feedback can't outlive its session even
// if a future delete path forgets to clear feedback rows manually.
export const webchatTurnFeedback = sqliteTable(
  "webchat_turn_feedback",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => romeSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    rating: text("rating", { enum: TURN_FEEDBACK_RATINGS }).notNull(),
    comment: text("comment"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.turnId] }),
    index("idx_webchat_turn_feedback_session_id").on(table.sessionId),
  ],
);

export const routines = sqliteTable("routines", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Optional caller-assigned identity. Unique when set (SQLite treats multiple
  // NULLs as distinct, so most routines can leave it null). Lets a caller make
  // create_routine idempotent/dedup-able without overloading `name` (the human
  // title): briefing keys its managed routines `briefing-*` and recreates them
  // by key. A duplicate key is rejected at create time.
  key: text("key").unique(),
  // The app that owns and manages this routine (its appId), e.g. "briefing".
  // Null for routines a guardian or agent created directly. A managed routine is
  // the app's to maintain: users can't delete it (the dashboard/DELETE path and
  // agent's delete_routine both refuse), only the managing app can — so an app
  // can freely recreate its routines on sync without a user pruning them.
  managedBy: text("managed_by"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),

  // Trigger config (JSON, discriminated by trigger.type)
  trigger: text("trigger", { mode: "json" }).notNull(),

  actionName: text("action_name").notNull(),
  args: text("args", { mode: "json" }).notNull(), // JSON array

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastFiredAt: integer("last_fired_at", { mode: "timestamp" }),
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
});

export const routineRuns = sqliteTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .references(() => routines.id)
      .notNull(),
    executionId: text("execution_id").notNull(),
    status: text("status", {
      enum: ["success", "error", "running", "pending_approval", "cancelled"],
    }).notNull(),
    payload: text("payload", { mode: "json" }),
    firedAt: integer("fired_at", { mode: "timestamp" }).notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
  },
  (table) => [
    index("idx_routine_runs_routine_id").on(table.routineId),
    index("idx_routine_runs_fired_at").on(table.firedAt),
    index("idx_routine_runs_status").on(table.status),
  ],
);

export const executionJournal = sqliteTable(
  "execution_journal",
  {
    id: text("id").primaryKey(),
    rootExecutionId: text("root_execution_id").notNull(),
    sequence: integer("sequence").notNull(),
    actionName: text("action_name").notNull(),
    argsHash: text("args_hash").notNull(),
    args: text("args", { mode: "json" }),
    result: text("result", { mode: "json" }),
    status: text("status").notNull(), // "completed" | "pending_approval" | "diverged"
    expectedActionName: text("expected_action_name"),
    expectedArgsHash: text("expected_args_hash"),
    actualActionName: text("actual_action_name"),
    actualArgsHash: text("actual_args_hash"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_ej_root_execution_id").on(table.rootExecutionId),
    index("idx_ej_created_at").on(table.createdAt),
  ],
);

// One row per minted Connection. The many-to-many grant ledger lives in
// `connection_grants` below, keyed by custody (the connectionId).
export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    service: text("service").notNull(),
    label: text("label").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("connections_service_unique").on(table.service)],
);

// The grant ledger. Rows record outcomes only — never step/flow state
// or scheme-specific columns. `credential` is a PersistedCredential envelope
// stored as plain JSON (repo precedent: encryption deliberately dropped, see
// `packages/core/src/lib/provider-accounts.ts`); the envelope shape is kept so
// encryption can return later. A grant row is present in "unauthorized" from
// connection creation; conferral fills it. One grant = one credential row.
export const connectionGrants = sqliteTable(
  "connection_grants",
  {
    custody: text("custody").notNull(), // connectionId
    name: text("name").notNull(),
    state: text("state").notNull(), // unauthorized | authorized | degraded
    credential: text("credential", { mode: "json" }), // PersistedCredential | null
    profile: text("profile", { mode: "json" }), // ProfileRecord | null — non-secret conferral outcome
    conferredAt: integer("conferred_at", { mode: "timestamp" }),
    lastRenewedAt: integer("last_renewed_at", { mode: "timestamp" }),
    degradedAt: integer("degraded_at", { mode: "timestamp" }),
    degradedReason: text("degraded_reason"),
  },
  (table) => [primaryKey({ columns: [table.custody, table.name] })],
);
