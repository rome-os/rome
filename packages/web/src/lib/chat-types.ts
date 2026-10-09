import type { TranscriptPart } from "@rome/api-types/chat";
import type {
  TraceErrorEvent,
  TraceEventDto,
  RomeSessionRefDto,
  TraceAccounting,
  TraceSummary,
} from "@rome/api-types/trace-segments";
import type {
  RomeSessionDetail,
  RomeSessionExplorerRecord,
  RomeSessionsPageResult,
} from "@rome/api-types/sessions";

export type ChatErrorCode = NonNullable<TraceErrorEvent["code"]>;
export type ChatErrorProvider = NonNullable<TraceErrorEvent["provider"]>;
export type ChatErrorReason = NonNullable<TraceErrorEvent["reason"]>;

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
  /** Effort the session’s last successful turn ran with, in the provider’s own terms, when known. */
  reasoningEffort?: string | null;
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
  /** Present on `GET /chat/sessions` rows: a turn is running right now. */
  running?: boolean;
  /** Present on `GET /chat/sessions` rows: the latest turn ended in an error. */
  lastTurnFailed?: boolean;
  /** Present on `GET /chat/sessions` rows: an open card or a pending approval waits on the guardian. */
  awaitingGuardian?: boolean;
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

export type {
  ApprovalCardStatus,
  PreviewPayload,
  RoutineDraftSpec,
  TranscriptPart,
} from "@rome/api-types/chat";

/** One block a chat surface renders: a part of a stored message's content, or
 * a trace event. Switch on `type` to narrow it. */
export type ChatEntry = TranscriptPart | TraceEventDto;

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
