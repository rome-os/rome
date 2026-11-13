import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";
import {
  cardKey,
  chatCardSettledSchema,
  type LiveTaskCards,
  LiveTaskCardsProvider,
} from "./entries/live-task-cards";
import type { DraftDeviceFolder } from "@/lib/device-folder";
import { flushSync } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  MoreHorizontal,
  PanelRightOpen,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { z } from "zod";
import type { MessageWritingEvent } from "@rome/api-types/concierge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { SlotContent, SlotOutlet } from "@/components/slot";
import "react-medium-image-zoom/dist/styles.css";
import { cn } from "@/lib/utils";
import { usePresentationMode } from "@/lib/presentation-mode";
import { dataTransferHasFiles, extractFilesFromDataTransfer } from "@/lib/clipboard-files";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TraceDrawer, type TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";
import { SessionAvatar } from "@/components/chat/SessionAvatar";
import { SessionLoadingTitle } from "@/components/chat/SessionLoadingTitle";
import { senderFromIdentity } from "@/components/chat/SenderAvatar";
import { useDashboardIdentity } from "@/hooks/use-dashboard-identity";
import { useSessionIdentity } from "@/components/chat/use-session-identity";
import { TaskChatContext } from "@/components/chat/task-chat";
import {
  prettyAgentName,
  mainAgentDisplayName as resolveMainAgentDisplayName,
} from "@/lib/agent-name";
import { artifactLocalName } from "@/lib/artifact-name";
import {
  buildChatView,
  buildRows,
  threadInteractionResults,
  currentReplyMessages,
  isAwaitingGuardian,
  isLockedByCard,
  isLastTurnFailed,
  type AgentIdentity,
} from "@/components/chat/chat-view";
import { ShareBar } from "@/components/chat/ShareBar";
import {
  MessageSharingContext,
  type SharedMessageTurn,
} from "@/components/chat/ShareMessageButton";
import { useWorkspaceEventBus } from "@/pages/free/workspace-event-bus";
import { useFreeCells } from "@/pages/free/use-free-cells";
import { useToolTrace } from "@/pages/free/tool-trace";
import type {
  TraceSegment,
  TraceSnapshot,
  TraceSubagentSummary,
  TraceSummary,
} from "@rome/api-types/trace-segments";
import { useStableMap } from "@/hooks/use-stable-map";
import { HOLD_STICK_EVENT, useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { ChatPendingCardJump, ConciergeCardJump } from "@/components/chat/ChatPendingCardJump";
import {
  CHAT_PAGE_TURNS,
  CONCIERGE_PAGE_TURNS,
  useOlderMessages,
} from "@/components/chat/use-older-messages";
import { ChatTimelineRail } from "@/components/chat/ChatTimelineRail";
import {
  ReplyDraftProvider,
  replyFormFields,
  useReplyDraftState,
} from "@/components/chat/reply/reply-draft";
import { findMessageAnchor } from "@/components/chat/reply/reply-source";
import { chatFloorLayering } from "@/components/chat/chat-floor";
import { isAnchorInView, LANDING_MS, playLanding } from "@/components/chat/reply/thread-anchor";
import { useDesktop } from "@/hooks/use-desktop";
import { buildTimelineQuestions } from "@/components/chat/chat-timeline";
import { runningTurnIdOf, useStreamingSessions } from "@/hooks/use-streaming-sessions";
import { useChatTabStatus } from "@/hooks/use-tab-status";
import {
  type WidgetHost,
  WidgetHostContext,
} from "@/components/chat/entries/widget-ui/turn-fields";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { renderFlatEntries, renderSingleEntry } from "@/components/chat/entries";
import { MessageList, type BlockActions, type ChatVariant } from "@/components/chat/MessageList";
import {
  ChatComposer,
  type ChatComposerHandle,
  type ChatComposerSendControls,
  type ChatComposerSnapshot,
} from "@/components/chat/ChatComposer";
import { ConciergeComposer } from "@/components/chat/composer/ConciergeComposer";
import { ChatThreadView, OpenThreadTaskChat } from "@/components/chat/ChatThreadView";
import {
  type LiveStatusReactions,
  LiveStatusReactionsProvider,
  messageStatusReactionSchema,
} from "@/components/chat/status-reaction";
import { ConciergeTranscript } from "@/components/chat/ConciergeTranscript";
import { ConciergeUnreadPill } from "@/components/chat/ConciergeUnreadPill";
import { summarizeUnread, useUnreadAtOpen } from "@/components/chat/concierge-unread";
import {
  ChatThreadsProvider,
  placeLive,
  type ThreadPlacement,
  useChatThreadsValue,
} from "@/components/chat/reply/chat-threads";
import {
  ConciergeEmptyState,
  ConciergeTopicEmptyState,
} from "@/components/chat/ConciergeEmptyState";
import { onConciergeJump } from "@/components/concierge/concierge-jump";
import {
  CONCIERGE_LEADING_SLOT,
  CONCIERGE_TITLEBAR_SLOT,
  ConciergeHeaderStatus,
  FLOATING_SURFACE,
} from "@/components/concierge/ConciergeHeaderStatus";
import { useTaskList } from "@/components/concierge/TaskListPane";
import { TopicChatDeleteDialog } from "@/components/concierge/TopicChatDeleteDialog";
import { useToolTasks } from "@/pages/free/tool-tasks";
import { useConciergeActivity } from "@/components/concierge/use-concierge-activity";
import { type TurnPollOutcome, useTurnPoll } from "@/components/chat/use-turn-poll";
import type {
  AgentMention,
  ChatErrorCode,
  ChatErrorNotice,
  ChatErrorProvider,
  ChatErrorReason,
  ChatMessage,
  CreateTurnResponse,
  DoneEventData,
} from "@/lib/chat-types";
import { buildOptimisticUserText } from "@/lib/chat-helpers";
import {
  parseSSEEvents,
  STREAM_STALL_TIMEOUT_MS,
  TURN_RESUME_BASE_DELAY_MS,
  TURN_RESUME_MAX_DELAY_MS,
} from "@/lib/chat-sse";
import {
  mergeChatMessage,
  mergeLatestMessagePage,
  orderChatMessages,
  startsNewHistory,
} from "@/lib/chat-message-ordering";
import {
  ChatApiError,
  createSession,
  deleteSession,
  interruptTurn,
  listChatAgents,
  listSessionMessagePage,
  listSessionTurns,
  markSessionRead as apiMarkSessionRead,
  openTurnStream,
  postSessionTurn,
  postSessionTurnJson,
  type PostTurnResult,
  updateSessionModel,
} from "@/lib/chat-api";
import { useArchiveSession } from "@/lib/session-events";
import { MAIN_CHAT_PATH } from "@/lib/chat-session";
import {
  snapshotWorkspaceForSend,
  useWorkspaceContextRegistry,
} from "@/pages/free/workspace-context";
import { applyAgentPlacement } from "@/pages/free/use-free-cells";
import { randomUUID } from "@/lib/random-uuid";
import { DEFAULT_LARGE_MODEL_SELECTION } from "@/lib/chat-constants";

// Leave a jumped-to question clear of the top edge — flush against it reads
// as cut off.
const TIMELINE_JUMP_OFFSET_PX = 24;
/** How many older pages a jump to a Concierge message loads before it gives up. */
const MAX_JUMP_PAGES = 20;

// Chat Component

// After an interrupt is accepted, a healthy stream delivers `done` almost
// immediately. If the local streaming entry survives this grace period the
// stream is dead — force-release it so Stop visibly takes effect on the tap
// that requested it instead of after the next message send.
const STOP_FORCE_RELEASE_GRACE_MS = 2_500;

const agentPlanSchema = z.object({
  explanation: z.string().optional(),
  steps: z.array(
    z.object({
      id: z.string().optional(),
      text: z.string(),
      activeText: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
});

const traceSummarySchema: z.ZodType<TraceSummary> = z.lazy(() =>
  z.object({
    distinctApps: z.array(z.object({ id: z.string(), name: z.string(), iconUrl: z.string() })),
    totalSteps: z.number(),
    subagents: z
      .array(
        z.object({
          toolUseId: z.string(),
          agentName: z.string(),
          sessionId: z.string(),
          turnId: z.string(),
          status: z.enum(["running", "completed", "failed", "cancelled"]),
          traceSummary: traceSummarySchema.optional(),
        }),
      )
      .optional(),
    totalDurationMs: z.number().optional(),
    turnStatus: z.enum(["completed", "interrupted", "error"]).optional(),
    invocationCounts: z.record(z.string(), z.number()),
    stoppedByUser: z.boolean().optional(),
    terminalError: z.string().optional(),
    // Any string, so a code a newer server adds still parses and reads as raw text.
    terminalErrorCode: z.custom<ChatErrorCode>((value) => typeof value === "string").optional(),
    terminalErrorProvider: z
      .custom<ChatErrorProvider>((value) => typeof value === "string")
      .optional(),
    terminalErrorReason: z.custom<ChatErrorReason>((value) => typeof value === "string").optional(),
    plan: agentPlanSchema.optional(),
    model: z.string().optional(),
    sessionRenewal: z.object({ reason: z.string(), sessionId: z.string() }).optional(),
  }),
);

const chatMessageSchema: z.ZodType<ChatMessage> = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable().optional(),
  role: z.enum(["user", "assistant", "trace", "notification"]),
  content: z.string(),
  createdAt: z.string(),
  traceSummary: traceSummarySchema.nullable().optional(),
  chatThreadId: z.string().nullable().optional(),
});

const sessionNameSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
});

const sessionRunningSchema = z.object({ sessionId: z.string(), running: z.boolean() });

/** How the running turn shows the typing dots (`message_writing`). */
const messageWritingSchema: z.ZodType<MessageWritingEvent> = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  mode: z.enum(["exact", "simulated"]),
  writing: z.boolean(),
});

const messageChatThreadSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  chatThreadId: z.string(),
  /** The task's title, when the thread is a task's. */
  chatThreadTitle: z.string().optional(),
});

/** A task left the chat, and its chat thread with it. */
const chatThreadRetiredSchema = z.object({
  sessionId: z.string(),
  chatThreadId: z.string(),
});

interface ChatSessionEventsProps {
  sessionId: string;
  onMessageInsert: (sessionId: string, message: ChatMessage) => void;
  /** The Concierge placed a message of the chat in a chat thread. */
  onMessageChatThread?: (event: z.infer<typeof messageChatThreadSchema>) => void;
  onChatThreadRetired?: (event: z.infer<typeof chatThreadRetiredSchema>) => void;
  /** Rome changed the status reaction on a guardian message of a Concierge chat. */
  onMessageStatusReaction?: (event: z.infer<typeof messageStatusReactionSchema>) => void;
  /** A question or approval a task card shows settled. */
  onChatCardSettled?: (event: z.infer<typeof chatCardSettledSchema>) => void;
  onSessionName: (sessionId: string, event: z.infer<typeof sessionNameSchema>) => void;
  onSessionRunning: (event: z.infer<typeof sessionRunningSchema>) => void;
  /** How the running turn shows the typing dots changed. */
  onMessageWriting?: (event: MessageWritingEvent) => void;
  onReconnect: (sessionId: string) => void;
}

function ChatSessionEvents({
  sessionId,
  onMessageInsert,
  onMessageChatThread,
  onChatThreadRetired,
  onMessageStatusReaction,
  onChatCardSettled,
  onSessionName,
  onSessionRunning,
  onMessageWriting,
  onReconnect,
}: ChatSessionEventsProps) {
  useLiveEvents(
    chatSessionTopic(sessionId),
    {
      message_insert: {
        schema: chatMessageSchema,
        fn: (message) => onMessageInsert(sessionId, message),
      },
      session_name: {
        schema: sessionNameSchema,
        fn: (event) => onSessionName(sessionId, event),
      },
      message_chat_thread: {
        schema: messageChatThreadSchema,
        fn: (event) => {
          if (event.sessionId === sessionId) onMessageChatThread?.(event);
        },
      },
      chat_thread_retired: {
        schema: chatThreadRetiredSchema,
        fn: (event) => {
          if (event.sessionId === sessionId) onChatThreadRetired?.(event);
        },
      },
      message_status_reaction: {
        schema: messageStatusReactionSchema,
        fn: (event) => {
          if (event.sessionId === sessionId) onMessageStatusReaction?.(event);
        },
      },
      chat_card_settled: {
        schema: chatCardSettledSchema,
        fn: (event) => {
          if (event.sessionId === sessionId) onChatCardSettled?.(event);
        },
      },
      session_running: {
        schema: sessionRunningSchema,
        fn: (event) => {
          if (event.sessionId === sessionId) onSessionRunning(event);
        },
      },
      message_writing: {
        schema: messageWritingSchema,
        fn: (event) => {
          if (event.sessionId === sessionId) onMessageWriting?.(event);
        },
      },
    },
    {
      onReconnect: () => onReconnect(sessionId),
      onError: ({ readyState }) => {
        if (readyState === EventSource.CLOSED) onReconnect(sessionId);
      },
    },
  );
  return null;
}

function isModelResolutionErrorCode(code: DoneEventData["code"]): boolean {
  return (
    code === "model_provider_unavailable" ||
    code === "model_unavailable" ||
    code === "no_model_provider_available"
  );
}

export interface SessionMessage {
  sessionId: string;
  turnId: string | null;
  segment?: TraceSegment;
}

