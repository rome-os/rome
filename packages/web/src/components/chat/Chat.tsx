import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import { z } from "zod";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import "react-medium-image-zoom/dist/styles.css";
import { cn } from "@/lib/utils";
import { dataTransferHasFiles, extractFilesFromDataTransfer } from "@/lib/clipboard-files";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  TraceDrawer,
  traceDrawerContentInsetClass,
  type TraceDrawerTarget,
} from "@/components/agent-trace/TraceDrawer";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { useSessionIdentity } from "@/components/chat/use-session-identity";
import { prettyAgentName } from "@/lib/agent-name";
import { artifactLocalName } from "@/lib/artifact-name";
import {
  buildChatView,
  buildRows,
  type AgentIdentity,
  type HandoffNode,
} from "@/components/chat/chat-view";
import { ShareBar } from "@/components/chat/ShareBar";
import { WidgetPicker } from "@/pages/free/WidgetPicker";
import { useWorkspaceEventBus } from "@/pages/free/workspace-event-bus";
import { useFreeCells, type WidgetType } from "@/pages/free/use-free-cells";
import type { TraceSegment, TraceSnapshot, TraceSummary } from "@rome/api-types/trace-segments";
import { useSmoothText } from "@/hooks/use-smooth-text";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { ChatTimelineRail } from "@/components/chat/ChatTimelineRail";
import { buildTimelineQuestions } from "@/components/chat/chat-timeline";
import { useStreamingSessions } from "@/hooks/use-streaming-sessions";
import { useSseEvents } from "@/hooks/use-sse-events";
import { renderFlatBlocks, renderSingleBlock } from "@/components/chat/blocks";
import {
  MessageList,
  type BlockActions,
  findActiveSubmission,
  findLastSubmission,
  hasPendingApprovalConfirmation,
} from "@/components/chat/MessageList";
import type { DelegatedSubagentNode } from "@/components/chat/DelegatedSubagentGroup";
import {
  ChatComposer,
  type ChatComposerHandle,
  type ChatComposerSnapshot,
} from "@/components/chat/ChatComposer";
import type {
  AgentMention,
  ChatErrorNotice,
  ChatMessage,
  CreateTurnResponse,
  DoneEventData,
  StreamBlock,
} from "@/lib/chat-types";
import { SCROLL_BOTTOM_THRESHOLD_PX } from "@/lib/chat-constants";
import { buildOptimisticUserText } from "@/lib/chat-helpers";
import { parseSSEEvents } from "@/lib/chat-sse";
import {
  mergeChatMessage,
  mergeFetchedChatMessages,
  orderChatMessages,
} from "@/lib/chat-message-ordering";
import {
  deleteSession,
  interruptTurn,
  listChatAgents,
  listSessionMessages,
  listSessionTurns,
  markSessionRead as apiMarkSessionRead,
  openTurnStream,
  postSessionTurn,
  postSessionTurnJson,
  type PostTurnResult,
} from "@/lib/chat-api";
import { useArchiveSession, usePinSession } from "@/lib/session-events";
import {
  snapshotWorkspaceForSend,
  useWorkspaceContextRegistry,
} from "@/pages/free/workspace-context";
import { autoPlaceApp } from "@/pages/free/use-free-cells";

// Leave a jumped-to question clear of the top edge — flush against it reads
// as cut off.
const TIMELINE_JUMP_OFFSET_PX = 24;
// How long the landed-on question stays tinted.
const TIMELINE_LANDING_MS = 900;

// Chat Component

// Stable empty list so `messages.get(sid) ?? EMPTY_MESSAGES` keeps a constant
// reference (avoids re-running submission gates every render).
const EMPTY_MESSAGES: ChatMessage[] = [];

// The turn SSE server emits a keepalive every 15s (TURN_STREAM_KEEPALIVE_
// INTERVAL_MS in webchat.ts). If nothing arrives for this long the connection
// is dead — mobile background/lock, proxy idle timeout, network swap — and the
// reader would otherwise hang forever with no error, leaving the streaming UI
// (and the Stop button's turnId) stuck on a stale turn. Three missed
// keepalives + margin.
const STREAM_STALL_TIMEOUT_MS = 50_000;

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
    plan: agentPlanSchema.optional(),
  }),
);

const chatMessageSchema: z.ZodType<ChatMessage> = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable().optional(),
  role: z.enum(["user", "assistant", "trace"]),
  content: z.string(),
  createdAt: z.string(),
  traceSummary: traceSummarySchema.nullable().optional(),
});

const sessionNameSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
});

interface ChatSessionEventsProps {
  sessionId: string;
  onMessageInsert: (sessionId: string, message: ChatMessage) => void;
  onSessionName: (sessionId: string, event: z.infer<typeof sessionNameSchema>) => void;
  onReconnect: (sessionId: string) => void;
}

