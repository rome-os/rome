import type {
  ErrorBlock as TraceErrorBlock,
  RomeSessionRefDto,
  TraceAccounting,
  TraceSummary,
} from "@rome/api-types/trace-segments";
import type {
  RomeSessionDetail,
  RomeSessionExplorerRecord,
  RomeSessionsPageResult,
} from "@rome/api-types/sessions";

export type ChatErrorCode = NonNullable<TraceErrorBlock["code"]>;
export type ChatErrorProvider = NonNullable<TraceErrorBlock["provider"]>;
export type ChatErrorReason = NonNullable<TraceErrorBlock["reason"]>;

export interface ChatErrorNotice {
  message: string;
  code?: ChatErrorCode;
  provider?: ChatErrorProvider;
  reason?: ChatErrorReason;
}

export interface ChatSession {
  id: string;
  name: string;
  personaId: string | null;
  largeModelSelection?: string | null;
  /** Concrete model pinned by the session’s last successful turn, when known. */
  model?: string | null;
  projectName: string;
  projectPath?: string | null;
  agentName?: string | null;
  /** ISO timestamp when the chat was archived (soft-hidden), or null. */
  archivedAt?: string | null;
  /** ISO timestamp when this chat was pinned by the guardian, or null. */
  pinnedAt?: string | null;
  createdAt: string;
  activityAt: string;
  lastSeenActivityAt: string | null;
  unread: boolean;
  messageCount: number;
}

/** One hit from `GET /chat/sessions/search`: the session plus its most recent
 * message whose transcript text matched the query. */
export interface ChatSearchMessageMatch {
  session: ChatSession;
  message: {
    id: string;
    role: "user" | "assistant" | "notification";
    snippet: string;
    createdAt: string;
  };
}

export type RomeSessionRecord = RomeSessionExplorerRecord;
export type { RomeSessionDetail, RomeSessionsPageResult };

export interface AgentMention {
  appId: string;
  appLabel: string;
  agentName: string;
  // Owning app's icon for chip rendering. Optional because mentions are also
  // built from static config (starter chips) — absent falls back to the Rome mark.
  iconUrl?: string | null;
}

export interface AgentCatalogEntry {
  name: string;
  localName?: string;
  description: string;
}

export interface AgentCatalogGroup {
  ownerId: string;
  ownerType: "core" | "app";
  label: string;
  description: string;
  iconUrl: string | null;
  agents: AgentCatalogEntry[];
}

/** One catalog skill, as returned by `GET /api/skills`. */
export interface SkillSummary {
  name: string;
  localName: string;
  description: string;
  tools: string[];
  ownerType: "core" | "app";
  ownerId: string;
  ownerLabel: string;
  ownerDescription: string;
  iconUrl: string | null;
}

export type ApprovalCardStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed";

export type ApprovalPreviewPayload =
  | {
      kind: "sensitive_message";
      channel: string;
      threadId: string;
      text: string;
      reason?: string;
    }
  | {
      kind: "generic";
      title: string;
      summary: string;
      fields?: { label: string; value: string }[];
    };

export interface StreamBlock {
  type: string;
  content?: string;
  /** On `text` parts/blocks: role of this text within its agent turn.
   *  `commentary` = in-turn narration (rendered muted), `final`/absent = the
   *  turn's answer. */
  turnPhase?: "commentary" | "final";
  /** Zero-based WebChat assistant text-block identity within the agent turn. */
  blockIx?: number;
  error?: string | { message: string; code?: string };
  code?: ChatErrorCode;
  provider?: ChatErrorProvider;
  reason?: ChatErrorReason;
  tool?: string;
  id?: string;
  toolUseId?: string;
  input?: unknown;
  output?: unknown;
  turnId?: string;
  audioUrl?: string;
  audioMimeType?: string;
  audioDurationMs?: number;
  startedAt?: string;
  endedAt?: string;
  agent?: string;
  sessionId?: string;
  romeSession?: RomeSessionRefDto;
  systemPrompt?: string;
  userPrompt?: string;
  accounting?: TraceAccounting;
  approvalId?: string;
  actionName?: string;
  preview?: ApprovalPreviewPayload;
  status?: ApprovalCardStatus | "running" | "completed" | "cancelled";
  /** Present on routine_draft_card parts. */
  draft?: RoutineDraftSpec;
  /** Present on pending_interaction / handoff parts — the app that owns the
   * component or surface. */
  appId?: string;
  /** Present on pending_interaction parts — the inline component to mount. */
  render?: InlineInteractionRender;
  /** Present on handoff parts — the agent holding the floor in the child
   * session. */
  agentName?: string;
  /** Present on handoff parts — the spawned webchat session the design
   * conversation lives in; clicking the marker opens it. */
  childSessionId?: string;
  /** On handoff parts: seed context (summary, agentLabel) for the design
   * conversation. On submission_card parts: the validated payload the
   * specialist submitted for guardian approval. */
  payload?: Record<string, unknown>;
}