export interface ChatProps {
  /**
   * The session to open. Without one the chat is a draft: it shows
   * `emptyState`, and its first send creates a session that the same instance
   * then keeps, so the composer never remounts.
   */
  sessionId?: string | null;
  /** Guardian-chosen display name for the default main agent. */
  mainAgentDisplayName?: string;
  onSessionsChanged?: () => void;
  onSessionNotFound?: (sessionId: string) => void;
  /**
   * Asked before a missing session is reported to `onSessionNotFound`: resolve
   * true if the session exists now (it was being created), and the load tries
   * once more.
   */
  recoverMissingSession?: (sessionId: string) => Promise<boolean>;
  /**
   * Resolves with the chat's read mark, as the server holds it before this chat
   * marks itself read, or null when it has none. Only a Concierge chat needs
   * it: the chat waits for the answer before its read mark, and draws a divider
   * where the unread messages start. Without it the chat does neither.
   */
  loadReadMark?: (chatId: string) => Promise<string | null>;
  onSessionMessage?: (message: SessionMessage) => void;
  /**
   * Called with a session's saved workspace layout (`null` when none) when its
   * first messages page arrives, in the same render as that page's messages.
   */
  onSessionLayout?: (sessionId: string, layout: unknown[] | null) => void;
  /**
   * Called once with the id of the session a draft's first send created,
   * before that turn is posted. A host that navigates to the session must keep
   * this instance mounted for it.
   */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Creates the session a draft's first send goes to, in place of an ordinary
   * dashboard chat, as a Concierge topic chat does. Answers its id.
   */
  startSession?: () => Promise<string>;
  /** Rendered in place of the transcript while the chat has no session. */
  emptyState?: ReactNode;
  /**
   * Centers the draft's empty state and composer as one group from `md` up,
   * instead of docking the composer at the bottom. For an empty state that is
   * only a short greeting, which would otherwise float far above the composer.
   */
  centerDraftComposer?: boolean;
  /** Draft seeds for the composer, read when it mounts. */
  initialProjectName?: string;
  initialDeviceFolder?: DraftDeviceFolder;
  initialAgentMention?: AgentMention | null;
  /** Receives the composer's handle, for a host that seeds or focuses the draft. */
  composerRef?: RefObject<ChatComposerHandle | null>;
  /**
   * A slot to draw the chat's bar into instead of a row above the transcript.
   * The Mac app passes its title bar's, so the window has one row on top.
   */
  navbarSlot?: string;
  /**
   * `concierge` makes this the texting-style Concierge chat: a new message
   * interrupts the running turn, and the transcript and composer drop the
   * trace, turn summary, pickers, and Stop.
   */
  variant?: ChatVariant;
  /** The signed-in person's main Concierge chat, which shows the starters a topic chat does not. The guardian's by default. */
  conciergeMainChatId?: string;
  /** The Concierge's name, which every Concierge chat's header shows in place of the chat's own name. */
  conciergeName?: string;
}

// The summary persisted for a turn's trace, once the turn has one.
function savedTraceSummary(
  messages: readonly ChatMessage[] | undefined,
  turnId: string | null,
): TraceSummary | null {
  if (!turnId) return null;
  return (
    messages?.find((m) => m.role === "trace" && m.turnId === turnId && m.traceSummary)
      ?.traceSummary ?? null
  );
}