function ChatSessionEvents({
  sessionId,
  onMessageInsert,
  onSessionName,
  onReconnect,
}: ChatSessionEventsProps) {
  useSseEvents(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      message_insert: {
        schema: chatMessageSchema,
        fn: (message) => onMessageInsert(sessionId, message),
      },
      session_name: {
        schema: sessionNameSchema,
        fn: (event) => onSessionName(sessionId, event),
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

export interface ChatHandle {
  focus: () => void;
  insertText: (text: string) => void;
}

export interface SessionMessage {
  sessionId: string;
  turnId: string | null;
  segment?: TraceSegment;
}

export interface ChatProps {
  sessionId: string;
  /** Guardian-chosen display name for the default main agent. */
  mainAgentDisplayName?: string;
  onSessionsChanged?: () => void;
  onSessionNotFound?: (sessionId: string) => void;
  onSessionMessage?: (message: SessionMessage) => void;
}

export const Chat = forwardRef<ChatHandle, ChatProps>(function ChatView(
  { sessionId, mainAgentDisplayName, onSessionsChanged, onSessionNotFound, onSessionMessage },
  ref,
) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  // `null` outside the workspace shell; sends simply skip injection.
  const workspaceContextRegistry = useWorkspaceContextRegistry();
  // The "+" widget picker that used to float as a desktop FAB now lives in the
  // top navbar. `useFreeCells` is a module-level store, so calling it here drives
  // the same workspace layout as FreeGrid — no prop drilling or context needed.
  const { addWidget, placements } = useFreeCells();
  const hasApps = placements.length > 0;
  // Multiple sessions are in scope at once. Pick the right one deliberately:
  //   • mainSessionId  — the session THIS <Chat> owns (the prop). Use for the
  //     owned transcript's load / delete / agent lookup / scroll / navigation.
  //   • floorSessionId — the session currently being interacted with / streamed:
  //     the deepest open handoff's child, else main. Use for anything paired
  //     with the running turn or live stream (send, stop, reattach, live trace,
  //     onSessionMessage) and for resolving the floor's submission.
  //   • a block's own message.sessionId — for inline-component submit/dismiss.
  //   • a handoff's parentSessionId (carry the node) — for resolving a handoff.
  // Never key shared interaction state by a bare toolUseId — provider ids recycle
  // per turn AND across sessions, so namespace by session (interactionResultKey).
  //
  // ChatPage remounts <Chat> with key={sessionId} on every navigation, so the
  // prop is effectively the source of truth.
  const mainSessionId = sessionId;
  const mainSessionIdRef = useRef(mainSessionId);
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
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
    start: startSessionStream,
    update: updateSessionSnapshot,
    updateText: updateSessionAssistantText,
    end: endSessionStream,
  } = useStreamingSessions();
  const [streamError, setStreamError] = useState<string | ChatErrorNotice | null>(null);
  const [streamReconnectRevision, setStreamReconnectRevision] = useState(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [traceDrawerTarget, setTraceDrawerTarget] = useState<TraceDrawerTarget | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Inline share flow: pick turns directly on the transcript.
  const [shareMode, setShareMode] = useState(false);
  const [selectedShareTurns, setSelectedShareTurns] = useState<Set<string>>(new Set());
  const workspaceEventBus = useWorkspaceEventBus();
  // The session's bound agent (`null` ⇒ default "main") and display name. The
  // composer renders the agent as a non-removable chip and the navbar shows the
  // name as the title; the mobile header bar (FreeGrid) reuses the same hook.
  const { sessionName, pinnedAgentMention, archivedAt, pinnedAt } =
    useSessionIdentity(mainSessionId);
  // Local override so archive/unarchive from the navbar flips the read-only
  // composer immediately; `undefined` defers to the session read (`archivedAt`).
  const [archivedOverride, setArchivedOverride] = useState<boolean | undefined>(undefined);
  const isArchived = archivedOverride ?? archivedAt != null;
  const setArchived = useArchiveSession();
  const setPinned = usePinSession();
  // The override is only a momentary optimistic flip for the navbar handlers.
  // Once the session read reflects the server's archived state (including an
  // archive/unarchive triggered from the sidebar, which refetches via the
  // sessions-changed event), drop the override so server truth wins and a stale
  // override can't keep the composer editable/read-only incorrectly.
  useEffect(() => {
    setArchivedOverride(undefined);
  }, [archivedAt]);

  const composerRef = useRef<ChatComposerHandle>(null);
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
  const {
    contentRef: stickContentRef,
    scrollRef: stickScrollRef,
    isAtBottom,
    scrollToBottom,
  } = useStickToBottom({
    thresholdPx: SCROLL_BOTTOM_THRESHOLD_PX,
  });

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

  useImperativeHandle(
    ref,
    () => ({
      focus: () => composerRef.current?.focus(),
      insertText: (text: string) => composerRef.current?.insertText(text),
    }),
    [],
  );

  // One <Chat> owns the main session but displays & talks to the child sessions
  // of any open handoff. The whole merge / index / floor / identity derivation
  // lives in the pure `buildChatView`; here we just memoize it on the message
  // map, so a streaming turn (which never touches `messages`) never recomputes.
  const mainIdentity = useMemo<AgentIdentity>(
    () => ({
      name: pinnedAgentMention
        ? prettyAgentName(pinnedAgentMention.agentName)
        : mainAgentDisplayName?.trim() || t("roles.agent"),
      iconUrl: pinnedAgentMention?.iconUrl ?? null,
    }),
    [mainAgentDisplayName, pinnedAgentMention, t],
  );
  const view = useMemo(
    () => buildChatView(messages, mainSessionId, mainIdentity),
    [messages, mainSessionId, mainIdentity],
  );
  const { displayMessages, handoffList, floorSessionId, identityBySession, interactionResults } =
    view;

  // Ordered, unique turn ids of the MAIN session — the selectable share unit.
  // Handoff child turns aren't listed here; they ride along with their parent.
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

  const jumpToQuestion = useCallback(
    (messageId: string) => {
      const scroller = scrollerEl;
      if (!scroller) return;
      const anchor = [...scroller.querySelectorAll<HTMLElement>("[data-timeline-anchor]")].find(
        (el) => el.getAttribute("data-timeline-anchor") === messageId,
      );
      if (!anchor) return;
      const top =
        anchor.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      // `auto`, not `smooth`, and deliberately so. use-stick-to-bottom treats a
      // scroll outside its 300ms user-gesture window as accidental drift and
      // snaps back to the bottom while pinned; an instant scroll emits its one
      // event on the frame right after this click's pointerdown, safely inside
      // that window, so the hook releases the pin for us. A smooth scroll's
      // later frames fall outside it. Instant also reads better here: you land
      // and start reading rather than watching half a second of blur.
      scroller.scrollTo({ top: Math.max(top - TIMELINE_JUMP_OFFSET_PX, 0), behavior: "auto" });

      // Every user bubble is the same tint, so without this you cannot tell
      // whether the jump landed on the question you picked.
      window.clearTimeout(landingTimerRef.current);
      for (const el of scroller.querySelectorAll("[data-timeline-landed]")) {
        el.removeAttribute("data-timeline-landed");
      }
      anchor.setAttribute("data-timeline-landed", "");
      landingTimerRef.current = window.setTimeout(() => {
        anchor.removeAttribute("data-timeline-landed");
      }, TIMELINE_LANDING_MS);
    },
    [scrollerEl],
  );

  const enterShareMode = useCallback(() => {
    setSelectedShareTurns(new Set(mainTurnIds));
    setShareMode(true);
  }, [mainTurnIds]);

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

  const floorSessionIdRef = useRef(floorSessionId);
  useEffect(() => {
    floorSessionIdRef.current = floorSessionId;
  }, [floorSessionId]);
  const isReadVisibleSession = useCallback(
    (id: string) => id === mainSessionIdRef.current || id === floorSessionIdRef.current,
    [],
  );
  // The open handoff the floor is inside (null when the floor is the main
  // session) — drives Approve / Cancel / the composer's agent identity.
  const floorHandoff = useMemo(
    () =>
      handoffList.find((h) => h.status === "open" && h.childSessionId === floorSessionId) ?? null,
    [handoffList, floorSessionId],
  );
  const floorIdentity = identityBySession.get(floorSessionId) ?? mainIdentity;

  // Only the floor session streams (every shallower caller is suspended).
  const floorSessionStream = streamingSessions.get(floorSessionId) ?? null;
  const currentSnapshot = floorSessionStream?.snapshot ?? null;
  const runningTurnId = floorSessionStream?.turnId ?? null;
  const isActiveSessionStreaming = !!floorSessionStream;
  // Typewriter-paced reveal of the latest assistant text block — the SSE
  // stream updates in provider-sized chunks; this smooths them into typing.
  // Keyed by turn + block: a new block retypes from zero (delayed fold — it
  // replaces the previous block the moment its first delta arrives).
  const liveAssistantText = useSmoothText(
    floorSessionStream?.assistantText ?? "",
    floorSessionStream
      ? `${floorSessionStream.turnId}:${floorSessionStream.assistantBlockIx}`
      : "idle",
  );

  // Pull host callbacks through refs so the many internal `useCallback`s
  // depending on them don't need to re-create whenever the host swaps in a
  // fresh handler.
  const onSessionsChangedRef = useRef(onSessionsChanged);
  const onSessionNotFoundRef = useRef(onSessionNotFound);
  const onSessionMessageRef = useRef(onSessionMessage);
  useEffect(() => {
    onSessionsChangedRef.current = onSessionsChanged;
  }, [onSessionsChanged]);
  useEffect(() => {
    onSessionNotFoundRef.current = onSessionNotFound;
  }, [onSessionNotFound]);
  useEffect(() => {
    onSessionMessageRef.current = onSessionMessage;
  }, [onSessionMessage]);
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

  useEffect(() => {
    return () => {
      for (const controller of turnStreamControllersRef.current.values()) {
        controller.abort();
      }
      turnStreamControllersRef.current.clear();
    };
  }, []);

  const markSessionRead = useCallback(
    async (id: string) => {
      try {
        await apiMarkSessionRead(id);
        notifySessionsChanged();
      } catch {
        // Best effort. The next successful active-session load can retry.
      }
    },
    [notifySessionsChanged],
  );

  // Delete the current chat from the navbar's "⋯" menu, then refresh the
  // sidebar list and drop back to a fresh chat.
  const handleDeleteSession = useCallback(async () => {
    if (!mainSessionId) return;
    setDeleteConfirmOpen(false);
    try {
      await deleteSession(mainSessionId);
    } catch {
      // best-effort — the list refresh below reconciles either way
    }
    notifySessionsChanged();
    navigate("/chat");
  }, [mainSessionId, notifySessionsChanged, navigate]);

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

  const handlePin = useCallback(async () => {
    if (!mainSessionId) return;
    try {
      await setPinned(mainSessionId, !pinnedAt);
    } catch {
      // Server truth remains unchanged; the next sessions event reconciles.
    }
  }, [mainSessionId, pinnedAt, setPinned]);

  useEffect(() => {
    // The running turn lives in the floor session (the specialist during a
    // handoff), so report that — not main — to the host's turn-follow.
    onSessionMessageRef.current?.({ sessionId: floorSessionId, turnId: runningTurnId });
  }, [runningTurnId, floorSessionId]);

  // Fetch messages for a session
  const loadMessages = useCallback(
    async (id: string, options: { force?: boolean; dropLocalOptimistic?: boolean } = {}) => {
      if (!options.force && loadedSessionsRef.current.has(id)) return;
      // Only mark loaded once we have data in hand. Marking before the await
      // permanently suppressed retries on any failure — the user would land in
      // a silently-empty chat with no recovery short of a page refresh.
      try {
        const data = await listSessionMessages(id);
        if (data === null) {
          // Server says this session doesn't exist (HTTP 404). Hand it back
          // to the host so they can redirect to the draft surface instead of
          // leaving the user staring at an empty active-chat shell.
          onSessionNotFoundRef.current?.(id);
          return;
        }
        const fetchedMessages = orderChatMessages(data);
        const dropMessageIds = options.dropLocalOptimistic
          ? new Set(localOptimisticMessageIdsRef.current.get(id) ?? [])
          : undefined;
        setMessages((prev) => {
          const next = new Map(prev);
          next.set(
            id,
            mergeFetchedChatMessages(next.get(id) ?? [], fetchedMessages, { dropMessageIds }),
          );
          return next;
        });
        if (options.dropLocalOptimistic) {
          localOptimisticMessageIdsRef.current.delete(id);
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
    [isReadVisibleSession, markSessionRead],
  );

  // Load messages when the main session changes (also covers initial mount).
  useEffect(() => {
    if (mainSessionId) {
      loadMessages(mainSessionId);
    }
  }, [mainSessionId, loadMessages]);

  // Load every child session referenced by a handoff so its conversation can be
  // spliced into the flat transcript (Q4 — load the whole tree).
  useEffect(() => {
    for (const h of handoffList) loadMessages(h.childSessionId);
  }, [handoffList, loadMessages]);

  // Subscribe to the main session and the floor (the only one streaming): a
  // handoff's child streams while it holds the floor; the main session streams
  // again once it resumes. Each child owns one EventSource through useSseEvents.
  const sessionEventIds = useMemo(
    () => Array.from(new Set([mainSessionId, floorSessionId])).filter(Boolean),
    [mainSessionId, floorSessionId],
  );
  const handleMessageInsert = useCallback(
    (sid: string, message: ChatMessage) => {
      if (message.sessionId !== sid) return;
      setMessages((prev) => {
        const next = new Map(prev);
        const existing = next.get(sid) ?? [];
        next.set(sid, mergeChatMessage(existing, message));
        return next;
      });
      void markSessionRead(sid);
      onSessionMessageRef.current?.({ sessionId: sid, turnId: message.turnId ?? null });
    },
    [markSessionRead],
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
    scrollToBottom("auto");
  }, [mainSessionId, scrollToBottom]);

  const consumeStream = useCallback(
    async (res: Response, sessionId: string, turnId: string) => {
      if (!res.body) {
        setStreamError(t("stream.errors.emptyStream"));
        return;
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
      let summary: TraceSnapshot["summary"] = {
        distinctApps: [],
        totalSteps: 0,
        invocationCounts: {},
      };
      const flushSnapshot = () => {
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
          // Dead connection. Release the reader and fall through to the
          // final reload; the caller's finally block tears the streaming
          // entry down and the floor reattach poll re-attaches from
          // GET /turns if the turn is in fact still running server-side.
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
              if (!payload.success && payload.error && !isModelResolutionErrorCode(payload.code)) {
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
            shouldStop = true;
            break;
          }
          if (evt.event === "stream_error") {
            try {
              const payload = JSON.parse(evt.data) as Partial<DoneEventData>;
              if (payload.error && !isModelResolutionErrorCode(payload.code)) {
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
              onSessionMessageRef.current?.({
                sessionId,
                turnId,
                segment: seg,
              });
            } catch {
              // ignore parse errors
            }
            continue;
          }
          if (evt.event === "summary_update") {
            try {
              summary = JSON.parse(evt.data) as TraceSnapshot["summary"];
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
              ) as import("@rome/api-types/trace-segments").InputStatusMessage;
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
          if (evt.event === "session_status") {
            // SSE-driven status lets the UI flip the
            // Send/Stop button without polling /stream-status.
            // No-op for now beyond letting it pass through; the per-session
            // streaming entry flips via locally-tracked send/stop.
            continue;
          }
          if (evt.event === "widget_placement") {
            // An action returned `place_widget`: mount the app's widget on the
            // freegrid without parking the agent. autoPlaceApp keys by appId, so
            // a repeat placement retargets the existing tile (to the new
            // route/params) in place rather than stacking duplicates.
            try {
              const { appId, route, params } = JSON.parse(evt.data) as {
                appId?: string;
                route?: string;
                params?: Record<string, string | number | boolean>;
              };
              if (appId) autoPlaceApp(appId, route, params);
            } catch {
              // ignore parse errors
            }
            continue;
          }
        }
      }

      // After stream ends, reload messages from DB (gets both trace + assistant)
      await loadMessages(sessionId, { force: true, dropLocalOptimistic: true });
    },
    [loadMessages, t, updateSessionSnapshot, updateSessionAssistantText],
  );

  useEffect(() => {
    // Reattach to whichever session holds the floor — during a handoff that's
    // the specialist's child session, not the main one (only the floor can have
    // an in-flight turn, since shallower callers are suspended). On reload this
    // re-runs as the floor resolves, so the live preview reattaches correctly.
    const reattachSessionId = floorSessionId;
    if (!reattachSessionId) return;
    if (locallyStreamingSessionIdsRef.current.has(reattachSessionId)) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let streamController: AbortController | null = null;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      pollTimer = setTimeout(() => {
        void runOnce();
      }, delayMs);
    };

    const runOnce = async () => {
      if (cancelled) return;
      // Skip if the foreground send is mid-flight (locallyStreaming was added
      // before its POST, so it catches the window before its per-session
      // entry exists) or a prior reattach hasn't drained yet.
      if (
        locallyStreamingSessionIdsRef.current.has(reattachSessionId) ||
        streamingSessionsRef.current.has(reattachSessionId)
      ) {
        schedule(2000);
        return;
      }
      let attachedTurnId: string | null = null;
      try {
        // List in-flight turns by turnId. Reattach to the running
        // one (or the first queued one) — its events stream is keyed by
        // turnId, so reattach is unambiguous even if more turns arrive
        // while we're polling.
        const turns = await listSessionTurns(reattachSessionId);
        if (!turns || turns.length === 0 || cancelled) return;

        const target = turns.find((t) => t.status === "running") ?? turns[0];
        attachedTurnId = target.turnId;
        startSessionStream(reattachSessionId, attachedTurnId);
        setStreamError(null);

        streamController = createTurnStreamController(attachedTurnId);
        const streamRes = await openTurnStream(attachedTurnId, streamController.signal);
        if (!streamRes.ok) {
          if (streamRes.status !== 404 && !cancelled) {
            setStreamError(t("stream.errors.reconnectStatus", { status: streamRes.status }));
          }
          return;
        }

        await consumeStream(streamRes, reattachSessionId, attachedTurnId);
      } catch {
        // Silent on poll/network blips — keep trying so backend-initiated
        // streams (e.g. queued approvals) eventually attach.
      } finally {
        if (attachedTurnId) {
          if (streamController) {
            releaseTurnStreamController(attachedTurnId, streamController);
            streamController = null;
          }
          // Turn-guarded: this reattach finalizer must only clear the entry
          // it installed. If a newer turn (foreground send or fresh reattach)
          // has replaced it in the meantime, endSessionStream is a no-op.
          endSessionStream(reattachSessionId, attachedTurnId);
        }
        if (!cancelled) {
          schedule(2000);
        }
      }
    };

    void runOnce();

    return () => {
      cancelled = true;
      streamController?.abort();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [
    floorSessionId,
    consumeStream,
    streamReconnectRevision,
    startSessionStream,
    endSessionStream,
    createTurnStreamController,
    releaseTurnStreamController,
    t,
  ]);

  // Shared lifecycle for "post a turn → attach SSE → consume" so both the
  // composer send and the inline app-component submit go through the same
  // bookkeeping (inflight turn set, optimistic user row, stream attach,
  // teardown). Callers supply the post payload + the optimistic user message
  // content (already JSON-serialized MessagePart[]).
  const runTurnLifecycle = useCallback(
    async (
      sendingSessionId: string,
      postTurn: () => Promise<PostTurnResult>,
      optimisticUserContent: string,
    ): Promise<void> => {
      setStreamError(null);
      // Sending re-engages stickiness so the user follows their own message and
      // the reply, even if they'd scrolled up to read history.
      scrollToBottom("auto");
      const wasLocallyStreaming = locallyStreamingSessionIdsRef.current.has(sendingSessionId);
      locallyStreamingSessionIdsRef.current.add(sendingSessionId);

      // The POST result is the acceptance boundary. Whether the composer clears
      // or restores the user's input hinges on this result alone — never on the
      // SSE stream's fate. A turn the server
      // accepted is submitted, full stop; a stream that drops afterwards must
      // not reject back to the composer and bounce the already-sent text into
      // the textarea (the original bug). So a failed submit rejects here; a
      // dropped stream never does.
      const result = await postTurn().catch((err: unknown) => {
        // Transport failure posting the turn — a genuine failed submit.
        if (!wasLocallyStreaming) locallyStreamingSessionIdsRef.current.delete(sendingSessionId);
        setStreamReconnectRevision((revision) => revision + 1);
        setStreamError(t("stream.errors.sendInvalidResponse"));
        throw err;
      });
      if (!result.ok) {
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

      const createResp: CreateTurnResponse = result.data;
      const pendingTurnId = createResp.turnId;
      const turnsForSession = inflightTurnsRef.current.get(sendingSessionId) ?? new Set<string>();

      const userMsg: ChatMessage = {
        id: createResp.inputId ?? crypto.randomUUID(),
        sessionId: sendingSessionId,
        turnId: pendingTurnId,
        inputState: createResp.inputState ?? (createResp.inputId ? "queued" : undefined),
        role: "user",
        content: optimisticUserContent,
        createdAt: new Date().toISOString(),
      };
      const localIds =
        localOptimisticMessageIdsRef.current.get(sendingSessionId) ?? new Set<string>();
      localIds.add(userMsg.id);
      localOptimisticMessageIdsRef.current.set(sendingSessionId, localIds);
      setMessages((prev) => {
        const next = new Map(prev);
        const existing = next.get(sendingSessionId) ?? [];
        next.set(sendingSessionId, mergeChatMessage(existing, userMsg));
        return next;
      });

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

      // turn is already submitted, so a failed attach or a mid-stream drop must
      // never reject this function — that rejection is what used to restore the
      // already-sent input. On any stream failure we just tear our bookkeeping
      // down and let the floor reattach effect re-attach from GET /turns; the
      // turn keeps running server-side.
      void (async () => {
        const streamController = createTurnStreamController(pendingTurnId);
        try {
          const streamRes = await openTurnStream(pendingTurnId, streamController.signal);
          if (!streamRes.ok || !streamRes.body) {
            setStreamError(
              t("stream.errors.attachStreamStatus", {
                turnId: pendingTurnId,
                status: streamRes.status,
              }),
            );
            return;
          }
          await consumeStream(streamRes, sendingSessionId, pendingTurnId);
        } catch {
          // Mid-stream drop (reader rejected, network blip). Silent like the
          // reattach poll: bumping the reconnect revision below re-triggers it.
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
          releaseTurnStreamController(pendingTurnId, streamController);
        }
      })();
    },
    [
      consumeStream,
      endSessionStream,
      startSessionStream,
      streamingSessionsRef,
      t,
      scrollToBottom,
      createTurnStreamController,
      releaseTurnStreamController,
    ],
  );

  // Send a turn into the active session. The composer owns the input state
  // (text/uploads/options); this handler builds the POST and delegates the
  // turn lifecycle to runTurnLifecycle.
  //
  // The session decides whether input joins the active run or starts the next.
  const handleComposerSend = useCallback(
    async (snapshot: ChatComposerSnapshot) => {
      // The single composer talks to whoever holds the floor — the open
      // handoff's specialist, or the main agent.
      const sendingSessionId = floorSessionIdRef.current;
      if (!sendingSessionId) {
        setStreamError(t("stream.errors.sendFallback"));
        throw new Error("Chat: handleComposerSend called without an active session");
      }
      const baseOptimisticText = buildOptimisticUserText(snapshot.text, snapshot.uploads);
      // Mirror the server's persisted form for a structured skill turn
      // (`/<name> task`) so the optimistic row matches what the reload shows.
      const optimisticText = snapshot.skillName
        ? `/${artifactLocalName(snapshot.skillName)}${
            baseOptimisticText.trim() ? ` ${baseOptimisticText}` : ""
          }`
        : baseOptimisticText;
      const optimisticContent = JSON.stringify([{ type: "text", content: optimisticText }]);
      await runTurnLifecycle(
        sendingSessionId,
        async () => {
          const formData = new FormData();
          formData.set("text", snapshot.text);
          if (snapshot.skillName) formData.set("skillName", snapshot.skillName);
          if (snapshot.personaId) formData.set("personaId", snapshot.personaId);
          if (snapshot.largeModelSelection)
            formData.set("largeModelSelection", snapshot.largeModelSelection);
          formData.set("reasoningEffort", snapshot.reasoningEffort);
          for (const upload of snapshot.uploads) {
            formData.append("files", upload.file);
          }
          const ws = snapshotWorkspaceForSend(workspaceContextRegistry);
          if (ws) formData.set("workspace", JSON.stringify(ws));
          // POST returns JSON `{ turnId }`. SSE lives on a
          // separate GET keyed by turnId.
          return postSessionTurn(sendingSessionId, formData);
        },
        optimisticContent,
      );
    },
    [runTurnLifecycle, workspaceContextRegistry, t],
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
      // Post to the session that owns the component (the block's row), not the
      // current floor — they differ when a component lives in another session.
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

  const handleDismissAppComponent = useCallback(
    async (sessionId: string, toolUseId: string) => {
      await handleSubmitAppComponent(sessionId, toolUseId, { dismissed: true });
    },
    [handleSubmitAppComponent],
  );

  // Hand a finished (or dismissed) handoff back to the calling agent. Posts the
  // `interaction_result` on the handoff's PARENT session (not always main —
  // nested handoffs resolve to their immediate caller), which resumes there.
  const handleResolveHandoff = useCallback(
    async (handoff: HandoffNode, output: Record<string, unknown>, label: string) => {
      // Take the resolved node from the caller (which holds the exact handoff),
      // not a lookup by bare toolUseId — provider ids recycle, so a find() could
      // resolve a same-id handoff in a different parent session.
      const sendingSessionId = handoff.parentSessionId;
      const parts = [{ type: "interaction_result", toolUseId: handoff.toolUseId, output }];
      const meta = composerRef.current?.getMetadataSnapshot();
      const body: Record<string, unknown> = { text: label, parts };
      if (meta) {
        if (meta.personaId) body.personaId = meta.personaId;
        body.reasoningEffort = meta.reasoningEffort;
      }
      await runTurnLifecycle(
        sendingSessionId,
        () => postSessionTurnJson(sendingSessionId, body),
        JSON.stringify(parts),
      );
    },
    [runTurnLifecycle],
  );

  // Seed a handoff's specialist with the opening brief as that child session's
  // first turn (rendered as the calling agent's @mention, not a user message).
  const handleSeedHandoff = useCallback(
    async (childSessionId: string, text: string) => {
      const meta = composerRef.current?.getMetadataSnapshot();
      const body: Record<string, unknown> = { text };
      if (meta) {
        if (meta.personaId) body.personaId = meta.personaId;
        body.reasoningEffort = meta.reasoningEffort;
      }
      await runTurnLifecycle(
        childSessionId,
        () => postSessionTurnJson(childSessionId, body),
        JSON.stringify([{ type: "text", content: text }]),
      );
    },
    [runTurnLifecycle],
  );

  // Stop generation for the active streaming session by targeting
  // the specific running turnId; queued turns behind it run normally.
  const stopMessage = useCallback(async () => {
    const sid = floorSessionIdRef.current;
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
  // transcript — runningTurnId/isStreaming only change at turn boundaries.
  const rows = useMemo(
    () =>
      buildRows(displayMessages, identityBySession, mainIdentity, {
        runningTurnId,
        isStreaming: isActiveSessionStreaming,
      }),
    [displayMessages, identityBySession, mainIdentity, runningTurnId, isActiveSessionStreaming],
  );

  // The composer's pinned chip = the floor agent (the specialist during a
  // handoff, the main agent otherwise).
  const floorAgentMention: AgentMention | null = floorHandoff
    ? {
        appId: floorHandoff.appId,
        appLabel: floorHandoff.agentLabel,
        agentName: floorHandoff.agentName ?? floorHandoff.agentLabel,
        iconUrl: `/api/apps/${encodeURIComponent(floorHandoff.appId)}/icon`,
      }
    : pinnedAgentMention;
  // The floor's own (raw, chronological) messages drive the approve /
  // verbal-approval gates — reordering doesn't affect submission detection.
  const floorMessages = messages.get(floorSessionId) ?? EMPTY_MESSAGES;

  // Cancel a still-open handoff (dismiss, no handback).
  const handleCancelHandoff = useCallback(
    (handoff: HandoffNode) => void handleResolveHandoff(handoff, { dismissed: true }, "Dismissed"),
    [handleResolveHandoff],
  );

  // When the floor is a specialist with a pending submission, the composer
  // offers Approve — resolving that handoff with the payload.
  const activeSubmission = useMemo(
    () => (floorHandoff ? findActiveSubmission(floorMessages) : null),
    [floorHandoff, floorMessages],
  );

  // Verbal approval: the specialist relays the guardian's "yes" via
  // confirm_output → a `handback_approved` marker. Resolve with the standing
  // submission. Fires once per handoff — keyed by the child session id (unique
  // per handoff), since toolUseIds recycle and could mis-match the guard.
  const verbalApprovalFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!floorHandoff) return;
    if (verbalApprovalFiredRef.current === floorHandoff.childSessionId) return;
    if (!hasPendingApprovalConfirmation(floorMessages)) return;
    const payload = findLastSubmission(floorMessages);
    if (!payload) return; // confirm with nothing submitted — ignore (fail closed)
    verbalApprovalFiredRef.current = floorHandoff.childSessionId;
    void handleResolveHandoff(floorHandoff, payload, "Approved");
  }, [floorHandoff, floorMessages, handleResolveHandoff]);

  // Seed each open handoff's specialist with the opening brief exactly once — it
  // posts as the child session's first turn (shown as the calling agent's
  // @mention, suppressed as a user bubble).
  //
  // The durable "already seeded" signal is the child being non-empty: a
  // successful seed leaves its persisted message (and reload re-loads it), so we
  // never re-seed; a failed seed rolls back to an empty child, so it retries
  // instead of being permanently skipped. The ref just guards the in-flight
  // window before the optimistic message lands.
  const seedingChildrenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const h of handoffList) {
      if (h.status !== "open" || !h.summary) continue;
      if (!loadedSessionsRef.current.has(h.childSessionId)) continue;
      if ((messages.get(h.childSessionId)?.length ?? 0) > 0) continue;
      if (seedingChildrenRef.current.has(h.childSessionId)) continue;
      const childSessionId = h.childSessionId;
      seedingChildrenRef.current.add(childSessionId);
      void handleSeedHandoff(childSessionId, h.summary).finally(() => {
        seedingChildrenRef.current.delete(childSessionId);
      });
    }
  }, [handoffList, messages, handleSeedHandoff]);

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingFiles(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
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
  const blockActions = useMemo<BlockActions>(
    () => ({
      onApprovalResolved: refreshActiveSession,
      onSubmitAppComponent: handleSubmitAppComponent,
      onDismissAppComponent: handleDismissAppComponent,
      interactionResults,
    }),
    [refreshActiveSession, handleSubmitAppComponent, handleDismissAppComponent, interactionResults],
  );

  // Keyed by (session, turn) so dismissal naturally clears when the turn
  // advances or the user switches sessions.
  const liveDismissedRef = useRef<{ sessionId: string; turnId: string } | null>(null);

  // The live trace always targets the FLOOR session's running turn (the
  // specialist's during a handoff). One builder keeps that (sessionId, turnId)
  // pairing consistent across open + the keep-in-sync effect.
  const buildLiveTraceTarget = useCallback((): TraceDrawerTarget | null => {
    if (!floorSessionId || !runningTurnId) return null;
    return {
      kind: "live",
      sessionId: floorSessionId,
      turnId: runningTurnId,
      summary: currentSnapshot?.summary ?? {
        distinctApps: [],
        totalSteps: 0,
        invocationCounts: {},
      },
      segments: currentSnapshot?.segments ?? [],
      streaming: true,
    };
  }, [floorSessionId, runningTurnId, currentSnapshot]);

  const closeTraceDrawer = useCallback(() => {
    setTraceDrawerTarget((prev) => {
      if (prev?.kind === "live" && floorSessionId && runningTurnId) {
        liveDismissedRef.current = { sessionId: floorSessionId, turnId: runningTurnId };
      }
      return null;
    });
  }, [floorSessionId, runningTurnId]);

  // Open the live trace drawer on demand (e.g. via the trace trigger button).
  const openLiveTraceDrawer = useCallback(() => {
    const target = buildLiveTraceTarget();
    if (!target) return;
    liveDismissedRef.current = null;
    setTraceDrawerTarget(target);
  }, [buildLiveTraceTarget]);

  const openSubagentTraceDrawer = useCallback((node: DelegatedSubagentNode) => {
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
    });
  }, []);

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

  return (
    <TooltipProvider delayDuration={150}>
      {sessionEventIds.map((sid) => (
        <ChatSessionEvents
          key={sid}
          sessionId={sid}
          onMessageInsert={handleMessageInsert}
          onSessionName={handleSessionName}
          onReconnect={resyncSessionMessages}
        />
      ))}
      <div
        className="@container/chat relative flex h-full overflow-hidden"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* ---- Main Chat Area ---- */}
        {/* When the trace drawer is open as a side panel (wide / no-apps layout,
            @5xl/chat) it's `fixed` and out of flow, so reserve its 480px here to
            keep the toolbar, messages, and composer clear of it. In the narrow /
            apps-open layout the drawer covers the chat instead, so no reserve. */}
        <div
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col @5xl/chat:transition-[width] @5xl/chat:duration-200 @5xl/chat:ease-out ${traceDrawerContentInsetClass(
            traceDrawerTarget !== null,
            hasApps,
          )}`}
        >
          {isDraggingFiles && (
            <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-16 border-2 border-dashed border-info bg-info-bg/85 text-ui text-info-fg md:inset-6">
              {t("composer.dropFiles")}
            </div>
          )}
          {/* Top toolbar: the bound agent, the session title, and the "+" widget
              picker / "⋯" menu. Hidden on mobile, where the global header + tab
              pill already cover this. The handoff seam lives inline, not here. */}
          <div className="z-20 flex shrink-0 items-center gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-md supports-[backdrop-filter]:bg-background/65 max-md:hidden">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <AgentAvatar
                iconUrl={pinnedAgentMention?.iconUrl}
                label={pinnedAgentMention?.appLabel}
                size="sm"
                className="shrink-0"
              />
              <span className="truncate text-ui text-foreground">
                {sessionName?.trim() || pinnedAgentMention?.appLabel || t("sidebar.newChat")}
              </span>
              {sessionName?.trim() && pinnedAgentMention && (
                <span className="shrink-0 truncate text-aux text-muted-foreground">
                  {pinnedAgentMention.appLabel}
                </span>
              )}
            </div>
            <WidgetPicker
              onSelect={(type: WidgetType, targetId?: string) => addWidget(type, targetId)}
            >
              <Button
                type="button"
                data-coach="add-widget"
                variant="outline"
                size="sm"
                className="hidden md:inline-flex"
                aria-label={t("navbar.add")}
                title={t("navbar.add")}
              >
                <Plus data-icon="inline-start" className="size-3.5" />
                {t("navbar.addShort")}
              </Button>
            </WidgetPicker>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="sm"
                  label={t("navbar.more")}
                  icon={<MoreHorizontal />}
                  className="text-muted-foreground hover:text-foreground"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void handlePin()}>
                  {pinnedAt ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                  {pinnedAt ? t("navbar.unpin") : t("navbar.pin")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => enterShareMode()}>
                  <Share2 className="size-4" />
                  {t("share.title", "Share chat")}
                </DropdownMenuItem>
                {isArchived ? (
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
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteConfirmOpen(true)}>
                  <Trash2 className="size-4" />
                  {t("navbar.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* The message scroller — the ONLY scrolling node in the chat. It is
              bounded by the /chat viewport shell, so message reflow (mermaid,
              late media) stays inside here and never resizes the document or
              moves the sidebar/composer. `overscroll-contain` kills page-level
              rubber-banding/scroll-chaining; momentum scrolling keeps the iPad
              touch feel. */}
          {/* Positioning + measurement parent for the timeline rail. Its own
              container name matters: `@container/chat` is declared on the outer
              element and does NOT narrow when the trace drawer reserves its
              480px on this column, so a gate keyed to it would show the rail at
              widths where the transcript has no gutter left. */}
          <div className="@container/transcript relative flex min-h-0 flex-1 flex-col">
            {/* The left inset opens the timeline rail's lane. Without it the
                transcript's own `max-w-5xl` body reaches the container edge
                once the container drops under 1024px, and the markers would land
                on the bubbles. Padding sits inside the scroller's border box,
                so the scrollbar does not move — only the content shifts. The
                query MUST match ChatTimelineRail's visibility gate. */}
            <div
              ref={attachScroller}
              className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain @min-[48rem]/transcript:pl-8"
            >
              <MessageList
                rows={rows}
                live={{
                  isStreaming: displayedStreaming,
                  runningTurnId,
                  snapshot: currentSnapshot,
                  text: liveAssistantText,
                  blockIx: floorSessionStream?.assistantBlockIx,
                  sourceText: floorSessionStream?.assistantText,
                  identity: floorIdentity,
                }}
                selection={
                  shareMode
                    ? {
                        active: true,
                        selectedTurns: selectedShareTurns,
                        selectableSessionId: mainSessionId,
                        onToggleTurn: toggleShareTurn,
                      }
                    : undefined
                }
                contentRef={attachContent}
                onOpenLiveTrace={openLiveTraceDrawer}
                onOpenStoredTrace={setTraceDrawerTarget}
                onOpenSubagentTrace={openSubagentTraceDrawer}
                activeTraceTarget={traceDrawerTarget}
                subagentIconByName={subagentIconByName}
                actions={blockActions}
                feedback
              />

              {/* The single floating composer — a `sticky bottom-0` floor inside the
                message scroller, so messages scroll behind its translucent blur
                ("scroll under the composer") instead of stopping at a solid dock.
                It talks to whoever holds the floor (the open handoff's specialist,
                or the main agent). In share mode it's swapped for the ShareBar,
                which configures + mints the link for the turns selected above. */}
              <div className="pointer-events-none sticky bottom-0 z-10 px-3 pb-[calc(var(--rome-safe-area-bottom)+1rem)] md:px-6 md:pb-[calc(var(--rome-safe-area-bottom)+1.5rem)]">
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
                    isAtBottom ? "invisible opacity-0" : "visible opacity-100",
                  )}
                />
                <div className="pointer-events-auto mx-auto max-w-5xl">
                  {shareMode ? (
                    <ShareBar
                      sessionId={mainSessionId}
                      selectedTurnIds={[...selectedShareTurns]}
                      onExit={exitShareMode}
                    />
                  ) : isArchived ? (
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
                  ) : (
                    <ChatComposer
                      ref={composerRef}
                      // The box look lives on the composer now so the chip row can sit
                      // outside it; this mount adds the floating blur/translucency.
                      boxClassName="rounded-16 border border-border bg-surface/95 p-4 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
                      onSend={handleComposerSend}
                      isStreaming={displayedStreaming}
                      onStop={() => void stopMessage()}
                      streamError={streamError}
                      // The chip names the floor agent — the specialist during a
                      // handoff, the main agent otherwise.
                      pinnedAgentMention={floorAgentMention}
                      lockAgentMention
                      designingInteraction={
                        floorHandoff
                          ? {
                              agentLabel: floorHandoff.agentLabel,
                              // A pending submission turns the banner into an Approve
                              // that resolves the handoff with that payload.
                              onApprove: activeSubmission
                                ? () =>
                                    void handleResolveHandoff(
                                      floorHandoff,
                                      activeSubmission.payload,
                                      "Approved",
                                    )
                                : undefined,
                              // Cancel lives here now (off the @mention seam): dismiss
                              // the handoff and hand the floor back to the caller.
                              onCancel: () => handleCancelHandoff(floorHandoff),
                            }
                          : null
                      }
                    />
                  )}
                </div>
              </div>
            </div>
            <ChatTimelineRail
              scroller={scrollerEl}
              content={contentEl}
              questions={timelineQuestions}
              onJump={jumpToQuestion}
            />
          </div>
        </div>
        <TraceDrawer
          target={traceDrawerTarget}
          onClose={closeTraceDrawer}
          hasApps={hasApps}
          renderInlineBlock={(block, key) =>
            renderSingleBlock(block as StreamBlock, key, {
              onApprovalResolved: refreshActiveSession,
              compact: true,
            })
          }
          renderRunBlocks={(blocks, live) =>
            renderFlatBlocks(blocks as StreamBlock[], {
              onApprovalResolved: refreshActiveSession,
              compact: true,
              live,
            })
          }
        />
        <RomeConfirmDialog
          open={deleteConfirmOpen}
          destructive
          title={t("navbar.delete")}
          description={t("navbar.deleteConfirm")}
          confirmLabel={t("navbar.delete")}
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={() => void handleDeleteSession()}
        />
      </div>
    </TooltipProvider>
  );
});