/** The inline component a `pending_interaction` part mounts in the
 * transcript — mirrors the server part. */
export interface InlineInteractionRender {
  kind: "inline";
  componentId: string;
  props?: Record<string, unknown>;
  /** When true the component is a host built-in (rendered by rome-web), not
   * an app component to mount in a shadow root. `appId` is the sentinel
   * "core" in that case. */
  builtin?: boolean;
}

export interface RoutineEventFilterCondition {
  field: string;
  equals: string;
}

export interface RoutineEventBusTrigger {
  type: "event-bus";
  eventName: string;
  filter?: RoutineEventFilterCondition[];
}

export interface RoutineScheduleTrigger {
  type: "schedule";
  tzid: string;
  localTime: string;
  date?: string;
  rrule?: string;
}

/** A routine with no automatic trigger — it runs only from the Routines page's
 * "Run now" button. Carries no config. */
export interface RoutineManualTrigger {
  type: "manual";
}

/** Mirrors `@rome-os/app-runtime`'s PreviewPayload — an action's own
 * ground-truth render of a bound call, used to build approval and routine cards. */
export type PreviewPayload =
  | { kind: "sensitive_message"; channel: string; threadId: string; text: string; reason?: string }
  | {
      kind: "generic";
      title: string;
      summary: string;
      fields?: { label: string; value: string }[];
    };

/** Mirrors `@rome-os/app-runtime`'s RoutineDraftSpec — the payload snapshotted
 * from a `propose_routine` tool call and rendered by the draft card. The routine
 * fires on a matching event, on a schedule, or only when run by hand (manual). */
export interface RoutineDraftSpec {
  sentence: string;
  name: string;
  watchLabel: string;
  filterSummary?: string;
  thenSummary: string;
  trigger: RoutineScheduleTrigger | RoutineEventBusTrigger | RoutineManualTrigger;
  actionName: string;
  args: Record<string, unknown>;
  /** Authoritative render of the bound action, produced by the action's own
   * preview(). Absent when the action implements none; the card then falls back
   * to `thenSummary`. */
  preview?: PreviewPayload;
}

export interface ApprovalRecord {
  id: string;
  status: "pending" | "approved" | "rejected" | "auto_approved";
  executionState?: "idle" | "queued" | "running" | "succeeded" | "failed" | null;
  executionError?: string | null;
}

export interface DoneEventData {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: ChatErrorCode;
  provider?: ChatErrorProvider;
  reason?: ChatErrorReason;
}

// A single in-flight turn returned by GET /chat/sessions/:id/turns.
export interface TurnInfo {
  turnId: string;
  streamId: string;
  startedAt: string;
  status: "running" | "queued";
}

// Shape of POST /chat/sessions/:id/turns response.
export interface CreateTurnResponse {
  turnId: string | null;
  inputId?: string;
  disposition?: "started" | "queued" | "steering";
  inputState?: import("@rome/api-types/trace-segments").AgentInputState | null;
  sessionId: string;
  startedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  turnId?: string | null;
  inputState?: import("@rome/api-types/trace-segments").AgentInputState | null;
  role: "user" | "assistant" | "notification" | "trace";
  content: string; // JSON array of blocks
  createdAt: string;
  traceSummary?: TraceSummary | null;
}

export interface ProjectOption {
  displayName?: string;
  name: string;
  path: string;
  projectPath?: string;
}

export interface ProjectCatalog {
  rootPath: string;
  defaultPath: string;
  projects: ProjectOption[];
}

export interface PendingUpload {
  id: string;
  file: File;
}

export type ReasoningEffort = "low" | "high" | "xhigh";