export function Chat({
  sessionId,
  mainAgentDisplayName,
  onSessionsChanged,
  onSessionNotFound,
  recoverMissingSession,
  loadReadMark,
  onSessionMessage,
  onSessionLayout,
  onSessionCreated,
  startSession,
  emptyState,
  centerDraftComposer = false,
  initialProjectName,
  initialDeviceFolder,
  initialAgentMention,
  composerRef: hostComposerRef,
  navbarSlot,
  variant = "default",
  conciergeMainChatId = CONCIERGE_CHAT_ID,
  conciergeName,
}: ChatProps) {
  const concierge = variant === "concierge";
  const pageTurns = concierge ? CONCIERGE_PAGE_TURNS : CHAT_PAGE_TURNS;
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const presentationMode = usePresentationMode();
  // `null` outside the workspace shell; sends simply skip injection.
  const workspaceContextRegistry = useWorkspaceContextRegistry();
  const { toolView } = useFreeCells();
  // The tool pane: its Trace tab shows this chat's trace, and its open state
  // includes a pane a trace holds open.
  const toolTrace = useToolTrace();
  // Pick the session id deliberately:
  //   • mainSessionId  — the session THIS <Chat> owns: the prop, or the one its
  //     draft created, and null while a draft has none.
  //   • a block's own message.sessionId — for inline-component submit/dismiss.
  // Never key shared interaction state by a bare toolUseId — provider ids recycle
  // per turn AND across sessions, so namespace by session (interactionResultKey).
  //
  // The host remounts <Chat> with a new key for every other session, so the
  // main session changes at most once: from null to the one the draft created.
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const mainSessionId = sessionId || createdSessionId;
  const mainSessionIdRef = useRef(mainSessionId);
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const traceArchivedSessionsRef = useRef(new Set<string>());
  const [subagentIconByName, setSubagentIconByName] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    void listChatAgents()
      .then((groups) => {
        if (cancelled) return;
        const icons = new Map<string, string | null>();
        for (const group of groups) {
          for (const agent of group.agents) icons.set(agent.name, group.iconUrl);
        }
        setSubagentIconByName(icons);
      })
      .catch(() => {
        if (!cancelled) setSubagentIconByName(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const {
    streams: streamingSessions,
    streamsRef: streamingSessionsRef,
    liveText: liveTextOf,
    start: startSessionStream,
    update: updateSessionSnapshot,
    updateText: updateSessionAssistantText,
    adoptAgentTurn: adoptSessionAgentTurn,
    end: endSessionStream,
  } = useStreamingSessions();
  const [streamError, setStreamError] = useState<string | ChatErrorNotice | null>(null);
  // Turns in this chat the server reported finished (a terminal stream event).
  // A dropped connection ends the local stream but not the turn, so it never
  // counts here.
  const [turnEnds, setTurnEnds] = useState(0);
  const [streamReconnectRevision, setStreamReconnectRevision] = useState(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [traceDrawerTarget, setTraceDrawerTarget] = useState<TraceDrawerTarget | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Where live `message_chat_thread` events placed messages since they loaded,
  // for the "N replies" lines, each with the thread the loaded message had
  // then. `loadedThreads` is that loaded value, kept current every render, so
  // a placement after a reload builds on what the reload said.
  const [rethreaded, setRethreaded] = useState<ReadonlyMap<string, ThreadPlacement>>(new Map());
  const loadedThreads = useRef<ReadonlyMap<string, string | null>>(new Map());
  // Task titles live placements told, by the thread they name; null for a
  // thread whose task left the chat, which is a task's no more.
  const [liveThreadTitles, setLiveThreadTitles] = useState<ReadonlyMap<string, string | null>>(
    new Map(),
  );
  const handleChatThreadRetired = useCallback(
    ({ chatThreadId }: z.infer<typeof chatThreadRetiredSchema>) =>
      setLiveThreadTitles((prev) =>
        prev.get(chatThreadId) === null ? prev : new Map(prev).set(chatThreadId, null),
      ),
    [],
  );
  const handleMessageChatThread = useCallback(
    ({ messageId, chatThreadId, chatThreadTitle }: z.infer<typeof messageChatThreadSchema>) => {
      setRethreaded((prev) =>
        placeLive(prev, messageId, chatThreadId, loadedThreads.current.get(messageId) ?? null),
      );
      if (chatThreadTitle) {
        setLiveThreadTitles((prev) =>
          prev.get(chatThreadId) === chatThreadTitle
            ? prev
            : new Map(prev).set(chatThreadId, chatThreadTitle),
        );
      }
    },
    [],
  );
  // Status reactions live events changed since the messages loaded. A
  // reconnect reloads the messages, which then say how each stands.
  const [liveReactions, setLiveReactions] = useState<LiveStatusReactions>(new Map());
  const handleMessageStatusReaction = useCallback(
    ({ messageId, statusReaction }: z.infer<typeof messageStatusReactionSchema>) =>
      setLiveReactions((prev) => new Map(prev).set(messageId, statusReaction)),
    [],
  );
  // How each chat's running turn shows the typing dots, its latest word.
  const [liveWriting, setLiveWriting] = useState<ReadonlyMap<string, MessageWritingEvent>>(
    new Map(),
  );
  const handleMessageWriting = useCallback(
    (event: MessageWritingEvent) =>
      setLiveWriting((prev) => new Map(prev).set(event.sessionId, event)),
    [],
  );
  // Task cards' questions and approvals live events settled since the
  // messages loaded. A reconnect reloads the messages, which carry them.
  const [liveCards, setLiveCards] = useState<LiveTaskCards>(new Map());
  const handleChatCardSettled = useCallback(
    ({ card }: z.infer<typeof chatCardSettledSchema>) =>
      setLiveCards((prev) => new Map(prev).set(cardKey(card), card)),
    [],
  );
  // Inline share flow: pick turns directly on the transcript.
  const [shareMode, setShareMode] = useState(false);
  const [selectedShareTurns, setSelectedShareTurns] = useState<Set<string>>(new Set());
  const workspaceEventBus = useWorkspaceEventBus();
  // The session's bound agent (`null` ⇒ default "main") and display name. The
  // composer renders the agent as a non-removable chip and the navbar shows the
  // name as the title; the mobile header bar (FreeGrid) reuses the same hook.
  const {
    loading: sessionLoading,
    sessionName,
    model,
    largeModelSelection: storedModelSelection,
    isForkChat,
    reasoningEffort,
    pinnedAgentMention: identityAgentMention,
    archivedAt,
    forkable,
    isTaskChat,
  } = useSessionIdentity(mainSessionId);
  // The main chat is never archived or deleted, so its menu offers neither.
  const isMainChat = concierge && mainSessionId === conciergeMainChatId;
  // The open chat's model pick, shown as soon as the guardian makes it. It is
  // stored on the chat and the next turn runs on it.
  const [pickedModel, setPickedModel] = useState<{ sessionId: string; value: string } | null>(null);
  const chatModelValue =
    (pickedModel && pickedModel.sessionId === mainSessionId ? pickedModel.value : null) ??
    storedModelSelection ??
    DEFAULT_LARGE_MODEL_SELECTION;
  const pickChatModel = useCallback(
    (next: string) => {
      if (!mainSessionId) return;
      const sessionId = mainSessionId;
      const previous = chatModelValue;
      setPickedModel({ sessionId, value: next });
      updateSessionModel(sessionId, next).catch(() => {
        setPickedModel({ sessionId, value: previous });
        setStreamError(t("modelSelector.saveFailed"));
      });
    },
    [mainSessionId, chatModelValue, t],
  );
  // The agent a draft's first send picked stands in until the new session's
  // identity loads, so its chip does not drop out when the composer locks.
  const [createdAgentMention, setCreatedAgentMention] = useState<AgentMention | null>(null);
  const pinnedAgentMention = identityAgentMention ?? createdAgentMention;
  // Local override so archive/unarchive from the navbar flips the read-only
  // composer immediately; `undefined` defers to the session read (`archivedAt`).
  const [archivedOverride, setArchivedOverride] = useState<boolean | undefined>(undefined);
  const isArchived = archivedOverride ?? archivedAt != null;
  const setArchived = useArchiveSession();
  // The override is only a momentary optimistic flip for the navbar handlers.
  // Once the session read reflects the server's archived state (including an
  // archive/unarchive triggered from the sidebar, which refetches via the
  // sessions-changed event), drop the override so server truth wins and a stale
  // override can't keep the composer editable/read-only incorrectly.
  useEffect(() => {
    setArchivedOverride(undefined);
  }, [archivedAt]);

  const ownComposerRef = useRef<ChatComposerHandle>(null);
  const composerRef = hostComposerRef ?? ownComposerRef;
  const creatingSessionRef = useRef(false);
  const dragDepthRef = useRef(0);
  const loadedSessionsRef = useRef<Set<string>>(new Set());
  const localOptimisticMessageIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const locallyStreamingSessionIdsRef = useRef<Set<string>>(new Set());
  const turnStreamControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Per-session FIFO queue of in-flight turnIds; the session's
  // streaming entry is only removed when this set drains.
  const inflightTurnsRef = useRef<Map<string, Set<string>>>(new Map());

  // Auto stick-to-bottom against the message scroller — a bounded
  // `overflow-y-auto` node, NOT the document. The chat shell is now
  // viewport-fixed, so message reflow (mermaid, late media) stays contained and
  // never moves the sidebar/composer. `overscroll-contain` + momentum scrolling
  // on that node preserve the iPad touch feel that an unstyled nested scroller
  // regressed before. The hook re-pins on content resize; we hand it the
  // scroller explicitly via `scrollRef` so it skips ancestor detection.
  //
  // A draft's empty state reads from the top, so only a session starts pinned.
  // The first send pins the draft through runTurnLifecycle's scrollToBottom.
  const {
    contentRef: stickContentRef,
    scrollRef: stickScrollRef,
    isAtBottom,
    scrollToBottom,
  } = useStickToBottom({ initialStuck: Boolean(sessionId) });

  const [floorEl, setFloorEl] = useState<HTMLDivElement | null>(null);

  // The timeline rail measures against these two nodes, so they are held as
  // state rather than refs: its effect has to re-run once they mount. Both
  // callbacks forward to the stick-to-bottom hook, which owns them first. Its
  // refs are stable (useCallback with no deps), so these are too and React
  // never re-invokes them; the cost is one extra render on mount.
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      setScrollerEl(node);
      stickScrollRef(node);
    },
    [stickScrollRef],
  );
  const attachContent = useCallback(
    (node: HTMLElement | null) => {
      setContentEl(node);
      stickContentRef(node);
    },
    [stickContentRef],
  );

  // What was unread when this Concierge chat opened. It stays put while the
  // chat is open, so the divider outlives the read mark and ignores arrivals.
  const {
    unread: unreadAtOpen,
    noteOpened,
    noteOlder,
    noteLive,
    pendingMark,
  } = useUnreadAtOpen({ chatId: sessionId, loadReadMark });
  const onOlderPage = useCallback(
    (id: string, page: ChatMessage[]) => {
      if (id === mainSessionIdRef.current) noteOlder(page);
    },
    [noteOlder],
  );

  // The main session loads its newest turns first and pages older ones in as
  // the transcript scrolls toward the top.
  const {
    setCursor: setOlderCursor,
    hasOlder,
    sentinelRef: olderSentinelRef,
    loadOlder,
  } = useOlderMessages(mainSessionId || null, {
    pageTurns,
    scroller: scrollerEl,
    pinned: isAtBottom,
    setMessages,
    onOlderPage,
  });

  // The view derivation lives in the pure `buildChatView`; here we just memoize
  // it on the message map, so a streaming turn (which never touches
  // `messages`) never recomputes.
  const mainIdentity = useMemo<AgentIdentity>(
    () => ({
      name: pinnedAgentMention
        ? prettyAgentName(pinnedAgentMention.agentName)
        : resolveMainAgentDisplayName(mainAgentDisplayName, t("roles.agent")),
      iconUrl: pinnedAgentMention?.iconUrl ?? null,
    }),
    [mainAgentDisplayName, pinnedAgentMention, t],
  );
  // A draft builds from the empty id: the view is empty and `activeSessionId`
  // is falsy, which every session-keyed effect below already skips.
  const view = useMemo(
    () => buildChatView(messages, mainSessionId ?? "", mainIdentity),
    [messages, mainSessionId, mainIdentity],
  );
  const { displayMessages, identityBySession, interactionResults } = view;
  const olderRemains = mainSessionId ? hasOlder(mainSessionId) : false;
  const unread = useMemo(
    () => (unreadAtOpen ? summarizeUnread(displayMessages, unreadAtOpen, olderRemains) : null),
    [displayMessages, unreadAtOpen, olderRemains],
  );
  // The main session's id, empty while a draft has none. Keys the running turn
  // and live stream (send, stop, reattach, live trace, onSessionMessage).
  const activeSessionId = mainSessionId ?? "";
  // A fork chat promoted to a chat still runs on its branch (#1384), whose
  // model the picker does not hold.
  const chatModelPickable = !!mainSessionId && !isForkChat;

  // Ordered, unique turn ids of the main session — the selectable share unit.
  const mainTurnIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const m of displayMessages) {
      if (m.sessionId !== mainSessionId || !m.turnId || seen.has(m.turnId)) continue;
      seen.add(m.turnId);
      ids.push(m.turnId);
    }
    return ids;
  }, [displayMessages, mainSessionId]);

  // The timeline rail's data source. Memoized on displayMessages, which a
  // streaming turn never touches, so this identity is stable across stream
  // ticks and the rail's effect does not tear down and re-observe every frame.
  const timelineQuestions = useMemo(
    () => buildTimelineQuestions(displayMessages),
    [displayMessages],
  );

  const landingTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(landingTimerRef.current), []);
  // Tints a message's row for a moment, so the eye finds it.
  const landOn = useCallback((scroller: HTMLElement, anchor: HTMLElement) => {
    window.clearTimeout(landingTimerRef.current);
    for (const el of scroller.querySelectorAll("[data-timeline-landed]")) {
      if (el !== anchor) el.removeAttribute("data-timeline-landed");
    }
    playLanding(anchor);
    landingTimerRef.current = window.setTimeout(() => {
      anchor.removeAttribute("data-timeline-landed");
    }, LANDING_MS);
  }, []);

  // Scrolls `anchor` to the top of the transcript.
  const scrollToAnchor = useCallback((scroller: HTMLElement, anchor: HTMLElement) => {
    const top =
      anchor.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    // A jump that follows loading older pages comes long after the click, so
    // the pin would read it as drift and snap back to the bottom.
    anchor.dispatchEvent(new Event(HOLD_STICK_EVENT, { bubbles: true }));
    // `auto`, not `smooth`, and deliberately so. use-stick-to-bottom treats a
    // scroll outside its 300ms user-gesture window as accidental drift and
    // snaps back to the bottom while pinned; an instant scroll emits its one
    // event on the frame right after this click's pointerdown, safely inside
    // that window, so the hook releases the pin for us. A smooth scroll's
    // later frames fall outside it. Instant also reads better here: you land
    // and start reading rather than watching half a second of blur.
    // The scroller's own scroll padding keeps it clear of what floats over
    // the messages, such as a Concierge chat's header; a manual scroll does
    // not apply it, so it is added here.
    const clear = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    scroller.scrollTo({
      top: Math.max(top - clear - TIMELINE_JUMP_OFFSET_PX, 0),
      behavior: "auto",
    });
  }, []);

  // Scrolls to a message and tints it. An anchor names one message id, or
  // every id of an agent turn separated by spaces.
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const scroller = scrollerEl;
      if (!scroller) return;
      const anchor = findMessageAnchor(scroller, messageId);
      if (!anchor) return;
      scrollToAnchor(scroller, anchor);

      // Every user bubble is the same tint, so without this you cannot tell
      // whether the jump landed on the question you picked.
      landOn(scroller, anchor);
    },
    [scrollerEl, landOn, scrollToAnchor],
  );

  // Brings a message back into view after the thread view opened from it
  // closes, and tints it, so the reader finds where they were. A message
  // still in view only gets the tint.
  const revealMessage = useCallback(
    (messageId: string) => {
      const scroller = scrollerEl;
      const anchor = scroller ? findMessageAnchor(scroller, messageId) : null;
      if (!scroller || !anchor) return;
      const box = scroller.getBoundingClientRect();
      const clear = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
      const bottom = floorEl
        ? Math.min(box.bottom, floorEl.getBoundingClientRect().top)
        : box.bottom;
      if (isAnchorInView(anchor.getBoundingClientRect(), { top: box.top + clear, bottom })) {
        landOn(scroller, anchor);
      } else {
        jumpToMessage(messageId);
      }
    },
    [scrollerEl, floorEl, landOn, jumpToMessage],
  );

  // Respond in the Tasks panel points to a Concierge message that may sit
  // pages above the loaded ones, so the jump reads history down through it in
  // one page; the unread divider pages older history in until it renders.
  const olderRef = useRef({ hasOlder, loadOlder });
  olderRef.current = { hasOlder, loadOlder };
  const shownCountRef = useRef(0);
  useEffect(() => {
    shownCountRef.current = displayMessages.length;
  }, [displayMessages]);
  const findingMessageRef = useRef(false);
  // Pages older history in until `find` returns an element, then hands it to
  // `reveal`, or says `missing` when the search runs out. With `through`, the
  // message it looks for, one read brings the history down to it instead of
  // a page at a time. Only one search runs at a time. Resolves whether it
  // revealed it.
  const revealWhenLoaded = useCallback(
    async (
      find: () => HTMLElement | null,
      reveal: () => void,
      missing: string,
      through?: string,
    ): Promise<boolean> => {
      if (!mainSessionId || findingMessageRef.current) return false;
      if (find()) {
        reveal();
        return true;
      }
      findingMessageRef.current = true;
      const loading = toast.loading(t("concierge.tasks.findingMessage"));
      try {
        let stalled = 0;
        for (let page = 0; page < (through ? 1 : MAX_JUMP_PAGES); page++) {
          if (!olderRef.current.hasOlder(mainSessionId)) break;
          const before = shownCountRef.current;
          await olderRef.current.loadOlder(mainSessionId, through ? { through } : undefined);
          // The page lands in state first and renders a moment later.
          for (let wait = 0; wait < 40 && shownCountRef.current === before; wait++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (find()) {
            reveal();
            return true;
          }
          // A page that fails to load changes nothing; two in a row end the search.
          stalled = shownCountRef.current === before ? stalled + 1 : 0;
          if (stalled >= 2) break;
        }
        toast.error(missing);
        return false;
      } finally {
        toast.dismiss(loading);
        findingMessageRef.current = false;
      }
    },
    [mainSessionId, t],
  );
  const showSourceMessage = useCallback(
    (messageId: string) => {
      const scroller = scrollerEl;
      if (!scroller) return Promise.resolve(false);
      return revealWhenLoaded(
        () => findMessageAnchor(scroller, messageId),
        () => jumpToMessage(messageId),
        t("concierge.tasks.sourceMissing"),
        messageId,
      );
    },
    [scrollerEl, revealWhenLoaded, jumpToMessage, t],
  );
  // The unread divider's pill: scrolls to the divider, paging in older
  // messages first when it is still on one.
  const showUnreadDivider = useCallback(() => {
    const scroller = scrollerEl;
    if (!scroller) return;
    const find = () => scroller.querySelector<HTMLElement>("[data-concierge-unread-divider]");
    void revealWhenLoaded(
      find,
      () => {
        const divider = find();
        if (divider) scrollToAnchor(scroller, divider);
      },
      t("concierge.newMessagesMissing"),
    );
  }, [scrollerEl, revealWhenLoaded, scrollToAnchor, t]);
  useEffect(() => {
    if (!concierge) return;
    return onConciergeJump(showSourceMessage);
  }, [concierge, showSourceMessage]);

  const displayedMessageIds = useMemo(
    () => new Set(displayMessages.map((message) => message.id)),
    [displayMessages],
  );
  const replyDraft = useReplyDraftState({
    chatId: mainSessionId ?? undefined,
    sessionId: mainSessionId ?? null,
    messageIds: displayedMessageIds,
    jump: jumpToMessage,
    focusComposer: () => composerRef.current?.focus(),
    // A Concierge chat keeps chat threads. Only a thread label opens the
    // thread view; Reply opens the reply bar alone.
    threads: concierge,
  });

  // Share chat picks every turn in a common chat. A Concierge chat holds its
  // owner's private history, so there it starts with none picked.
  const enterShareMode = useCallback(() => {
    setSelectedShareTurns(new Set(concierge ? [] : mainTurnIds));
    setShareMode(true);
  }, [concierge, mainTurnIds]);

  // Share on a message: the same share mode, with only that message's turn
  // selected. A message outside the chat's own turns selects nothing. Read
  // through the ref so the shortcut keeps one identity while messages arrive.
  // From the thread view, the view closes first: share mode picks turns in the
  // chat's own timeline, which the view covers.
  const { thread: openThreadId, closeThread } = replyDraft;
  const shareMessageTurn = useCallback(
    (messageId: string, turn?: SharedMessageTurn) => {
      if (openThreadId) closeThread();
      // The loaded timeline first; else the turn the message's own view knows,
      // for an older thread message the timeline has not loaded.
      const turnId = mainSessionId
        ? (messagesRef.current.get(mainSessionId)?.find((m) => m.id === messageId)?.turnId ??
          (turn?.sessionId === mainSessionId ? turn.turnId : undefined))
        : undefined;
      setSelectedShareTurns(new Set(turnId ? [turnId] : []));
      setShareMode(true);
    },
    [mainSessionId, openThreadId, closeThread],
  );

  const exitShareMode = useCallback(() => {
    setShareMode(false);
    setSelectedShareTurns(new Set());
  }, []);

  const toggleShareTurn = useCallback((turnId: string) => {
    setSelectedShareTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  // The mobile "⋯" menu lives in FreeGrid's header, not here, so it kicks the
  // share flow over the workspace event bus.
  useEffect(() => {
    if (!workspaceEventBus) return;
    return workspaceEventBus.on("share:start", () => enterShareMode());
  }, [workspaceEventBus, enterShareMode]);

  // Leaving the chat drops any in-progress selection.
  useEffect(() => {
    setShareMode(false);
    setSelectedShareTurns(new Set());
  }, [mainSessionId]);
  useEffect(() => {
    mainSessionIdRef.current = mainSessionId;
  }, [mainSessionId]);

  // A message shows its sender before the server has it, so the signed-in
  // person's avatar appears on their bubble as they send.
  const { data: viewer } = useDashboardIdentity();
  const viewerSenderRef = useRef(senderFromIdentity(viewer));
  useEffect(() => {
    viewerSenderRef.current = senderFromIdentity(viewer);
  }, [viewer]);
  const isReadVisibleSession = useCallback((id: string) => id === mainSessionIdRef.current, []);
  const activeSessionStream = streamingSessions.get(activeSessionId) ?? null;
  // The `turnId` the stream was opened under addresses the follower and Stop.
  // The transcript matches the turn by its runningTurnId, which differs for a
  // backend task.
  const activeStreamTurnId = activeSessionStream?.turnId ?? null;
  const runningTurnId = runningTurnIdOf(activeSessionStream);
  // A reattached turn has no replayed snapshot yet, but its saved trace is
  // already in the transcript. The live row replaces that trace, so it starts
  // from the saved summary instead of an empty bubble; the replay then fills in
  // the segments and `summary_update` replaces the summary. Derived at render
  // so it holds whichever of the messages and the turn lookup lands first.
  const streamSnapshot = activeSessionStream?.snapshot ?? null;
  const savedSummary = streamSnapshot
    ? null
    : savedTraceSummary(messages.get(activeSessionId), runningTurnId);
  const currentSnapshot = useMemo<TraceSnapshot | null>(
    () => streamSnapshot ?? (savedSummary ? { segments: [], summary: savedSummary } : null),
    [streamSnapshot, savedSummary],
  );
  const isActiveSessionStreaming = !!activeSessionStream;
  const awaitingGuardian = useMemo(
    () => isAwaitingGuardian(view, runningTurnId),
    [view, runningTurnId],
  );
  const lockedByCard = useMemo(() => isLockedByCard(view, runningTurnId), [view, runningTurnId]);
  const currentReplyMessageIds = useMemo(
    () => new Set(currentReplyMessages(view, runningTurnId).map((message) => message.id)),
    [view, runningTurnId],
  );

  const lastTurnFailed = useMemo(() => isLastTurnFailed(view), [view]);
  // The latest assistant text block. The live row follows it (and smooths it
  // into typing, see LiveTail); the chat does not render for it.
  const liveTextStore = liveTextOf(activeSessionId);

  // Pull host callbacks through refs so the many internal `useCallback`s
  // depending on them don't need to re-create whenever the host swaps in a
  // fresh handler.
  const onSessionsChangedRef = useRef(onSessionsChanged);
  const onSessionNotFoundRef = useRef(onSessionNotFound);
  const onSessionMessageRef = useRef(onSessionMessage);
  const onSessionLayoutRef = useRef(onSessionLayout);
  const recoverMissingSessionRef = useRef(recoverMissingSession);
  recoverMissingSessionRef.current = recoverMissingSession;
  useEffect(() => {
    onSessionsChangedRef.current = onSessionsChanged;
  }, [onSessionsChanged]);
  useEffect(() => {
    onSessionNotFoundRef.current = onSessionNotFound;
    return () => {
      // A late 404 from a chat we left must not redirect the current page.
      onSessionNotFoundRef.current = undefined;
    };
  }, [onSessionNotFound]);
  useEffect(() => {
    onSessionMessageRef.current = onSessionMessage;
  }, [onSessionMessage]);
  useEffect(() => {
    onSessionLayoutRef.current = onSessionLayout;
  }, [onSessionLayout]);
  const notifySessionsChanged = useCallback(() => {
    onSessionsChangedRef.current?.();
  }, []);

  const createTurnStreamController = useCallback((turnId: string) => {
    turnStreamControllersRef.current.get(turnId)?.abort();
    const controller = new AbortController();
    turnStreamControllersRef.current.set(turnId, controller);
    return controller;
  }, []);

  const releaseTurnStreamController = useCallback((turnId: string, controller: AbortController) => {
    if (turnStreamControllersRef.current.get(turnId) === controller) {
      turnStreamControllersRef.current.delete(turnId);
    }
  }, []);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      for (const controller of turnStreamControllersRef.current.values()) {
        controller.abort();
      }
      turnStreamControllersRef.current.clear();
    };
  }, []);

  // A chat that changes while its tab is hidden stays unread, so the sidebar
  // and other devices show it as new until the guardian comes back.
  const hiddenReadsRef = useRef(new Set<string>());
  const markSessionRead = useCallback(
    async (id: string) => {
      // Marking the chat read first would erase the read mark the divider needs.
      const waiting = pendingMark();
      if (waiting) {
        await waiting;
        // The chat may have closed, or moved on, while it waited. A read mark
        // then would clear messages the guardian never saw.
        if (!isMountedRef.current || id !== mainSessionIdRef.current) return;
      }
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        hiddenReadsRef.current.add(id);
        return;
      }
      try {
        await apiMarkSessionRead(id);
        notifySessionsChanged();
      } catch {
        // Best effort. The next successful active-session load can retry.
      }
    },
    [notifySessionsChanged, pendingMark],
  );
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") return;
      const ids = [...hiddenReadsRef.current];
      hiddenReadsRef.current.clear();
      for (const id of ids) void markSessionRead(id);
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [markSessionRead]);

  // Delete the current chat from the navbar's "⋯" menu, then refresh the
  // sidebar list and drop back to a fresh chat. `stopWork` ends a topic
  // chat's follows and open tasks instead of moving them to the main chat.
  const handleDeleteSession = useCallback(
    async (stopWork?: boolean) => {
      setDeleteConfirmOpen(false);
      if (!mainSessionId) return;
      try {
        if (stopWork) await deleteSession(mainSessionId, { followsAndTasks: "stop" });
        else await deleteSession(mainSessionId);
      } catch {
        // best-effort — the list refresh below reconciles either way
      }
      notifySessionsChanged();
      navigate(MAIN_CHAT_PATH);
    },
    [mainSessionId, notifySessionsChanged, navigate],
  );

  // Archive (read-only soft-hide) or restore the current chat. Archiving does
  // not navigate away — the transcript stays open, read-only. The override flips
  // the composer immediately; the sidebar reconciles via the changed event.
  const handleArchive = useCallback(async () => {
    if (!mainSessionId) return;
    setArchivedOverride(true);
    try {
      // Archive mutation PATCHes and broadcasts the sessions-changed event.
      await setArchived(mainSessionId, true);
    } catch {
      setArchivedOverride(false);
    }
  }, [mainSessionId, setArchived]);

  const handleUnarchive = useCallback(async () => {
    if (!mainSessionId) return;
    setArchivedOverride(false);
    try {
      await setArchived(mainSessionId, false);
    } catch {
      setArchivedOverride(true);
    }
  }, [mainSessionId, setArchived]);

  useEffect(() => {
    onSessionMessageRef.current?.({ sessionId: activeSessionId, turnId: activeStreamTurnId });
  }, [activeStreamTurnId, activeSessionId]);

  // Fetch messages for a session
  const loadMessages = useCallback(
    async (id: string, options: { force?: boolean; dropLocalOptimistic?: boolean } = {}) => {
      if (!options.force && loadedSessionsRef.current.has(id)) return;
      // Only mark loaded once we have data in hand. Marking before the await
      // permanently suppressed retries on any failure — the user would land in
      // a silently-empty chat with no recovery short of a page refresh.
      // The local rows a fetch may stand in for are the ones sent before it
      // asked. A row sent while it is on the way is newer than the page it
      // brings, so it stays until a later fetch holds it.
      const localBeforeFetch = options.dropLocalOptimistic
        ? new Set(localOptimisticMessageIdsRef.current.get(id) ?? [])
        : undefined;
      try {
        const fetchPage = () => listSessionMessagePage(id, { limit: pageTurns });
        let page = await fetchPage();
        if (page === null && (await recoverMissingSessionRef.current?.(id)))
          page = await fetchPage();
        if (page === null) {
          // Server says this session doesn't exist (HTTP 404). Hand it back
          // to the host so they can redirect to the draft surface instead of
          // leaving the user staring at an empty active-chat shell.
          onSessionNotFoundRef.current?.(id);
          return;
        }
        const fetchedMessages = orderChatMessages(page.messages);
        const restart = startsNewHistory(messagesRef.current.get(id) ?? [], {
          messages: fetchedMessages,
          hasOlder: page.nextCursor !== null,
        });
        if (fetchedMessages.some((message) => message.traceArchived))
          traceArchivedSessionsRef.current.add(id);
        else traceArchivedSessionsRef.current.delete(id);
        const dropMessageIds = localBeforeFetch;
        const commitMessages = () =>
          setMessages((prev) => {
            const next = new Map(prev);
            next.set(
              id,
              mergeLatestMessagePage(next.get(id) ?? [], fetchedMessages, {
                restart,
                dropMessageIds,
              }),
            );
            return next;
          });
        const handLayoutToHost = onSessionLayoutRef.current;
        if (handLayoutToHost && !loadedSessionsRef.current.has(id)) {
          // The host's layout store re-renders synchronously while this state
          // update is not, so flush both together: the tool panel and the
          // messages then appear in one frame instead of reflowing the chat.
          flushSync(() => {
            commitMessages();
            handLayoutToHost(id, page.layout ?? null);
          });
        } else {
          commitMessages();
        }
        // A refetch of the newest page leaves older loaded pages, and the
        // cursor that reaches past them, as they are.
        if (!loadedSessionsRef.current.has(id) || restart) setOlderCursor(id, page.nextCursor);
        if (localBeforeFetch) {
          const local = localOptimisticMessageIdsRef.current.get(id);
          for (const messageId of localBeforeFetch) local?.delete(messageId);
          if (local?.size === 0) localOptimisticMessageIdsRef.current.delete(id);
        }
        if (!loadedSessionsRef.current.has(id) && isReadVisibleSession(id)) {
          noteOpened(fetchedMessages);
        }
        loadedSessionsRef.current.add(id);
        if (isReadVisibleSession(id)) {
          void markSessionRead(id);
        }
      } catch {
        // Leave the session unmarked so callers (auto-load + post-stream
        // refresh) can retry on the next trigger.
      }
    },
    [isReadVisibleSession, markSessionRead, noteOpened, pageTurns, setOlderCursor],
  );

  // A new message reactivates every turn's steps. Fetch server truth once,
  // rather than waiting for the new turn to finish or guessing the cutoff here.
  const refreshArchivedSession = useCallback(
    (sid: string) => {
      if (traceArchivedSessionsRef.current.delete(sid)) void loadMessages(sid, { force: true });
    },
    [loadMessages],
  );

  // Load messages when the main session changes (also covers initial mount).
  useEffect(() => {
    if (mainSessionId) {
      loadMessages(mainSessionId);
    }
  }, [mainSessionId, loadMessages]);

  // Subscribe to the main session's events through useLiveEvents.
  const sessionEventIds = useMemo(() => (mainSessionId ? [mainSessionId] : []), [mainSessionId]);
  const handleMessageInsert = useCallback(
    (sid: string, message: ChatMessage) => {
      if (message.sessionId !== sid) return;
      noteLive(message.id);
      setMessages((prev) => {
        const next = new Map(prev);
        const existing = next.get(sid) ?? [];
        next.set(sid, mergeChatMessage(existing, message));
        return next;
      });
      refreshArchivedSession(sid);
      void markSessionRead(sid);
      onSessionMessageRef.current?.({ sessionId: sid, turnId: message.turnId ?? null });
    },
    [markSessionRead, noteLive, refreshArchivedSession],
  );
  const handleSessionName = useCallback(
    (sid: string, event: z.infer<typeof sessionNameSchema>) => {
      if (event.sessionId === sid && event.name) notifySessionsChanged();
    },
    [notifySessionsChanged],
  );
  const resyncSessionMessages = useCallback(
    (sid: string) => {
      void loadMessages(sid, { force: true });
    },
    [loadMessages],
  );

  // On session switch, snap to the bottom and re-engage stickiness. Ongoing
  // growth (streaming text, late media) is followed by the hook's ResizeObserver
  // — no per-render scroll effect needed.
  useEffect(() => {
    if (mainSessionId) scrollToBottom("auto");
  }, [mainSessionId, scrollToBottom]);

  const consumeStream = useCallback(
    // Resolves true once the turn reported a terminal event (`done` or
    // `stream_error`); false means the transport ended first.
    async (res: Response, sessionId: string, turnId: string): Promise<boolean> => {
      if (!res.body) {
        setStreamError(t("stream.errors.emptyStream"));
        return false;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Live snapshot mirror: server emits segment_upsert + summary_update;
      // we upsert by id and replace the summary. Insertion order in segArr
      // matches the server's segment ordinals because the server emits each
      // segment's first upsert in ordinal order.
      const segArr: TraceSegment[] = [];
      const segIdx = new Map<string, number>();
      // The last `summary_update`. Until one arrives, a reattached turn keeps
      // its saved summary, looked up at each flush because the transcript may
      // still be loading when the stream opens.
      let replayedSummary: TraceSnapshot["summary"] | null = null;
      const flushSnapshot = () => {
        const summary = replayedSummary ??
          savedTraceSummary(
            messagesRef.current.get(sessionId),
            runningTurnIdOf(streamingSessionsRef.current.get(sessionId)) ?? turnId,
          ) ?? {
            distinctApps: [],
            totalSteps: 0,
            invocationCounts: {},
          };
        updateSessionSnapshot(sessionId, turnId, { segments: segArr.slice(), summary });
      };
      let shouldStop = false;

      while (!shouldStop) {
        // Stall watchdog: race each read against the keepalive-derived
        // timeout. A silently-dead connection (the mobile failure mode)
        // never rejects the read — it just stops delivering bytes — so
        // without this the loop hangs forever and the session's streaming
        // entry is never released.
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<"stalled">((resolve) => {
            stallTimer = setTimeout(() => resolve("stalled"), STREAM_STALL_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(stallTimer));
        if (result === "stalled") {
          // Dead connection. Release the reader; followTurn reopens the
          // same turn's stream.
          void reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = result;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Trim the buffer to the last complete event boundary BEFORE parsing,
        // so a partial trailing event doesn't fire early (e.g. a half-arrived
        // `done` flipping `shouldStop`).
        const lastDoubleNewline = buffer.lastIndexOf("\n\n");
        let completed = "";
        if (lastDoubleNewline !== -1) {
          completed = buffer.slice(0, lastDoubleNewline + 2);
          buffer = buffer.slice(lastDoubleNewline + 2);
        }
        const events = parseSSEEvents(completed);

        for (const evt of events) {
          if (evt.event === "done") {
            try {
              const payload = JSON.parse(evt.data) as DoneEventData;
              // Model-resolution failures are persisted as assistant error
              // messages, so they render once in the conversation rather than
              // being duplicated above the composer.
              // The composer banner belongs to the chat's own turn, as for
              // reconnect errors below; a background turn's failure stays off it.
              if (
                !payload.success &&
                payload.error &&
                !isModelResolutionErrorCode(payload.code) &&
                sessionId === mainSessionIdRef.current
              ) {
                setStreamError({
                  message: payload.error,
                  ...(payload.code ? { code: payload.code } : {}),
                  ...(payload.provider ? { provider: payload.provider } : {}),
                  ...(payload.reason ? { reason: payload.reason } : {}),
                });
              }
            } catch {
              // ignore parse errors
            }
            if (isReadVisibleSession(sessionId)) setTurnEnds((n) => n + 1);
            shouldStop = true;
            break;
          }
          if (evt.event === "stream_error") {
            try {
              const payload = JSON.parse(evt.data) as Partial<DoneEventData>;
              if (
                payload.error &&
                !isModelResolutionErrorCode(payload.code) &&
                sessionId === mainSessionIdRef.current
              ) {
                setStreamError({
                  message: payload.error,
                  ...(payload.code ? { code: payload.code } : {}),
                  ...(payload.provider ? { provider: payload.provider } : {}),
                  ...(payload.reason ? { reason: payload.reason } : {}),
                });
              }
            } catch {
              // ignore parse errors
            }
            if (isReadVisibleSession(sessionId)) setTurnEnds((n) => n + 1);
            shouldStop = true;
            break;
          }
          if (evt.event === "segment_upsert") {
            try {
              const seg = JSON.parse(evt.data) as TraceSegment;
              const existing = segIdx.get(seg.id);
              if (existing !== undefined) {
                segArr[existing] = seg;
              } else {
                segIdx.set(seg.id, segArr.length);
                segArr.push(seg);
              }
              flushSnapshot();
              // Only the chat's own turn drives the host's workspace follow. A
              // background turn keeps its own trace without retargeting the host.
              if (sessionId === mainSessionIdRef.current) {
                onSessionMessageRef.current?.({ sessionId, turnId, segment: seg });
              }
            } catch {
              // ignore parse errors
            }
            continue;
          }
          if (evt.event === "summary_update") {
            try {
              replayedSummary = JSON.parse(evt.data) as TraceSnapshot["summary"];
              flushSnapshot();
            } catch {
              // ignore parse errors
            }
            continue;
          }
          if (evt.event === "assistant_text") {
            // Live preview of the latest assistant text block. The server
            // sends the block's accumulated text (not a delta) plus the
            // block's index within the turn; each event replaces the
            // previous one, and a higher blockIx replaces the block.
            try {
              const { blockIx, text } = JSON.parse(evt.data) as {
                blockIx?: number;
                text?: string;
              };
              updateSessionAssistantText(sessionId, turnId, blockIx ?? 0, text ?? "");
            } catch {
              // ignore parse errors
            }
            continue;
          }
          if (evt.event === "input_status") {
            try {
              const status = JSON.parse(
                evt.data,
              ) as import("@rome/api-types/trace-segments").InputStatusEvent;
              // An input from another caller has no local optimistic row. Load its
              // durable sender before first paint, without waiting for the reply.
              if (
                !(messagesRef.current.get(sessionId) ?? []).some(
                  (message) => message.id === status.inputId,
                )
              ) {
                void loadMessages(sessionId, { force: true });
              }
              setMessages((prev) => {
                const next = new Map(prev);
                next.set(
                  sessionId,
                  (prev.get(sessionId) ?? []).map((message) =>
                    message.id === status.inputId
                      ? { ...message, inputState: status.state, turnId: status.turnId }
                      : message,
                  ),
                );
                return next;
              });
            } catch {
              /* Reconnection reloads the durable input state. */
            }
            continue;
          }
          if (evt.event === "turn_id") {
            // A backend task names the agent turn it runs. The entry keeps the
            // `turnId` its stream was opened under; the transcript matches the
            // turn by this id.
            try {
              const { turnId: agentTurnId } = JSON.parse(evt.data) as { turnId?: string };
              if (agentTurnId) adoptSessionAgentTurn(sessionId, turnId, agentTurnId);
            } catch {
              // ignore parse errors
            }
            continue;
          }
          if (evt.event === "session_status") {
            // SSE-driven status lets the UI flip the
            // Send/Stop button without polling /stream-status.
            // No-op for now beyond letting it pass through; the per-session
            // streaming entry flips via locally-tracked send/stop.
            continue;
          }
          if (evt.event === "widget_placement") {
            // An action returned `place_widget`: mount the app's widget on the
            // freegrid without parking the agent. Placement keys by appId, so a
            // repeat placement retargets the existing tile (to the new
            // route/params) in place rather than stacking duplicates, and a
            // replayed `placementId` the layout already applied is skipped.
            try {
              const { placementId, appId, route, params } = JSON.parse(evt.data) as {
                placementId?: string;
                appId?: string;
                route?: string;
                params?: Record<string, string | number | boolean>;
              };
              // The chat's own turn owns the workspace; a background turn's
              // replayed placement would remount (and reset) a widget in use.
              if (appId && sessionId === mainSessionIdRef.current) {
                applyAgentPlacement(placementId, appId, route, params);
              }
            } catch {
              // ignore parse errors
            }
            continue;
          }
        }
      }

      return shouldStop;
    },
    [
      t,
      streamingSessionsRef,
      updateSessionSnapshot,
      updateSessionAssistantText,
      adoptSessionAgentTurn,
      isReadVisibleSession,
    ],
  );

  // Follow one turn to its end. A dropped SSE connection (mobile background,
  // network swap, stall) is not a turn outcome, so the live entry stays up and
  // the same turn's stream is reopened. The server replays a turn's stream —
  // including its terminal `done` for 30 s after it ends — and 404s once the
  // turn is gone, so each retry gets a definitive answer. Settlement is keyed
  // to this turnId: if Stop or a newer turn took the entry over, we just leave.
  // The persisted answer loads before the live preview is released.
  const followTurn = useCallback(
    async (sessionId: string, turnId: string): Promise<void> => {
      const ownsEntry = () =>
        isMountedRef.current && streamingSessionsRef.current.get(sessionId)?.turnId === turnId;
      let delayMs = TURN_RESUME_BASE_DELAY_MS;
      let shownError: string | null = null;
      let controller: AbortController;
      for (;;) {
        controller = createTurnStreamController(turnId);
        try {
          const res = await openTurnStream(turnId, controller.signal);
          if (res.status === 404) break;
          if (res.ok && res.body) {
            if (shownError) {
              const cleared = shownError;
              setStreamError((current) => (current === cleared ? null : current));
              shownError = null;
            }
            const openedAt = Date.now();
            if (await consumeStream(res, sessionId, turnId)) break;
            // Retry fast after a connection that held; keep backing off when
            // streams keep closing right away.
            if (Date.now() - openedAt >= TURN_RESUME_MAX_DELAY_MS) {
              delayMs = TURN_RESUME_BASE_DELAY_MS;
            }
          } else if (sessionId === mainSessionIdRef.current) {
            // The composer banner belongs to the chat's own turn; a background
            // turn retries quietly.
            shownError = t("stream.errors.reconnectStatus", { status: res.status });
            setStreamError(shownError);
          }
        } catch {
          // Network blip or aborted reader: retry below.
        }
        // Hold the controller through the backoff so Stop's force-release or
        // unmount can still abort this follower. Both already settled the
        // turn, so an abort ends the follower at once; waiting out the
        // backoff would hold the send bookkeeping and swallow a new send.
        const { signal } = controller;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          const timer = setTimeout(resolve, delayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        releaseTurnStreamController(turnId, controller);
        if (signal.aborted) return;
        delayMs = Math.min(delayMs * 2, TURN_RESUME_MAX_DELAY_MS);
        if (!ownsEntry()) return;
      }
      releaseTurnStreamController(turnId, controller);
      if (!isMountedRef.current) return;
      await loadMessages(sessionId, { force: true, dropLocalOptimistic: true });
      endSessionStream(sessionId, turnId);
    },
    [
      consumeStream,
      createTurnStreamController,
      releaseTurnStreamController,
      loadMessages,
      endSessionStream,
      streamingSessionsRef,
      t,
    ],
  );

  // Reattach to the session's in-flight turn, so on reload the live preview
  // picks up where it left off.
  const pollTurns = useCallback(
    async (reattachSessionId: string, isCancelled: () => boolean): Promise<TurnPollOutcome> => {
      // Skip if the foreground send is mid-flight (locallyStreaming was added
      // before its POST, so it catches the window before its per-session
      // entry exists) or a prior reattach hasn't drained yet.
      if (
        locallyStreamingSessionIdsRef.current.has(reattachSessionId) ||
        streamingSessionsRef.current.has(reattachSessionId)
      ) {
        return "busy";
      }
      // List in-flight turns by turnId. Reattach to the running
      // one (or the first queued one) — its events stream is keyed by
      // turnId, so reattach is unambiguous even if more turns arrive
      // while we're polling.
      const turns = await listSessionTurns(reattachSessionId);
      if (!turns || turns.length === 0 || isCancelled()) return "idle";
      // A foreground send may have started while the lookup was in flight.
      // It already follows its turn; a second follower would fight it for
      // the stream controller.
      if (locallyStreamingSessionIdsRef.current.has(reattachSessionId)) return "busy";

      const target = turns.find((t) => t.status === "running") ?? turns[0];
      startSessionStream(reattachSessionId, target.turnId, target.quiet);
      // A backend turn already listed under its agent turn id hides its saved
      // trace from the first render, before the replayed `turn_id` arrives.
      if (target.agentTurnId) {
        adoptSessionAgentTurn(reattachSessionId, target.turnId, target.agentTurnId);
      }
      setStreamError(null);
      // Not cancelled with the poll: followTurn ends with its turn (or on
      // unmount), and the entry it holds pauses the poll meanwhile.
      await followTurn(reattachSessionId, target.turnId);
      return "followed";
    },
    [followTurn, startSessionStream, adoptSessionAgentTurn, streamingSessionsRef],
  );
  // A `session_running` event or a reconnect kicks the poll, so its timer is
  // only a fallback for a lost event.
  const kickTurnPoll = useTurnPoll(
    activeSessionId,
    { paused: isActiveSessionStreaming, revision: streamReconnectRevision },
    pollTurns,
  );
  const handleSessionRunning = useCallback(
    (event: z.infer<typeof sessionRunningSchema>) => {
      if (event.sessionId !== mainSessionIdRef.current) return;
      // A turn queued or ended with the chat still running is one to follow.
      if (event.running) kickTurnPoll();
      // The chat stopped: what its last turn left, such as an error, may have
      // come after the last read, and no message event announces it.
      else resyncSessionMessages(event.sessionId);
    },
    [kickTurnPoll, resyncSessionMessages],
  );
  // Events missed while the stream was down may include a turn's start.
  const handleSessionEventsReconnect = useCallback(
    (sid: string) => {
      setLiveReactions(new Map());
      setLiveCards(new Map());
      // The word before the drop may be stale; the server replays the latest
      // to the new subscription.
      setLiveWriting((prev) => {
        if (!prev.has(sid)) return prev;
        const next = new Map(prev);
        next.delete(sid);
        return next;
      });
      resyncSessionMessages(sid);
      if (sid === mainSessionIdRef.current) kickTurnPoll();
    },
    [resyncSessionMessages, kickTurnPoll],
  );

  // Shared lifecycle for "post a turn → attach SSE → consume" so both the
  // composer send and the inline app-component submit go through the same
  // bookkeeping (inflight turn set, optimistic user row, stream attach,
  // teardown). Callers supply the post payload + the optimistic user message
  // content (already JSON-serialized MessagePart[]).
  // DOMException("AbortError") from an aborted XHR/fetch; matched by name so
  // it survives the structured-clone boundaries these errors cross.
  const isAbortError = (err: unknown): boolean =>
    err instanceof DOMException ? err.name === "AbortError" : (err as Error)?.name === "AbortError";

  const runTurnLifecycle = useCallback(
    async (
      sendingSessionId: string,
      postTurn: () => Promise<PostTurnResult>,
      optimisticUserContent: string,
      // The client-minted input id, when the row may show before the POST
      // settles. The server keeps it as the message id, so the accepted row
      // replaces this one in place instead of mounting a second bubble.
      immediateInputId?: string,
    ): Promise<void> => {
      setStreamError(null);
      // Sending re-engages stickiness so the user follows their own message and
      // the reply, even if they'd scrolled up to read history.
      scrollToBottom("auto");
      const wasLocallyStreaming = locallyStreamingSessionIdsRef.current.has(sendingSessionId);
      locallyStreamingSessionIdsRef.current.add(sendingSessionId);
      const sentAt = new Date().toISOString();

      const putUserMessage = (message: ChatMessage, replacesId?: string) => {
        const localIds =
          localOptimisticMessageIdsRef.current.get(sendingSessionId) ?? new Set<string>();
        localIds.add(message.id);
        localOptimisticMessageIdsRef.current.set(sendingSessionId, localIds);
        setMessages((prev) => {
          const next = new Map(prev);
          const existing = (next.get(sendingSessionId) ?? []).filter((m) => m.id !== replacesId);
          next.set(sendingSessionId, mergeChatMessage(existing, message));
          return next;
        });
      };
      const dropImmediateMessage = () => {
        if (!immediateInputId) return;
        localOptimisticMessageIdsRef.current.get(sendingSessionId)?.delete(immediateInputId);
        setMessages((prev) => {
          const existing = prev.get(sendingSessionId);
          if (!existing?.some((m) => m.id === immediateInputId)) return prev;
          const next = new Map(prev);
          next.set(
            sendingSessionId,
            existing.filter((m) => m.id !== immediateInputId),
          );
          return next;
        });
      };
      if (immediateInputId) {
        putUserMessage({
          id: immediateInputId,
          sessionId: sendingSessionId,
          turnId: null,
          inputState: "submitted",
          role: "user",
          content: optimisticUserContent,
          createdAt: sentAt,
          sender: viewerSenderRef.current,
        });
      }

      // The POST result is the acceptance boundary. Whether the composer clears
      // or restores the user's input hinges on this result alone — never on the
      // SSE stream's fate. A turn the server
      // accepted is submitted, full stop; a stream that drops afterwards must
      // not reject back to the composer and bounce the already-sent text into
      // the textarea (the original bug). So a failed submit rejects here; a
      // dropped stream never does.
      const result = await postTurn().catch((err: unknown) => {
        // Transport failure posting the turn — a genuine failed submit.
        dropImmediateMessage();
        if (!wasLocallyStreaming) locallyStreamingSessionIdsRef.current.delete(sendingSessionId);
        setStreamReconnectRevision((revision) => revision + 1);
        // A cancelled attachment upload is a deliberate act, not a failure:
        // the composer already restored the draft, so an error banner would
        // just be noise about something the user chose.
        if (!isAbortError(err)) setStreamError(t("stream.errors.sendInvalidResponse"));
        throw err;
      });
      if (!result.ok) {
        dropImmediateMessage();
        if (!wasLocallyStreaming) locallyStreamingSessionIdsRef.current.delete(sendingSessionId);
        setStreamReconnectRevision((revision) => revision + 1);
        const message =
          result.message ||
          (result.status === 0
            ? t("stream.errors.sendInvalidResponse")
            : t("stream.errors.sendStatus", { status: result.status }));
        setStreamError({
          message,
          ...(result.code ? { code: result.code } : {}),
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
        throw new Error(result.message || `post turn failed (${result.status})`);
      }

      refreshArchivedSession(sendingSessionId);
      const createResp: CreateTurnResponse = result.data;
      const pendingTurnId = createResp.turnId;
      const turnsForSession = inflightTurnsRef.current.get(sendingSessionId) ?? new Set<string>();

      const userMsg: ChatMessage = {
        id: createResp.inputId ?? immediateInputId ?? randomUUID(),
        sessionId: sendingSessionId,
        turnId: pendingTurnId,
        inputState: createResp.inputState ?? (createResp.inputId ? "queued" : undefined),
        role: "user",
        content: optimisticUserContent,
        createdAt: sentAt,
        sender: viewerSenderRef.current,
      };
      putUserMessage(userMsg, immediateInputId);

      // Appending input does not own a second stream or replace the live tail.
      // Late follow-up turns are discovered by the existing reattach loop.
      if (turnsForSession.size || streamingSessionsRef.current.has(sendingSessionId)) {
        if (!turnsForSession.size) locallyStreamingSessionIdsRef.current.delete(sendingSessionId);
        return;
      }
      if (!pendingTurnId) {
        locallyStreamingSessionIdsRef.current.delete(sendingSessionId);
        setStreamReconnectRevision((revision) => revision + 1);
        return;
      }
      turnsForSession.add(pendingTurnId);
      inflightTurnsRef.current.set(sendingSessionId, turnsForSession);
      startSessionStream(sendingSessionId, pendingTurnId);

      // The turn is already submitted, so a failed attach or a mid-stream drop
      // must never reject this function — that rejection is what used to
      // restore the already-sent input. followTurn rides out dropped
      // connections and settles only when the turn itself ends.
      void (async () => {
        try {
          await followTurn(sendingSessionId, pendingTurnId);
        } finally {
          const turns = inflightTurnsRef.current.get(sendingSessionId);
          if (turns) {
            turns.delete(pendingTurnId);
          }
          const currentEntry = streamingSessionsRef.current.get(sendingSessionId);
          if (currentEntry?.turnId === pendingTurnId) {
            const remaining = turns ? Array.from(turns) : [];
            const next = remaining[0];
            if (next) {
              startSessionStream(sendingSessionId, next);
            }
          }
          if (!turns || turns.size === 0) {
            inflightTurnsRef.current.delete(sendingSessionId);
            locallyStreamingSessionIdsRef.current.delete(sendingSessionId);
            setStreamReconnectRevision((revision) => revision + 1);
            endSessionStream(sendingSessionId, pendingTurnId);
          }
        }
      })();
    },
    [
      followTurn,
      endSessionStream,
      startSessionStream,
      streamingSessionsRef,
      t,
      scrollToBottom,
      refreshArchivedSession,
    ],
  );

  // Send a turn into the active session. The composer owns the input state
  // (text/uploads/options); this handler builds the POST and delegates the
  // turn lifecycle to runTurnLifecycle.
  //
  // The session decides whether input joins the active run or starts the next.
  const handleComposerSend = useCallback(
    async (snapshot: ChatComposerSnapshot, controls: ChatComposerSendControls) => {
      let sendingSessionId = mainSessionIdRef.current;
      if (!sendingSessionId) {
        // A repeat submit (a double Enter) would otherwise create a second session.
        if (creatingSessionRef.current) return;
        creatingSessionRef.current = true;
        try {
          sendingSessionId = startSession
            ? await startSession()
            : (
                await createSession({
                  name: t("sidebar.newChat"),
                  personaId: snapshot.personaId,
                  projectPath: snapshot.projectPath,
                  largeModelSelection: snapshot.largeModelSelection,
                  reasoningEffort: snapshot.reasoningEffort,
                  agentName: snapshot.agentMention?.agentName,
                  deviceFolder: snapshot.deviceFolder
                    ? { deviceId: snapshot.deviceFolder.deviceId, path: snapshot.deviceFolder.path }
                    : undefined,
                })
              ).id;
          controls.onSessionCreated?.();
        } catch (error) {
          setStreamError(
            error instanceof ChatApiError && error.message
              ? snapshot.deviceFolder && error.status === 409
                ? // Core answers a folder it could not check with a DeviceFilesErrorCode.
                  t(`project.devices.errors.${error.message}`, {
                    defaultValue: t("project.devices.errors.unavailable"),
                  })
                : error.message
              : t("stream.errors.createChatFallback"),
          );
          throw error;
        } finally {
          creatingSessionRef.current = false;
        }
        // The refs normally follow the render that adopts the session. The turn
        // below starts before that render, and its stream reads them to decide
        // which session's end counts as read and which may move the workspace.
        mainSessionIdRef.current = sendingSessionId;
        setCreatedAgentMention(snapshot.agentMention ?? null);
        setCreatedSessionId(sendingSessionId);
        onSessionCreated?.(sendingSessionId);
        notifySessionsChanged();
      }
      const baseOptimisticText = buildOptimisticUserText(snapshot.text, snapshot.uploads);
      // Mirror the server's persisted form for a structured skill turn
      // (`/<name> task`) so the optimistic row matches what the reload shows.
      const optimisticText = snapshot.skillName
        ? `/${artifactLocalName(snapshot.skillName)}${
            baseOptimisticText.trim() ? ` ${baseOptimisticText}` : ""
          }`
        : baseOptimisticText;
      const replyTo = snapshot.replyTo;
      // The quote shows at once; the accepted row carries the server's snapshot of it.
      const optimisticContent = JSON.stringify([
        ...(replyTo
          ? [
              {
                type: "reply_to",
                messageId: replyTo.messageId,
                author: replyTo.author,
                ...(replyTo.name ? { name: replyTo.name } : {}),
                text: replyTo.preview,
              },
            ]
          : []),
        { type: "text", content: optimisticText },
      ]);
      await runTurnLifecycle(
        sendingSessionId,
        async () => {
          const formData = new FormData();
          formData.set("text", snapshot.text);
          if (snapshot.inputId) formData.set("inputId", snapshot.inputId);
          if (snapshot.skillName) formData.set("skillName", snapshot.skillName);
          if (snapshot.personaId) formData.set("personaId", snapshot.personaId);
          if (snapshot.largeModelSelection)
            formData.set("largeModelSelection", snapshot.largeModelSelection);
          formData.set("reasoningEffort", snapshot.reasoningEffort);
          if (concierge) formData.set("priority", "now");
          if (replyTo) {
            for (const [name, value] of Object.entries(replyFormFields(replyTo))) {
              formData.set(name, value);
            }
          }
          if (snapshot.chatThread) formData.set("chatThread", snapshot.chatThread);
          for (const upload of snapshot.uploads) {
            formData.append("files", upload.file);
          }
          // Concierge hands work to task chats, which see their own workspace.
          const ws = concierge ? null : snapshotWorkspaceForSend(workspaceContextRegistry);
          if (ws) formData.set("workspace", JSON.stringify(ws));
          // POST returns JSON `{ turnId }`. SSE lives on a
          // separate GET keyed by turnId.
          return postSessionTurn(sendingSessionId, formData, {
            onUploadProgress: snapshot.uploads.length ? controls.onUploadProgress : undefined,
            signal: controls.signal,
          });
        },
        optimisticContent,
        // A text-only send shows its bubble at once. An upload keeps its text
        // in the composer until the server accepts it, so its bubble waits too.
        snapshot.uploads.length === 0 ? snapshot.inputId : undefined,
      );
    },
    [
      runTurnLifecycle,
      workspaceContextRegistry,
      t,
      onSessionCreated,
      startSession,
      notifySessionsChanged,
      concierge,
    ],
  );

  // An inline app component submitted its result. Posts an `interaction_result`
  // part (the same resolution shape a workspace surface uses): it's persisted so
  // the card re-renders read-only on reload, and the server builds the resuming
  // turn's prompt from the artifact — the client no longer hands the model prose.
  // The persona/reasoning metadata is pulled from the composer so this turn
  // matches what onSend would have sent — otherwise the server silently falls
  // back to guardian for personaId and to the stored reasoningEffort setting.
  const handleSubmitAppComponent = useCallback(
    async (sendingSessionId: string, toolUseId: string, output: Record<string, unknown>) => {
      // Post to the session that owns the component (the block's row).
      if (!sendingSessionId) return;
      const parts = [{ type: "interaction_result", toolUseId, output }];
      const meta = composerRef.current?.getMetadataSnapshot();
      const body: Record<string, unknown> = { parts };
      if (meta) {
        if (meta.personaId) body.personaId = meta.personaId;
        body.reasoningEffort = meta.reasoningEffort;
      }
      const ws = snapshotWorkspaceForSend(workspaceContextRegistry);
      if (ws) body.workspace = ws;
      await runTurnLifecycle(
        sendingSessionId,
        () => postSessionTurnJson(sendingSessionId, body),
        JSON.stringify(parts),
      );
    },
    [runTurnLifecycle, workspaceContextRegistry],
  );

  // The chat's own turn fields, which a widget sends with every event: core
  // uses them only when the event starts a turn.
  const widgetTurnFields = useCallback(() => {
    const meta = composerRef.current?.getMetadataSnapshot();
    const turn: Record<string, unknown> = {};
    if (meta) {
      if (meta.personaId) turn.personaId = meta.personaId;
      turn.reasoningEffort = meta.reasoningEffort;
    }
    const ws = snapshotWorkspaceForSend(workspaceContextRegistry);
    if (ws) turn.workspace = ws;
    return turn;
  }, [workspaceContextRegistry]);

  // A widget's event may start a turn that ends before the poll sees it run,
  // and the guardian's own answer is never announced: read the chat again.
  const widgetHost = useMemo<WidgetHost>(
    () => ({
      turnFields: widgetTurnFields,
      onSettled: () => {
        const sid = mainSessionIdRef.current;
        if (!sid) return;
        resyncSessionMessages(sid);
        kickTurnPoll();
      },
    }),
    [widgetTurnFields, resyncSessionMessages, kickTurnPoll],
  );

  const handleDismissAppComponent = useCallback(
    async (sessionId: string, toolUseId: string) => {
      await handleSubmitAppComponent(sessionId, toolUseId, { dismissed: true });
    },
    [handleSubmitAppComponent],
  );

  // Stop generation for the active streaming session by targeting
  // the specific running turnId; queued turns behind it run normally.
  const stopMessage = useCallback(async () => {
    const sid = mainSessionIdRef.current;
    if (!sid) return;
    const turnId = streamingSessionsRef.current.get(sid)?.turnId ?? null;
    if (!turnId) return;
    const targetController = turnStreamControllersRef.current.get(turnId);

    // A dead SSE connection can miss `done`. Release it only after the server
    // confirms this turn ended; accepting Stop is not confirmation of exit.
    const forceReleaseIfStuck = (delayMs: number, confirmedFinished = false) => {
      const stillOwnsStream = () =>
        streamingSessionsRef.current.get(sid)?.turnId === turnId &&
        turnStreamControllersRef.current.get(turnId) === targetController;
      setTimeout(async () => {
        if (!stillOwnsStream()) return;
        if (!confirmedFinished) {
          const turns = await listSessionTurns(sid).catch(() => null);
          if (!turns || turns.some((turn) => turn.turnId === turnId)) return;
          if (!stillOwnsStream()) return;
        }
        targetController?.abort();
        endSessionStream(sid, turnId);
        void loadMessages(sid, { force: true, dropLocalOptimistic: true });
      }, delayMs);
    };

    try {
      const res = await interruptTurn(turnId);
      if (res.status === 404) {
        // The turn already finished server-side (stop landed late, or the
        // local entry outlived a dead stream) — release the stale entry now.
        forceReleaseIfStuck(0, true);
      } else if (res.ok) {
        // Interrupt accepted. A healthy stream flips the UI via `done`
        // within moments; the grace-period check only fires on a dead one.
        forceReleaseIfStuck(STOP_FORCE_RELEASE_GRACE_MS);
      } else {
        const message = await res.text().catch(() => "");
        setStreamError(message || t("stream.errors.stopStatus", { status: res.status }));
      }
    } catch {
      setStreamError(t("stream.errors.stopFallback"));
    }
  }, [streamingSessionsRef, endSessionStream, loadMessages, t]);

  const displayedStreaming = isActiveSessionStreaming;

  // The grouped speaker rows. Memoized so a streaming turn never rebuilds the
  // transcript. runningTurnId and isStreaming change only at turn boundaries,
  // and once more when a backend turn names its agent turn.
  const rows = useMemo(
    () =>
      buildRows(displayMessages, identityBySession, mainIdentity, {
        runningTurnId,
        isStreaming: isActiveSessionStreaming,
      }),
    [displayMessages, identityBySession, mainIdentity, runningTurnId, isActiveSessionStreaming],
  );

  // Concierge before its first message. It waits for the history fetch, so a
  // chat with messages never flashes the guidance while they load.
  // A topic chat's draft, before its first send, shows the same empty state.
  const conciergeEmpty =
    concierge &&
    (!mainSessionId || (messages.has(mainSessionId) && rows.length === 0)) &&
    !displayedStreaming;

  // The composer is memoized so a streaming turn does not render it, which only
  // holds while what it is handed keeps its identity.
  const composerModelSelection = useMemo(
    () => (chatModelPickable ? { value: chatModelValue, onChange: pickChatModel } : undefined),
    [chatModelPickable, chatModelValue, pickChatModel],
  );
  const stopComposerTurn = useCallback(() => void stopMessage(), [stopMessage]);
  useChatTabStatus(
    isActiveSessionStreaming,
    awaitingGuardian,
    lastTurnFailed && !isActiveSessionStreaming,
    turnEnds,
  );

  // Share mode hides the composer, so it takes no dropped file: the drop is
  // refused rather than filed into a draft no one sees.
  const sharingRef = useRef(false);
  sharingRef.current = shareMode && Boolean(mainSessionId);
  const refuseDrop = (event: React.DragEvent<HTMLDivElement>): boolean => {
    if (!sharingRef.current) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
    return true;
  };

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    if (refuseDrop(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingFiles(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    if (refuseDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (sharingRef.current) return;
    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    composerRef.current?.addFiles(files);
    composerRef.current?.focus();
  }, []);

  const refreshActiveSession = useCallback(() => {
    if (mainSessionId) {
      void loadMessages(mainSessionId, { force: true });
    }
  }, [mainSessionId, loadMessages]);

  // The block-level callbacks + resolved-interaction map, bundled once so the
  // memoized StaticTranscript stays stable across a streaming turn.
  // `interactionResults` is rebuilt whenever a message changes; kept by value, a
  // new message does not hand every transcript row new actions.
  const stableInteractionResults = useStableMap(interactionResults);
  const blockActions = useMemo<BlockActions>(
    () => ({
      onApprovalResolved: refreshActiveSession,
      onSubmitAppComponent: handleSubmitAppComponent,
      onDismissAppComponent: handleDismissAppComponent,
      interactionResults: stableInteractionResults,
    }),
    [
      refreshActiveSession,
      handleSubmitAppComponent,
      handleDismissAppComponent,
      stableInteractionResults,
    ],
  );

  // Keyed by (session, turn) so dismissal naturally clears when the turn
  // advances or the user switches sessions.
  const liveDismissedRef = useRef<{ sessionId: string; turnId: string } | null>(null);

  // The live trace always targets the session's running turn. One builder keeps
  // that (sessionId, turnId) pairing consistent across open + the keep-in-sync effect.
  const buildLiveTraceTarget = useCallback((): TraceDrawerTarget | null => {
    if (!activeSessionId || !runningTurnId) return null;
    return {
      kind: "live",
      sessionId: activeSessionId,
      turnId: runningTurnId,
      summary: currentSnapshot?.summary ?? {
        distinctApps: [],
        totalSteps: 0,
        invocationCounts: {},
      },
      segments: currentSnapshot?.segments ?? [],
      streaming: true,
    };
  }, [activeSessionId, runningTurnId, currentSnapshot]);

  const closeTraceDrawer = useCallback(() => {
    setTraceDrawerTarget((prev) => {
      if (prev?.kind === "live" && activeSessionId && runningTurnId) {
        liveDismissedRef.current = { sessionId: activeSessionId, turnId: runningTurnId };
      }
      return null;
    });
  }, [activeSessionId, runningTurnId]);

  // Open the live trace drawer on demand (e.g. via the trace trigger button).
  const revealTrace = toolTrace.reveal;
  const openLiveTraceDrawer = useCallback(() => {
    const target = buildLiveTraceTarget();
    if (!target) return;
    liveDismissedRef.current = null;
    setTraceDrawerTarget(target);
    revealTrace();
  }, [buildLiveTraceTarget, revealTrace]);

  const openStoredTraceDrawer = useCallback(
    (target: TraceDrawerTarget) => {
      setTraceDrawerTarget(target);
      revealTrace();
    },
    [revealTrace],
  );

  const openSubagentTraceDrawer = useCallback(
    (node: TraceSubagentSummary) => {
      setTraceDrawerTarget({
        kind: "turn",
        sessionId: node.sessionId,
        turnId: node.turnId,
        summary: node.traceSummary ?? {
          distinctApps: [],
          totalSteps: 0,
          invocationCounts: {},
        },
        dumpHref: `/api/sessions/${encodeURIComponent(node.sessionId)}/turns/${encodeURIComponent(node.turnId)}/trace.json`,
        running: node.status === "running",
      });
      revealTrace();
    },
    [revealTrace],
  );

  // Keep a live trace target in sync when the user has already opened it,
  // but don't auto-open the drawer on new streams.
  useEffect(() => {
    if (!isActiveSessionStreaming || !currentSnapshot) return;
    setTraceDrawerTarget((prev) =>
      prev?.kind === "live" ? (buildLiveTraceTarget() ?? prev) : prev,
    );
  }, [isActiveSessionStreaming, currentSnapshot, buildLiveTraceTarget]);

  // When the active stream ends, drop the live target so the persisted trace
  // message (now in the feed) becomes the source of truth.
  useEffect(() => {
    if (isActiveSessionStreaming) return;
    setTraceDrawerTarget((prev) => (prev?.kind === "live" ? null : prev));
  }, [isActiveSessionStreaming]);

  // Clear drawer when switching sessions so we don't bleed one session's
  // trace into another.
  useEffect(() => {
    setTraceDrawerTarget(null);
  }, [mainSessionId]);

  // Offer the open trace to the tool pane as its Trace tab. The tab's close
  // button calls back into `closeTraceDrawer`, so closing there and closing
  // from here end the same way.
  const traceOwner = useId();
  const setToolTrace = toolTrace.set;
  const traceOpen = traceDrawerTarget !== null;
  const traceStreaming = traceDrawerTarget?.kind === "live" && traceDrawerTarget.streaming;
  const closeTraceRef = useRef(closeTraceDrawer);
  closeTraceRef.current = closeTraceDrawer;
  useEffect(() => {
    setToolTrace(
      traceOwner,
      traceOpen ? { streaming: traceStreaming, onClose: () => closeTraceRef.current() } : null,
    );
  }, [setToolTrace, traceOwner, traceOpen, traceStreaming]);
  useEffect(() => () => setToolTrace(traceOwner, null), [setToolTrace, traceOwner]);

  const untitledEmptyChat = !mainSessionId && !pinnedAgentMention;

  const conciergeActivity = useConciergeActivity(concierge ? (mainSessionId ?? null) : null);
  // The agent's logo in the header opens the chat's task list: what runs for it.
  const taskList = useTaskList(concierge ? (mainSessionId ?? null) : null);
  // A Concierge chat's header buttons sit on round badges like its pill, except
  // in the Mac app's title bar, where they are any chat's.
  const floating = concierge && !navbarSlot;
  const actionBadge = floating
    ? cn("rounded-full text-foreground", FLOATING_SURFACE)
    : "text-muted-foreground hover:text-foreground";
  // The name the header shows for the Concierge, which a share of this chat
  // labels its turns by too.
  const conciergeDisplayName = resolveMainAgentDisplayName(conciergeName);
  // A blank topic chat, before its first message, shows nothing in the
  // header: its empty state speaks for it, and it has no tasks yet.
  const blankTopicChat = conciergeEmpty && !isMainChat;
  const conciergeStatus =
    concierge && !blankTopicChat ? (
      <ConciergeHeaderStatus
        // Every Concierge chat, main or topic, goes by the Concierge's name
        // here; a topic chat's own name is in the chat list.
        name={conciergeDisplayName}
        activity={conciergeActivity}
        // A chat with no messages yet draws its own large mascot.
        badge={!conciergeEmpty}
        onOpenTasks={taskList.open}
      />
    ) : null;

  const navbarTitle = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {untitledEmptyChat ? null : (
        <>
          <SessionAvatar
            iconUrl={pinnedAgentMention?.iconUrl}
            label={pinnedAgentMention?.appLabel}
            model={model}
            reasoningEffort={reasoningEffort}
          />
          {sessionLoading ? (
            <SessionLoadingTitle />
          ) : (
            <span className="truncate text-ui text-foreground">
              {sessionName?.trim() || pinnedAgentMention?.appLabel || t("sidebar.newChat")}
            </span>
          )}
          {/* The agent's app beside a titled chat. */}
          {sessionName?.trim() && pinnedAgentMention && (
            <span className="shrink-0 truncate text-aux text-muted-foreground">
              {pinnedAgentMention.appLabel}
            </span>
          )}
        </>
      )}
    </div>
  );

  const navbarActions = (
    <>
      {mainSessionId && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              size={floating ? "md" : "sm"}
              label={t("navbar.more")}
              icon={<MoreHorizontal />}
              className={actionBadge}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => enterShareMode()}>
              <Share2 className="size-4" />
              {t("share.title", "Share chat")}
            </DropdownMenuItem>
            {isMainChat ? null : isArchived ? (
              <DropdownMenuItem onSelect={() => void handleUnarchive()}>
                <ArchiveRestore className="size-4" />
                {t("navbar.unarchive")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => void handleArchive()}>
                <Archive className="size-4" />
                {t("navbar.archive")}
              </DropdownMenuItem>
            )}
            {isMainChat ? null : (
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteConfirmOpen(true)}>
                <Trash2 className="size-4" />
                {t("navbar.delete")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!toolTrace.paneOpen && (
        <IconButton
          size={floating ? "md" : "sm"}
          className={floating ? actionBadge : undefined}
          data-coach="add-widget"
          aria-expanded={false}
          onClick={() => toolTrace.setPaneCollapsed(false)}
          label={t("chat.expandTools", { ns: "common" })}
          icon={
            <span className="relative">
              <PanelRightOpen />
              {toolView.unreadIds.length > 0 && (
                <span
                  className="absolute -right-1 -top-1 size-1.5 rounded-full bg-info"
                  aria-label={t("chat.toolUpdated", { ns: "common" })}
                />
              )}
            </span>
          }
        />
      )}
    </>
  );

  // A Concierge chat's header floats over its messages: no bar, just the
  // mascot's badge with the name pill under it in the middle, and round
  // buttons either side, centred on the badge. The equal side columns keep the
  // middle centred over the chat. Only its pieces take the pointer, so the
  // messages under the gaps stay reachable. The thread view floats the same
  // header with its close button on the right.
  // A narrow workspace shows the open tool pane in place of the chat.
  const toolTasksHost = useToolTasks();
  const paneCoversChat = toolTrace.paneOpen && Boolean(toolTasksHost?.compact);
  const floatingHeader = (trailing: ReactNode) => (
    <div
      data-concierge-header
      className="pointer-events-none absolute inset-x-0 top-0 z-20 grid grid-cols-[1fr_minmax(0,max-content)_1fr] items-center gap-x-2 px-2 pt-2 max-md:pt-[calc(var(--rome-safe-area-top)+0.5rem)] md:px-3"
    >
      {/* The phone shell's back and menu buttons move in here, and its bar
          steps aside. Not while the tool pane covers the chat: the shell's
          bar is then the only way back from the pane. */}
      {paneCoversChat ? null : (
        <SlotOutlet
          name={CONCIERGE_LEADING_SLOT}
          className="pointer-events-auto col-start-1 row-start-1 flex items-center gap-1 justify-self-start md:hidden"
        />
      )}
      {conciergeStatus}
      <div className="pointer-events-auto col-start-3 row-start-1 flex items-center gap-1 justify-self-end">
        {trailing}
      </div>
    </div>
  );
  // In the Mac app the title bar takes the header apart: the buttons go into
  // the bar like any chat's, and the badge and pill hang from its lower edge.
  // Not while the tool pane covers the chat, whose mascot it would be.
  const conciergeHeaderWith = navbarSlot
    ? (trailing: ReactNode) => (
        <>
          <SlotContent name={navbarSlot}>
            <div className="min-w-0 flex-1" />
            {trailing}
          </SlotContent>
          {paneCoversChat ? null : (
            <SlotContent name={CONCIERGE_TITLEBAR_SLOT}>{conciergeStatus}</SlotContent>
          )}
        </>
      )
    : floatingHeader;
  const threadOpen = concierge && Boolean(mainSessionId) && replyDraft.thread !== null;
  // The thread view stays on the message it opened from while it is open,
  // a reply picked inside it included. It fades in, and closes at once: the
  // backdrop's blur cannot fade out cleanly, and the composer and header
  // return under a fading view, so a fade out flashes.
  const draftThread = threadOpen ? replyDraft.thread : null;
  const [threadView, setThreadView] = useState<string | null>(null);
  if (draftThread && !threadView) setThreadView(draftThread);
  else if (!draftThread && threadView) setThreadView(null);
  const openedFromRef = useRef<string | null>(null);
  useEffect(() => {
    if (draftThread) {
      openedFromRef.current ??= draftThread;
      return;
    }
    const from = openedFromRef.current;
    openedFromRef.current = null;
    if (from) revealMessage(from);
  }, [draftThread, revealMessage]);
  // On a desktop the thread view holds the message it opened from where it
  // sat in the timeline; a phone keeps the thread on the composer.
  const desktop = useDesktop();
  const threadOrigin = useCallback(
    (messageId: string) => () => {
      if (!desktop || !scrollerEl) return null;
      return findMessageAnchor(scrollerEl, messageId)?.getBoundingClientRect().top ?? null;
    },
    [desktop, scrollerEl],
  );
  // The thread view's transcript feeds none of the chat's scroll measures.
  const ignoreThreadContent = useCallback(() => {}, []);
  loadedThreads.current = new Map(
    displayMessages.map((message) => [message.id, message.chatThreadId ?? null]),
  );
  const chatThreads = useChatThreadsValue(displayMessages, rethreaded, liveThreadTitles);
  // The open thread view's thread, whose task chat its header opens.
  const threadRootOfView = threadView
    ? (chatThreads.taskThreads.get(threadView) ?? threadView)
    : null;
  const conciergeHeader = concierge ? (
    <>
      {threadOpen ? null : conciergeHeaderWith(navbarActions)}
      {taskList.sheet}
    </>
  ) : null;

  const navbar = (
    <>
      {navbarTitle}
      {navbarActions}
    </>
  );

  const page = (
    <WidgetHostContext.Provider value={widgetHost}>
      <TooltipProvider delayDuration={150}>
        {sessionEventIds.map((sid) => (
          <ChatSessionEvents
            key={sid}
            sessionId={sid}
            onMessageInsert={handleMessageInsert}
            onMessageChatThread={handleMessageChatThread}
            onChatThreadRetired={handleChatThreadRetired}
            onMessageStatusReaction={handleMessageStatusReaction}
            onChatCardSettled={handleChatCardSettled}
            onSessionName={handleSessionName}
            onSessionRunning={handleSessionRunning}
            onMessageWriting={handleMessageWriting}
            onReconnect={handleSessionEventsReconnect}
          />
        ))}
        <div
          className="@container/chat relative flex h-full overflow-hidden bg-chat-canvas [--background:var(--chat-canvas)]"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* ---- Main Chat Area ---- */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {isDraggingFiles && (
              <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-16 border-2 border-dashed border-info bg-info-bg/85 text-ui text-info-fg md:inset-6">
                {t("composer.dropFiles")}
              </div>
            )}

            {/* No rule under the bar: the chat canvas runs up to the top. A new
              chat with no app has nothing to name yet, since the welcome below
              says it already, so the bar keeps only its height and controls
              and the page does not move when the first message starts the
              session. */}
            {concierge ? (
              conciergeHeader
            ) : navbarSlot ? (
              <SlotContent name={navbarSlot}>{navbar}</SlotContent>
            ) : (
              <div className="z-20 flex h-12 shrink-0 items-center gap-1 bg-chat-canvas/80 pl-4 pr-2 backdrop-blur-md supports-[backdrop-filter]:bg-chat-canvas/65 max-md:hidden">
                {navbar}
              </div>
            )}
            {/* The message scroller — the ONLY scrolling node in the chat. It is
              bounded by the /chat viewport shell, so message reflow (mermaid,
              late media) stays inside here and never resizes the document or
              moves the sidebar/composer. `overscroll-contain` kills page-level
              rubber-banding/scroll-chaining; momentum scrolling keeps the iPad
              touch feel. */}
            {/* Positioning + measurement parent for the timeline rail. Its own
              container name matters: `@container/chat` is declared on the outer
              element, which also holds the standalone trace overlay, so a gate
              keyed to it would not follow the transcript column itself. */}
            <div className="@container/transcript relative flex min-h-0 flex-1 flex-col">
              {/* The left inset opens the timeline rail's lane. Without it the
                transcript's own `max-w-5xl` body reaches the container edge
                once the container drops under 1024px, and the markers would land
                on the bubbles. Padding sits inside the scroller's border box,
                so the scrollbar does not move — only the content shifts. The
                query MUST match ChatTimelineRail's visibility gate. */}
              <div
                ref={attachScroller}
                className={cn(
                  "scrollbar-hover-shown relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain",
                  // Concierge has no timeline rail, so no lane for it. Its
                  // header floats over the messages, so the first one starts
                  // below it, and a jump to a message stops below it too.
                  concierge ? "concierge-header-clear" : "@min-[48rem]/transcript:pl-8",
                )}
              >
                {conciergeEmpty ? (
                  mainSessionId === conciergeMainChatId ? (
                    <ConciergeEmptyState
                      onPick={(prompt) => composerRef.current?.insertText(prompt)}
                    />
                  ) : (
                    // A topic chat: its starters send themselves as its first message.
                    <ConciergeTopicEmptyState
                      onStart={(prompt) => composerRef.current?.submit(prompt)}
                    />
                  )
                ) : mainSessionId ? (
                  <>
                    {hasOlder(mainSessionId) ? (
                      <div ref={olderSentinelRef} aria-hidden className="h-px shrink-0" />
                    ) : null}
                    <ChatThreadsProvider value={chatThreads}>
                      <TaskChatContext.Provider value={isTaskChat}>
                        <MessageList
                          rows={rows}
                          live={{
                            isStreaming: displayedStreaming,
                            runningTurnId,
                            quiet: activeSessionStream?.quiet,
                            writing: liveWriting.get(activeSessionId) ?? null,
                            snapshot: currentSnapshot,
                            textStore: liveTextStore,
                            blockIx: activeSessionStream?.assistantBlockIx,
                            textThroughOrdinal: activeSessionStream?.textThroughOrdinal,
                            identity: mainIdentity,
                          }}
                          selection={
                            shareMode
                              ? {
                                  selectedTurns: selectedShareTurns,
                                  selectableSessionId: mainSessionId,
                                  onToggleTurn: toggleShareTurn,
                                }
                              : undefined
                          }
                          contentRef={attachContent}
                          onOpenLiveTrace={openLiveTraceDrawer}
                          onOpenStoredTrace={openStoredTraceDrawer}
                          onOpenSubagentTrace={openSubagentTraceDrawer}
                          activeTraceTarget={traceDrawerTarget}
                          subagentIconByName={subagentIconByName}
                          actions={blockActions}
                          feedback
                          fork={forkable}
                          variant={variant}
                          unreadFrom={unread?.firstId ?? null}
                        />
                      </TaskChatContext.Provider>
                    </ChatThreadsProvider>
                  </>
                ) : (
                  emptyState
                )}

                {/* The single floating composer — a `sticky bottom-0` floor inside the
                message scroller, so messages scroll behind its translucent blur
                ("scroll under the composer") instead of stopping at a solid dock.
                In share mode it's swapped for the ShareBar,
                which configures + mints the link for the turns selected above.

                Below md the floor paints the canvas instead. Its side gutters
                and bottom padding sit outside the box's blur, and on a phone a
                transparent strip there shows table rows and text beside and
                below the box, which reads as a second transcript. The floor
                also takes pointer events there, while no thread view is open, so a tap on the canvas cannot
                land on a link it hides. It stays inside the scroller, so the
                scroll and keyboard geometry match the desktop layout. */}
                <div
                  ref={setFloorEl}
                  data-chat-floor
                  className={cn(
                    "pointer-events-none sticky bottom-0 px-3 md:px-6",
                    // Over an open thread view only the composer takes presses.
                    chatFloorLayering(threadOpen),
                    // Presentation mode gives the draft's bottom gap 5x its normal
                    // size so a recording framed on the empty state keeps the
                    // composer clear of the capture's lower edge.
                    presentationMode && !mainSessionId
                      ? "pb-[calc(var(--rome-safe-area-bottom)+5rem)] md:pb-[calc(var(--rome-safe-area-bottom)+7.5rem)]"
                      : "pb-[calc(var(--rome-safe-area-bottom)+1rem)] md:pb-[calc(var(--rome-safe-area-bottom)+1.5rem)]",
                  )}
                >
                  {/* Back to the live tail. It rides the sticky floor rather than the
                    scroller, so it tracks a composer whose height changes with the
                    draft, and it sits in every floor state — scrolling has nothing
                    to do with which one is showing.

                    `auto`, never `smooth`: scrollToBottom re-engages the pin and
                    then animates, and a smooth animation emits scroll events while
                    the click is still inside the hook's user-gesture window. The
                    first one reports "not at the bottom yet" and is read as the
                    user scrolling away, which releases the pin the call just set —
                    the view lands at the bottom with following switched off. One
                    instant jump emits a single event, already at the bottom.

                    Kept mounted and faded rather than unmounted, so the exit
                    animates too. `visibility` is what makes that safe: it flips at
                    the END of the transition, so the faded-out button stops taking
                    clicks and leaves the tab order instead of lurking invisibly
                    over the transcript. */}
                  <IconButton
                    size="md"
                    label={t("jumpToLatest")}
                    icon={<ArrowDown />}
                    // IconButton mirrors its label into `title`, which the browser
                    // renders as a native tooltip. The aria-label already names the
                    // control, and a lone arrow above the composer needs no gloss.
                    title={undefined}
                    onClick={() => scrollToBottom("auto")}
                    className={cn(
                      // `touch-target` because this control, unlike the timeline
                      // rail, has no width gate: it is reachable on a phone, where
                      // the 36px step is under the 44px floor.
                      "touch-target pointer-events-auto absolute bottom-full left-1/2 mb-3 -translate-x-1/2 rounded-full border border-border bg-surface/95 text-muted-foreground shadow-10 backdrop-blur-md transition-[opacity,visibility] duration-150 ease-out supports-[backdrop-filter]:bg-surface/80 hover:text-foreground motion-reduce:transition-none",
                      !mainSessionId || isAtBottom || threadOpen
                        ? "invisible opacity-0"
                        : "visible opacity-100",
                    )}
                  />
                  <div className="pointer-events-auto relative mx-auto max-w-5xl">
                    {/* Sits on the composer's top-right corner, clear of the
                      centered jump to latest. */}
                    {mainSessionId && !threadOpen && (
                      <div className="pointer-events-none absolute right-0 bottom-full mb-2">
                        {concierge ? (
                          <ConciergeCardJump
                            scroller={scrollerEl}
                            content={contentEl}
                            floor={floorEl}
                            currentReplyMessageIds={currentReplyMessageIds}
                            messages={view.displayMessages}
                            liveCards={liveCards}
                          />
                        ) : (
                          <ChatPendingCardJump
                            scroller={scrollerEl}
                            content={contentEl}
                            floor={floorEl}
                            currentReplyMessageIds={currentReplyMessageIds}
                          />
                        )}
                      </div>
                    )}
                    {shareMode && mainSessionId ? (
                      <ShareBar
                        sessionId={mainSessionId}
                        selectedTurnIds={[...selectedShareTurns]}
                        agentName={concierge ? conciergeDisplayName : mainIdentity.name}
                        onExit={exitShareMode}
                      />
                    ) : null}
                    {/* Share mode hides the composer rather than unmounting it,
                      so a draft is still there when share mode ends. */}
                    <div className={shareMode && mainSessionId ? "hidden" : "contents"}>
                      {isArchived ? (
                        <div className="flex items-center justify-between gap-3 rounded-16 border border-border bg-surface/95 px-4 py-3 text-ui text-muted-foreground shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80">
                          <span className="min-w-0 flex-1">{t("archived.readOnly")}</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleUnarchive()}
                          >
                            <ArchiveRestore data-icon="inline-start" className="size-3.5" />
                            {t("archived.unarchive")}
                          </Button>
                        </div>
                      ) : concierge ? (
                        <ConciergeComposer
                          ref={composerRef}
                          boxClassName="rounded-16 border border-border bg-surface/95 p-2 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
                          onSend={handleComposerSend}
                          isStreaming={displayedStreaming}
                          onStop={stopComposerTurn}
                          streamError={streamError}
                          // An open topic chat names itself in its box.
                          chatName={isMainChat ? null : sessionName?.trim() || null}
                          modelSelection={
                            chatModelPickable
                              ? { value: chatModelValue, onChange: pickChatModel }
                              : undefined
                          }
                        />
                      ) : (
                        <ChatComposer
                          persistNewChatDraft={!mainSessionId}
                          ref={composerRef}
                          // The box look lives on the composer now so the chip row can sit
                          // outside it; this mount adds the floating blur/translucency.
                          boxClassName="rounded-16 border border-border bg-surface/95 p-4 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
                          onSend={handleComposerSend}
                          // A draft picks the session's project, model, and agent.
                          // A session keeps its project and agent, and its model
                          // can change from the next turn.
                          showProjectSelector={!mainSessionId}
                          showModelSelector={!mainSessionId || chatModelPickable}
                          chatModelSelection={composerModelSelection}
                          initialProjectName={initialProjectName}
                          initialDeviceFolder={initialDeviceFolder}
                          initialAgentMention={initialAgentMention}
                          isStreaming={displayedStreaming}
                          onStop={stopComposerTurn}
                          streamError={streamError}
                          pinnedAgentMention={pinnedAgentMention}
                          lockAgentMention={Boolean(mainSessionId)}
                          // Locks once the turn that saved the card has ended, so
                          // Stop stays in reach while it still streams.
                          lockedReason={
                            lockedByCard && !displayedStreaming ? t("composer.lockedByCard") : null
                          }
                        />
                      )}
                    </div>
                  </div>
                </div>
                {/* Pairs with the empty state's `md:flex-auto`. Both use auto basis,
                  so the free space splits evenly above and below the greeting and
                  composer; a 0 basis (`flex-1`) on either side puts them off-center.
                  Phones keep the docked composer, where the keyboard owns the
                  bottom of the screen. */}
                {centerDraftComposer && !mainSessionId ? (
                  <div aria-hidden data-draft-center-spacer className="hidden flex-auto md:block" />
                ) : null}
              </div>
              {concierge && unread && mainSessionId ? (
                // Under the floating header, on the transcript's top-right corner.
                // Kept mounted under a thread view: the pill's state is the
                // guardian's progress through the unread messages.
                <div
                  className={cn(
                    "pointer-events-none absolute top-[calc(var(--rome-concierge-header-offset)+0.5rem)] right-3 z-10 md:right-6",
                    threadOpen && "invisible",
                  )}
                >
                  <ConciergeUnreadPill
                    scroller={scrollerEl}
                    content={contentEl}
                    count={unread.count}
                    more={unread.more}
                    anchored={unread.firstId !== null}
                    onJump={showUnreadDivider}
                  />
                </div>
              ) : null}
              {concierge ? null : (
                <ChatTimelineRail
                  scroller={scrollerEl}
                  content={contentEl}
                  questions={timelineQuestions}
                  onJump={jumpToMessage}
                />
              )}
              {threadView && mainSessionId ? (
                <ChatThreadView
                  key={threadView}
                  sessionId={mainSessionId}
                  messageId={threadView}
                  onClose={replyDraft.closeThread}
                  floor={floorEl}
                  originTop={threadOrigin(threadView)}
                  header={conciergeHeaderWith(
                    <>
                      {threadRootOfView ? (
                        <OpenThreadTaskChat
                          threadRoot={threadRootOfView}
                          size={floating ? "md" : "sm"}
                          className={actionBadge}
                        />
                      ) : null}
                      <IconButton
                        size={floating ? "md" : "sm"}
                        label={t("thread.close")}
                        icon={<X />}
                        onClick={replyDraft.closeThread}
                        className={actionBadge}
                      />
                    </>,
                  )}
                  renderMessages={(threadMessages) => (
                    // The thread view offers Copy and Reply, not Share: a share
                    // is made from the chat's own timeline.
                    <MessageSharingContext.Provider value={null}>
                      <ConciergeTranscript
                        rows={buildRows(threadMessages, identityBySession, mainIdentity, {
                          runningTurnId: null,
                          isStreaming: false,
                        })}
                        live={{
                          isStreaming: false,
                          runningTurnId: null,
                          snapshot: null,
                          textStore: liveTextStore,
                          identity: mainIdentity,
                        }}
                        actions={{
                          ...blockActions,
                          interactionResults: threadInteractionResults(threadMessages, {
                            messages: displayMessages,
                            results: blockActions.interactionResults,
                          }),
                        }}
                        contentRef={ignoreThreadContent}
                      />
                    </MessageSharingContext.Provider>
                  )}
                />
              ) : null}
            </div>
          </div>
          <TraceDrawer
            target={traceDrawerTarget}
            onClose={closeTraceDrawer}
            outlet={toolTrace.outlet}
            renderInlineBlock={(block, key) =>
              renderSingleEntry(block, key, {
                onApprovalResolved: refreshActiveSession,
                compact: true,
              })
            }
            renderRunBlocks={(blocks, live) =>
              renderFlatEntries(blocks, {
                onApprovalResolved: refreshActiveSession,
                compact: true,
                live,
              })
            }
          />
          {/* A topic chat asks, as the sidebar does, what becomes of its
              follows and open tasks. */}
          {concierge && mainSessionId && !isMainChat ? (
            <TopicChatDeleteDialog
              open={deleteConfirmOpen}
              chatId={mainSessionId}
              name={sessionName?.trim() || t("recentChats.newChat", { ns: "common" })}
              archived={isArchived}
              onCancel={() => setDeleteConfirmOpen(false)}
              onConfirm={(stopWork) => void handleDeleteSession(stopWork)}
            />
          ) : (
            <RomeConfirmDialog
              open={deleteConfirmOpen}
              destructive
              title={t("navbar.delete")}
              description={t("navbar.deleteConfirm")}
              confirmLabel={t("navbar.delete")}
              onCancel={() => setDeleteConfirmOpen(false)}
              onConfirm={() => void handleDeleteSession()}
            />
          )}
        </div>
      </TooltipProvider>
    </WidgetHostContext.Provider>
  );

  return (
    <ReplyDraftProvider value={replyDraft}>
      <MessageSharingContext.Provider value={shareMessageTurn}>
        <LiveStatusReactionsProvider value={liveReactions}>
          <LiveTaskCardsProvider value={liveCards}>{page}</LiveTaskCardsProvider>
        </LiveStatusReactionsProvider>
      </MessageSharingContext.Provider>
    </ReplyDraftProvider>
  );
}
