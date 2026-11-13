import {
  Archive,
  ArchiveRestore,
  Check,
  Ellipsis,
  Folder,
  Cloud,
  FolderOpen,
  Laptop,
  MessageCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChatBubbleIcon } from "@radix-ui/react-icons";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteSession, renameSession, type SessionScope } from "@/lib/chat-api";
import { DEFAULT_PROJECT_NAME } from "@/lib/chat-constants";
import type { ChatSession } from "@/lib/chat-types";
import { deviceFolderName, pathSegments } from "@/lib/device-folder";
import {
  activeSessionFromPath,
  chatKind,
  isProjectChat,
  MAIN_CHAT_PATH,
  sessionActivityTime,
} from "@/lib/chat-session";
import {
  type ChatListMode,
  initialChatListMode,
  newChatShortcutForPlatform,
  readChatListMode,
  writeChatListMode,
} from "@/lib/chat-list-mode";
import { useStoredChatListMode } from "@/hooks/use-chat-list-mode";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import {
  CONCIERGE_CHATS_QUERY_KEY,
  useConciergeChatId,
  useConciergeChats,
  useConciergeName,
  useRefreshTopicChats,
} from "@/hooks/use-concierge";
import { useDesktop } from "@/hooks/use-desktop";
import { chatSessionTopic, chatStatusTopic, useLiveEvents } from "@/hooks/use-live-events";
import { useMediaQuery } from "@/hooks/use-media-query";
import { ConciergeChats } from "./ConciergeEntry";
import { isElectronShell } from "@/lib/electron-shell";
import { STANDALONE_DISPLAY_QUERY } from "@/lib/media-query";
import { emitSessionsChanged, useArchiveSession } from "@/lib/session-events";
import { ACTIVE_CLASS, IDLE_CLASS, LINK_CLASS } from "./sidebar-shared";

/** What a chat row's mark says. Waiting, running and failed describe the chat,
 *  so they show even while it is open; done means unseen replies, so the open
 *  chat never shows it. */
export type ChatRowStatus = "waiting" | "running" | "failed" | "done";

export function chatRowStatus(
  session: Pick<ChatSession, "running" | "lastTurnFailed" | "awaitingGuardian" | "unread">,
  isActive: boolean,
): ChatRowStatus | null {
  // The list hides lastTurnFailed and awaitingGuardian while a turn runs, and
  // a live start clears them, so neither outranks a running turn.
  if (session.awaitingGuardian) return "waiting";
  if (session.lastTurnFailed) return "failed";
  if (session.running) return "running";
  if (session.unread && !isActive) return "done";
  return null;
}

function withLiveRunning<
  T extends Pick<ChatSession, "id" | "running" | "lastTurnFailed" | "awaitingGuardian">,
>(session: T, live: ReadonlyMap<string, boolean>): T {
  const running = live.get(session.id);
  if (running === undefined) return session;
  if (!running) return { ...session, running };
  return { ...session, running, lastTurnFailed: false, awaitingGuardian: false };
}

const sessionRunningSchema = z.object({ sessionId: z.string(), running: z.boolean() });

// Same shapes as the browser tab badge: an open ring (spinning here), an
// exclamation mark, a cross and a check mark.
function ChatStatusGlyph({ status }: { status: ChatRowStatus }) {
  if (status === "running") {
    return (
      <span className="rome-status-spin flex h-4 w-4">
        <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-running" aria-hidden>
          <circle
            cx="8"
            cy="8"
            r="5.5"
            stroke="currentColor"
            strokeOpacity="0.2"
            strokeWidth="1.75"
          />
          <path
            d="M8 2.5A5.5 5.5 0 1 1 2.5 8"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-destructive" aria-hidden>
        <path
          d="M4.5 4.5l7 7M11.5 4.5l-7 7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (status === "waiting") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-warning" aria-hidden>
        <line
          x1="8"
          y1="3"
          x2="8"
          y2="7.75"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="8" cy="12.5" r="1.55" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-success" aria-hidden>
      <polyline
        points="3.5,8.5 6.75,11.5 12.5,4.75"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type LoadPhase = "loading" | "ready" | "error";
type StatusFilter = "all" | "active" | "archived";

interface SessionGroup {
  key: string;
  label: string;
  items: ChatSession[];
  latest: number;
  projectPath: string;
  /** Set for a group of chats that work in one folder on a device. */
  deviceFolder?: NonNullable<ChatSession["deviceFolder"]>;
}

const SCOPE_STORAGE_KEY = "rome-recent-chats-scope";
const STATUS_FILTER_STORAGE_KEY = "rome-recent-chats-status-filter";
const COLLAPSED_GROUPS_STORAGE_KEY = "rome-recent-chats-collapsed-groups";

function readScope(): SessionScope {
  if (typeof window === "undefined") return "mine";
  return window.localStorage.getItem(SCOPE_STORAGE_KEY) === "all" ? "all" : "mine";
}

function readStatusFilter(): StatusFilter {
  if (typeof window === "undefined") return "active";
  const raw = window.localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
  return raw === "all" || raw === "archived" ? raw : "active";
}

function readStringSetFromStorage(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // ignore
  }
  return new Set();
}

function projectNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;
}

function isDefaultProjectChat(session: ChatSession): boolean {
  return (
    session.projectPath === DEFAULT_PROJECT_NAME ||
    session.projectName === DEFAULT_PROJECT_NAME ||
    (!session.projectPath && !session.projectName)
  );
}

/** The group key of a device-folder group. The `device:` prefix and the device id keep it apart from project paths. */
function deviceFolderKey(folder: NonNullable<ChatSession["deviceFolder"]>): string {
  return `device:${folder.deviceId}:${folder.path}`;
}

/** A device-folder chat belongs to no project: its group is its folder. */
function projectPathForSession(session: ChatSession): string {
  if (session.deviceFolder) return "";
  return isDefaultProjectChat(session) ? DEFAULT_PROJECT_NAME : session.projectPath || "";
}

/** A project row's plus: hidden until the row is hovered, shown at once on touch. */
const PROJECT_PLUS_CLASS =
  "touch-show mr-1 shrink-0 rounded-4 p-1 text-subtle-foreground opacity-0 transition-opacity hover:text-foreground focus:outline-none focus-visible:opacity-100 group-hover/project:opacity-100";

/** The new chat page with the project chosen, as an address a new tab can open. */
function newChatInProjectHref(projectPath: string): string {
  return `/chat?project=${encodeURIComponent(projectPath)}`;
}

const PROJECT_DEFAULT_VISIBLE = 4;
const PROJECT_LOAD_MORE_COUNT = 10;
// Keep in sync with the server-side cap in webchat.ts (PATCH /chat/sessions/:id/name).
const SESSION_NAME_MAX_LENGTH = 50;

/**
 * The chat's name, linking to the chat. Its tooltip shows the full name while
 * the sidebar is too narrow to show it whole.
 */
function ChatRowLink({
  id,
  name,
  nested,
  marker,
}: {
  id: string;
  name: string;
  nested: boolean;
  /** Names who started the chat, shown as a small mark after the name. */
  marker?: string;
}) {
  // Whether the one-line name is actually clipped ("Rewrite the sessi…").
  // Measured lazily right before the tooltip could open (pointerenter /
  // focus) rather than with a ResizeObserver: the answer only matters at that
  // moment, and hover-time measurement stays correct across sidebar resizes
  // and rename edits for free.
  const [nameClipped, setNameClipped] = useState(false);
  const nameRef = useRef<HTMLSpanElement>(null);

  const syncNameClipped = () => {
    const el = nameRef.current;
    setNameClipped(el !== null && el.scrollWidth > el.clientWidth);
  };

  return (
    // The bubble mounts only while the name is actually clipped, so a short
    // name never grows one that just repeats what the row already shows.
    // Hoverable content is off: it is pure text, and Radix's grace area would
    // otherwise keep the previous row's name floating while the pointer runs
    // down the list.
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <Link
          to={`/chat/${id}`}
          onPointerEnter={syncNameClipped}
          onFocus={syncNameClipped}
          className={`flex h-full min-w-0 flex-1 items-center rounded-8 border border-transparent pr-1 outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 ${
            nested ? "pl-4" : "pl-2"
          }`}
        >
          <span ref={nameRef} className="truncate">
            {name}
          </span>
          {marker ? (
            <ChatBubbleIcon
              role="img"
              aria-label={marker}
              className="ml-2 h-3 w-3 shrink-0 text-subtle-foreground"
            />
          ) : null}
        </Link>
      </TooltipTrigger>
      {/* Right of the row, so the bubble reaches into the page rather than
          covering the neighbouring chats it was opened to compare against. */}
      {nameClipped ? <TooltipContent side="right">{name}</TooltipContent> : null}
    </Tooltip>
  );
}

/** How many task chats show before the More row. */
const TASK_CHATS_VISIBLE = 5;

const MORE_ROW_CLASS =
  "rounded-4 border border-transparent py-1 pr-1 text-left text-aux min-h-[var(--control-min-h)] text-subtle-foreground transition outline-none hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

/** A dot on a segment's corner that says the other mode needs a look. */
function ModeDot({ label, className }: { label: string; className: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={`absolute right-0.5 top-0.5 size-1.5 rounded-full ${className}`}
    />
  );
}

/**
 * Switches the list between ordinary chats and the Concierge's. A dot on the
 * segment of the mode that is not showing says something there wants a look:
 * unread Concierge messages, or an ordinary chat replying.
 */
function ChatModeSwitch({
  mode,
  onChange,
  conciergeUnread,
  chatReplying,
}: {
  mode: ChatListMode;
  onChange: (mode: ChatListMode) => void;
  conciergeUnread: boolean;
  chatReplying: boolean;
}) {
  const { t } = useTranslation("common");
  const chatName = t("recentChats.modeChat");
  const conciergeName = t("recentChats.modeConcierge");
  return (
    <SegmentedControl<ChatListMode>
      size="sm"
      aria-label={t("recentChats.modeSwitch")}
      value={mode}
      onValueChange={onChange}
      className="ml-1 shrink-0"
      options={[
        {
          value: "chat",
          title: chatName,
          icon: <MessageCircle aria-hidden />,
          label: (
            <>
              <span className="sr-only">{chatName}</span>
              {mode === "concierge" && chatReplying ? (
                <ModeDot label={t("recentChats.modeChatReplying")} className="bg-primary" />
              ) : null}
            </>
          ),
        },
        {
          value: "concierge",
          title: conciergeName,
          icon: <RomeLogo aria-hidden />,
          label: (
            <>
              <span className="sr-only">{conciergeName}</span>
              {mode === "chat" && conciergeUnread ? (
                <ModeDot label={t("recentChats.modeConciergeUnread")} className="bg-destructive" />
              ) : null}
            </>
          ),
        },
      ]}
    />
  );
}

/** The list's top row: opens a blank chat, an ordinary one or a topic chat. */
function NewChatRow({
  kind,
  label,
  shortcut,
}: {
  kind: "chat" | "topic";
  label: string;
  /** Shown beside the label where a keyboard has it. */
  shortcut: string | null;
}) {
  return (
    <Link
      to="/chat"
      state={kind === "topic" ? { conciergeTopic: true } : undefined}
      data-new-chat-row={kind}
      className={`${LINK_CLASS} ${IDLE_CLASS} mb-1`}
    >
      <Plus className="h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      {shortcut ? (
        <kbd className="shrink-0 font-sans text-aux text-subtle-foreground">{shortcut}</kbd>
      ) : null}
    </Link>
  );
}

export interface RecentChatsProps {
  /** Extra buttons after the list's own, such as the shell's collapse control. */
  headerControls?: ReactNode;
  /** A control before the title, such as the phone drawer's way back to the rail. */
  headerLeading?: ReactNode;
  /** Sit closer to the top, where a title bar above already holds the window's edge. */
  belowTitlebar?: boolean;
}

// The sidebar's second column: the header stays put while the list scrolls.
export function RecentChats({
  headerControls,
  headerLeading,
  belowTitlebar = false,
}: RecentChatsProps) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  // A project's plus opens its chat in a new tab, so the chat on screen stays
  // open, wherever there are tabs to open: a wide window of a normal browser.
  // A phone, the installed home-screen app, the Mac app and the mobile app's
  // WebView have none, and a new tab there would take the user out of Rome.
  // The touch signal is the one AppGrid uses for the WebView, which sets no
  // marker of its own.
  const wideWindow = useDesktop();
  const installedApp = useMediaQuery(STANDALONE_DISPLAY_QUERY);
  const coarsePointer = useCoarsePointer();
  const plusOpensNewTab = wideWindow && !installedApp && !coarsePointer && !isElectronShell();
  const [scope, setScope] = useState<SessionScope>(() => readScope());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => readStatusFilter());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    readStringSetFromStorage(COLLAPSED_GROUPS_STORAGE_KEY),
  );
  const [visibleGroupCounts, setVisibleGroupCounts] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renamingRef = useRef(false);

  const {
    sessions: cachedSessions,
    isError,
    refetch,
    update: updateSessions,
  } = useChatSessions(statusFilter, scope);
  // Cached rows show at once and a failed refetch keeps them, so the skeleton
  // is only for a list that has never loaded.
  const phase: LoadPhase = isError ? "error" : cachedSessions ? "ready" : "loading";

  // The newest running state the status stream has reported per chat, applied
  // over every list response: one can be older than an event that arrived
  // while it was in flight. Per mount, since events stop while unmounted; the
  // remount's refetch reconciles whatever was missed.
  const liveRunning = useRef(new Map<string, boolean>());
  const sessions = useMemo(
    () =>
      (cachedSessions ?? [])
        // Concierge chats have their own rows above; every other chat,
        // task chats included, sits under its project.
        .filter((s) => chatKind(s) !== "topic")
        .map((s) => withLiveRunning(s, liveRunning.current)),
    [cachedSessions],
  );
  const conciergeChatId = useConciergeChatId();
  const conciergeName = useConciergeName();
  const conciergeChats = useConciergeChats();
  // Without a Concierge there is nothing to switch to: the list is the
  // ordinary chats alone.
  const hasConcierge = conciergeChatId !== null;
  // Refetches the chat list and the Concierge's list together.
  const refreshTopicChats = useRefreshTopicChats();
  // The Concierge section draws its topic chats from these: an archived one
  // is only here, and an active one takes its place in the order from here.
  const conciergeTopicSessions = useMemo(
    () => (cachedSessions ?? []).filter((s) => chatKind(s, conciergeChatId) === "topic"),
    [cachedSessions, conciergeChatId],
  );
  const routeSessionId = activeSessionFromPath(location.pathname, conciergeChatId);
  const storedMode = useStoredChatListMode();
  const hasOrdinaryChat = (cachedSessions ?? []).some((s) =>
    isProjectChat(chatKind(s, conciergeChatId)),
  );
  // A device with no stored mode starts where its chats are, once the list
  // has said.
  const mode: ChatListMode = !hasConcierge
    ? "chat"
    : (storedMode ?? (cachedSessions ? initialChatListMode(hasOrdinaryChat) : "chat"));
  useEffect(() => {
    if (!hasConcierge || !cachedSessions || readChatListMode() !== null) return;
    writeChatListMode(initialChatListMode(hasOrdinaryChat));
  }, [hasConcierge, cachedSessions, hasOrdinaryChat]);
  // The router renders a navigation as a transition, so the location stays
  // on the old chat until the new one has rendered, which takes a moment
  // when the old one is long. The row a click opens is marked at once, as an
  // urgent update, and gives way when the location arrives.
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  useEffect(() => setOpeningSessionId(null), [routeSessionId]);
  const activeSessionId = openingSessionId ?? routeSessionId;
  // The Concierge entry recounts unread on a new main chat message while it
  // shows. In Chat mode it does not, and the switch's dot needs the same count
  // from the Concierge's chats alone.
  const queryClient = useQueryClient();
  const recountConciergeChats = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONCIERGE_CHATS_QUERY_KEY });
  }, [queryClient]);
  useLiveEvents(
    chatSessionTopic(conciergeChatId ?? ""),
    { message_insert: { schema: z.unknown(), fn: recountConciergeChats } },
    { enabled: hasConcierge && mode === "chat", onReconnect: recountConciergeChats },
  );
  // The chat on screen reads what arrives, so its unread count is stale. A task
  // chat is Concierge's too, and one that waits for the guardian needs a look.
  const conciergeUnread =
    conciergeChats.some((chat) => chat.unread > 0 && chat.id !== activeSessionId) ||
    sessions.some(
      (s) =>
        chatKind(s, conciergeChatId) === "task" &&
        chatRowStatus(s, s.id === activeSessionId) === "waiting",
    );
  const chatReplying = sessions.some(
    (s) => s.running && isProjectChat(chatKind(s, conciergeChatId)),
  );
  const markOpening = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const link = (event.target as Element).closest("a[href]");
      if (!link || link.getAttribute("target")) return;
      const opened = activeSessionFromPath(
        new URL(link.getAttribute("href") ?? "", window.location.origin).pathname,
        conciergeChatId,
      );
      // A click back on the chat already open cancels a mark still waiting.
      if (opened) setOpeningSessionId(opened === routeSessionId ? null : opened);
    },
    [conciergeChatId, routeSessionId],
  );

  // A chat that starts running before the list has it, such as a task chat
  // Concierge just started, would show only when its first turn ends. The
  // list is asked again once per such chat. A chat that is still not in it
  // after that, such as one on another filter or page, is remembered, so its
  // running state never asks again.
  const listedIds = useRef(new Set<string>());
  listedIds.current = new Set((cachedSessions ?? []).map((s) => s.id));
  const refetchedFor = useRef(new Set<string>());
  const absentAfterRefetch = useRef(new Set<string>());
  const refetchForUnknown = (sessionId: string) => {
    if (
      listedIds.current.has(sessionId) ||
      refetchedFor.current.has(sessionId) ||
      absentAfterRefetch.current.has(sessionId)
    ) {
      return;
    }
    refetchedFor.current.add(sessionId);
    void refetch()
      .then((result) => {
        if (!result.data?.some((s) => s.id === sessionId)) {
          absentAfterRefetch.current.add(sessionId);
        }
      })
      .finally(() => refetchedFor.current.delete(sessionId));
  };

  // Live running state. A stop refetches the list for unread and
  // lastTurnFailed, and a reconnect refetches whatever changed meanwhile.
  useLiveEvents(
    chatStatusTopic,
    {
      session_running: {
        schema: sessionRunningSchema,
        fn: ({ sessionId, running }) => {
          liveRunning.current.set(sessionId, running);
          updateSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? withLiveRunning(s, liveRunning.current) : s)),
          );
          // A turn's end can change any chat's unread state, a topic chat's
          // included, whether or not its row is shown.
          if (!running) refreshTopicChats();
          else refetchForUnknown(sessionId);
        },
      },
    },
    {
      // Events missed while disconnected are gone, so start over from the list
      // and the snapshot the new connection sends.
      onReconnect: () => {
        liveRunning.current.clear();
        refreshTopicChats();
      },
    },
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STATUS_FILTER_STORAGE_KEY, statusFilter);
  }, [statusFilter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify(Array.from(collapsedGroups)),
    );
  }, [collapsedGroups]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  }, [scope]);

  // Projects mark their location only once some chat lives on a device;
  // until then the list stays as it was.
  const hasDeviceFolders = useMemo(
    () => sessions.some((session) => Boolean(session.deviceFolder)),
    [sessions],
  );

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a)),
    [sessions],
  );

  // Task chats list under Tasks in Concierge mode and nowhere in Chat mode.
  // With no Concierge they stay under their project, as before.
  const projectSessions = useMemo(
    () =>
      hasConcierge
        ? sortedSessions.filter((s) => chatKind(s, conciergeChatId) !== "task")
        : sortedSessions,
    [hasConcierge, sortedSessions, conciergeChatId],
  );
  const taskSessions = useMemo(
    () =>
      hasConcierge ? sortedSessions.filter((s) => chatKind(s, conciergeChatId) === "task") : [],
    [hasConcierge, sortedSessions, conciergeChatId],
  );
  const [tasksExpanded, setTasksExpanded] = useState(false);

  const projectGroups = useMemo<SessionGroup[]>(() => {
    const buckets = new Map<
      string,
      {
        label: string;
        items: ChatSession[];
        projectPath: string;
        deviceFolder?: SessionGroup["deviceFolder"];
      }
    >();
    for (const session of projectSessions) {
      const folder = session.deviceFolder;
      if (folder) {
        const rawKey = deviceFolderKey(folder);
        const bucket = buckets.get(rawKey) ?? {
          label: deviceFolderName(folder.path),
          items: [],
          projectPath: "",
          deviceFolder: folder,
        };
        bucket.items.push(session);
        buckets.set(rawKey, bucket);
        continue;
      }
      const projectPath = projectPathForSession(session);
      const rawKey = projectPath || session.projectName || "";
      if (!rawKey) continue;
      const label = session.projectName || projectNameFromPath(projectPath);
      const bucket = buckets.get(rawKey) ?? {
        label,
        items: [],
        projectPath,
      };
      bucket.items.push(session);
      buckets.set(rawKey, bucket);
    }
    // The default project always has a row, chats or not, since its plus is
    // where a common chat usually starts.
    if (!buckets.has(DEFAULT_PROJECT_NAME)) {
      buckets.set(DEFAULT_PROJECT_NAME, {
        label: DEFAULT_PROJECT_NAME,
        items: [],
        projectPath: DEFAULT_PROJECT_NAME,
      });
    }
    return (
      Array.from(buckets.entries())
        .map(([rawKey, { label, items, projectPath, deviceFolder }]) => ({
          key: `project:${rawKey}`,
          label,
          items,
          latest: items[0] ? sessionActivityTime(items[0]) : 0,
          projectPath,
          deviceFolder,
        }))
        // The default project leads, whatever moved last.
        .sort(
          (a, b) =>
            Number(b.projectPath === DEFAULT_PROJECT_NAME) -
              Number(a.projectPath === DEFAULT_PROJECT_NAME) || b.latest - a.latest,
        )
    );
  }, [projectSessions]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadMore = useCallback((key: string) => {
    setVisibleGroupCounts((prev) => ({
      ...prev,
      [key]: (prev[key] ?? PROJECT_DEFAULT_VISIBLE) + PROJECT_LOAD_MORE_COUNT,
    }));
  }, []);

  const archiveMutation = useArchiveSession();
  const setArchived = useCallback(
    async (id: string, archived: boolean) => {
      try {
        // PATCH + broadcast the sessions-changed event; the listener above
        // refetches so every view reconciles to server truth.
        await archiveMutation(id, archived);
      } catch {
        // Server unchanged — leave the list as-is and skip the optimistic flip.
        return;
      }
      updateSessions((prev) => {
        // Drop the row when it no longer matches the active filter (archiving
        // under "active", unarchiving under "archived"); otherwise reflect the
        // new flag in place (the "all" view). Archiving never forces navigation.
        if ((statusFilter === "active" && archived) || (statusFilter === "archived" && !archived)) {
          return prev.filter((s) => s.id !== id);
        }
        return prev.map((s) =>
          s.id === id ? { ...s, archivedAt: archived ? new Date().toISOString() : null } : s,
        );
      });
    },
    [archiveMutation, statusFilter, updateSessions],
  );

  const handleUnarchive = useCallback(
    async (id: string) => {
      await setArchived(id, false);
    },
    [setArchived],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
      } catch {
        // ignore — refetch anyway
      }
      updateSessions((prev) => prev.filter((s) => s.id !== id));
      emitSessionsChanged();
      if (activeSessionId === id) {
        navigate(MAIN_CHAT_PATH);
      }
    },
    [activeSessionId, navigate, updateSessions],
  );

  const startRename = useCallback((session: ChatSession) => {
    // Rename is the one row action that moves focus into the row, so the
    // closing menu must not restore focus on top of it. The flag tells the
    // menu below to skip that restore.
    renamingRef.current = true;
    // Defer entering edit mode until the row menu has fully closed, so its
    // focus restoration doesn't blur (and prematurely commit) the new input.
    setEditingValue(session.name);
    setTimeout(() => setEditingId(session.id), 0);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditingValue("");
  }, []);

  const commitRename = useCallback(
    async (id: string) => {
      const name = editingValue.trim();
      const current = sessions.find((s) => s.id === id);
      // Empty/whitespace-only or unchanged names revert without a round-trip.
      if (name.length === 0 || (current && current.name === name)) {
        cancelRename();
        return;
      }
      setEditingId(null);
      setEditingValue("");
      updateSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
      try {
        await renameSession(id, name);
      } catch {
        // Server rejected/unchanged — the refetch below reconciles either way.
      }
      emitSessionsChanged();
    },
    [editingValue, sessions, cancelRename, updateSessions],
  );

  // Focus and select the rename field as soon as it mounts.
  useEffect(() => {
    if (editingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [editingId]);

  const renderChatRow = (session: ChatSession, nested = false) => {
    const isActive = activeSessionId === session.id;
    const status = chatRowStatus(session, isActive);
    const statusLabel = status ? t(`recentChats.rowStatus.${status}`) : null;
    const isEditing = editingId === session.id;
    const beginRename = () => startRename(session);
    const toggleArchive = session.archivedAt
      ? () => void handleUnarchive(session.id)
      : () => void setArchived(session.id, true);
    const shortcuts: Record<string, () => void> = {
      r: beginRename,
      a: toggleArchive,
    };
    return (
      <div
        key={session.id}
        data-chat-row
        className={`group flex h-8 items-center gap-1 rounded-8 text-ui transition min-h-[var(--control-min-h)] ${
          session.archivedAt ? "text-subtle-foreground" : "text-foreground"
        } ${
          isActive
            ? "bg-surface shadow-1 dark:bg-surface-hover"
            : "hover:bg-surface-hover dark:hover:bg-surface"
        }`}
      >
        {isEditing ? (
          <input
            ref={renameInputRef}
            type="text"
            value={editingValue}
            maxLength={SESSION_NAME_MAX_LENGTH}
            aria-label={t("recentChats.renameLabel")}
            onChange={(event) => setEditingValue(event.target.value)}
            onBlur={() => void commitRename(session.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename(session.id);
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
            className={`my-1 h-[var(--control-h-sm)] min-w-0 flex-1 rounded-4 border border-foreground/20 bg-background px-1 py-1 text-ui text-foreground outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 ${
              nested ? "ml-4" : "ml-2"
            }`}
          />
        ) : (
          <ChatRowLink
            id={session.id}
            name={session.name}
            nested={nested}
            marker={
              chatKind(session) === "task"
                ? t("recentChats.startedByConcierge", { name: conciergeName })
                : undefined
            }
          />
        )}
        <span
          className={`relative mr-2 flex h-4 w-4 shrink-0 items-center justify-center ${
            isEditing ? "hidden" : ""
          }`}
        >
          {status ? (
            <span
              className="flex transition-opacity group-hover:opacity-0"
              role="img"
              aria-label={statusLabel ?? undefined}
            >
              <ChatStatusGlyph status={status} />
            </span>
          ) : null}
          <DropdownMenu
            open={openMenuId === session.id}
            onOpenChange={(open) => setOpenMenuId(open ? session.id : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("recentChats.chatActions")}
                title={t("recentChats.chatActions")}
                className="absolute inset-0 flex items-center justify-center rounded-4 p-1 text-subtle-foreground opacity-0 transition-opacity hover:text-foreground focus:outline-none focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Ellipsis className="h-3 w-3" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="end"
              onCloseAutoFocus={(event) => {
                // Radix restores focus to the trigger as the menu closes, but
                // the trigger is display:none while the row is renaming, so the
                // restore lands on <body> and blurs the rename input — which
                // commits the rename before a key is typed. The rename path
                // owns focus, so skip the restore there and leave it for every
                // other action, where returning to the trigger is right.
                if (!renamingRef.current) return;
                renamingRef.current = false;
                event.preventDefault();
              }}
              onKeyDown={(event) => {
                // Radix composes this ahead of its own typeahead and drops that
                // handler once the event is defaulted. Without the preventDefault
                // a bare letter only moves focus to the item it spells.
                if (event.ctrlKey || event.altKey || event.metaKey) return;
                const run = shortcuts[event.key.toLowerCase()];
                if (!run) return;
                event.preventDefault();
                run();
                setOpenMenuId(null);
              }}
            >
              <DropdownMenuItem aria-keyshortcuts="R" onSelect={beginRename}>
                <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("recentChats.rename")}
                <DropdownMenuShortcut aria-hidden>R</DropdownMenuShortcut>
              </DropdownMenuItem>
              {session.archivedAt ? (
                <DropdownMenuItem aria-keyshortcuts="A" onSelect={toggleArchive}>
                  <ArchiveRestore className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t("recentChats.unarchive")}
                  <DropdownMenuShortcut aria-hidden>A</DropdownMenuShortcut>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem aria-keyshortcuts="A" onSelect={toggleArchive}>
                  <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t("recentChats.archive")}
                  <DropdownMenuShortcut aria-hidden>A</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setPendingDeleteId(session.id)}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("recentChats.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
    );
  };

  const renderProjectGroup = ({ key, label, items, projectPath, deviceFolder }: SessionGroup) => {
    // An empty group is just its row: nothing to expand or collapse.
    const empty = items.length === 0;
    const collapsed = empty || collapsedGroups.has(key);
    const visibleCount = visibleGroupCounts[key] ?? PROJECT_DEFAULT_VISIBLE;
    const visibleItems = items.slice(0, visibleCount);
    const remainingCount = Math.max(items.length - visibleCount, 0);
    const projectLabel = (
      <>
        {collapsed ? (
          <Folder className="h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />
        ) : (
          <FolderOpen className="h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />
        )}
        <span className="truncate">{label}</span>
        {/* Where the group works: another computer, or Rome Cloud once any
            chat lives on a device. Only the icon opens the tooltip: on the
            whole row it would cover the row's new chat button. */}
        {deviceFolder ? (
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <span
                data-location-icon="device"
                className="-ml-1 flex shrink-0 text-subtle-foreground"
              >
                <Laptop className="h-3.5 w-3.5" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">
              <span className="flex flex-col">
                <span className="whitespace-nowrap">{deviceFolder.deviceName}</span>
                <span className="text-background/70">
                  {/* A long path wraps only between its segments. */}
                  {pathSegments(deviceFolder.path).map((segment) => (
                    <span key={segment.key}>
                      {segment.text}
                      <wbr />
                    </span>
                  ))}
                </span>
              </span>
            </TooltipContent>
          </Tooltip>
        ) : hasDeviceFolders ? (
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <span
                data-location-icon="rome"
                className="-ml-1 flex shrink-0 text-subtle-foreground"
              >
                <Cloud className="h-3.5 w-3.5" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{t("recentChats.romeCloud")}</TooltipContent>
          </Tooltip>
        ) : null}
      </>
    );
    const groupButton = (
      <button
        type="button"
        onClick={empty ? undefined : () => toggleGroup(key)}
        aria-expanded={empty ? undefined : !collapsed}
        aria-label={
          deviceFolder
            ? t("recentChats.folderOnDevice", { folder: label, device: deviceFolder.deviceName })
            : undefined
        }
        title={deviceFolder ? undefined : label}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-8 border border-transparent pl-2 pr-1 text-left outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        {projectLabel}
      </button>
    );
    return (
      <div key={key} className="mb-1" data-project-group={key}>
        <div className="group/project flex h-8 items-center min-h-[var(--control-min-h)] gap-1 rounded-8 text-ui text-foreground transition hover:bg-surface-hover dark:hover:bg-surface">
          {groupButton}
          {deviceFolder ? (
            <button
              type="button"
              onClick={() =>
                navigate("/chat", {
                  state: {
                    deviceFolder: {
                      deviceId: deviceFolder.deviceId,
                      deviceName: deviceFolder.deviceName,
                      path: deviceFolder.path,
                      home: null,
                    },
                  },
                })
              }
              aria-label={t("recentChats.newChatInFolder")}
              title={t("recentChats.newChatInFolder")}
              className="touch-show mr-1 shrink-0 rounded-4 p-1 text-subtle-foreground opacity-0 transition-opacity hover:text-foreground focus:outline-none focus-visible:opacity-100 group-hover/project:opacity-100"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
          {projectPath ? (
            // A real link either way, so "open in new tab" works from the
            // keyboard and the context menu. The project rides the URL because
            // a new tab does not inherit router state.
            plusOpensNewTab ? (
              <a
                href={newChatInProjectHref(projectPath)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("recentChats.newChatInProject")}
                title={t("recentChats.newChatInProject")}
                className={PROJECT_PLUS_CLASS}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : (
              <Link
                to={newChatInProjectHref(projectPath)}
                state={{ projectPath }}
                aria-label={t("recentChats.newChatInProject")}
                title={t("recentChats.newChatInProject")}
                className={PROJECT_PLUS_CLASS}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </Link>
            )
          ) : null}
        </div>
        {collapsed ? null : (
          <>
            {visibleItems.map((session) => renderChatRow(session, true))}
            {remainingCount > 0 ? (
              <button
                type="button"
                onClick={() => loadMore(key)}
                className="ml-4 rounded-4 border border-transparent py-1 pr-1 text-left text-aux min-h-[var(--control-min-h)] text-subtle-foreground transition outline-none hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
              >
                {t("recentChats.loadMore", { count: remainingCount })}
              </button>
            ) : null}
          </>
        )}
      </div>
    );
  };

  const renderTasks = () => {
    if (taskSessions.length === 0) return null;
    // The open task chat stays in view, even when it is past the first few.
    const activeIndex = taskSessions.findIndex((s) => s.id === activeSessionId);
    const showAll = tasksExpanded || activeIndex >= TASK_CHATS_VISIBLE;
    const visible = showAll ? taskSessions : taskSessions.slice(0, TASK_CHATS_VISIBLE);
    const hidden = taskSessions.length - visible.length;
    const running = taskSessions.filter((s) => s.running).length;
    return (
      <section aria-labelledby="recent-chats-tasks-heading" data-tasks-section>
        <hr className="mx-2 my-4 border-0 border-t border-border" aria-hidden />
        <h2
          id="recent-chats-tasks-heading"
          className="flex h-8 min-h-[var(--control-min-h)] items-center justify-between px-2 text-aux text-subtle-foreground"
        >
          <span>{t("recentChats.sectionTasks")}</span>
          {running > 0 ? <span>{t("recentChats.tasksRunning", { count: running })}</span> : null}
        </h2>
        {visible.map((session) => renderChatRow(session))}
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => setTasksExpanded(true)}
            data-tasks-more
            className={`ml-2 ${MORE_ROW_CLASS}`}
          >
            {t("recentChats.moreTasks", { count: hidden })}
          </button>
        ) : null}
      </section>
    );
  };

  return (
    // skipDelayDuration 0 makes every row wait out the delay on its own:
    // Radix's default grace window would otherwise pop each name instantly
    // once one has opened, strobing the list as the pointer runs down it.
    <TooltipProvider delayDuration={300} skipDelayDuration={0}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={`flex shrink-0 items-center justify-between pb-2 pr-3 ${headerLeading ? "pl-2" : "pl-5"} ${belowTitlebar ? "pt-2" : "pt-5"}`}
        >
          <div className="flex min-w-0 items-center gap-1">
            {headerLeading}
            <span className="truncate text-section text-foreground">
              {t(mode === "concierge" ? "recentChats.modeConcierge" : "recentChats.title")}
            </span>
            {hasConcierge ? (
              <ChatModeSwitch
                mode={mode}
                onChange={writeChatListMode}
                conciergeUnread={conciergeUnread}
                chatReplying={chatReplying}
              />
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="sm"
                  label={t("recentChats.settings")}
                  icon={<Ellipsis aria-hidden />}
                  className="text-subtle-foreground hover:text-foreground"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" className="min-w-[180px]">
                {[
                  { value: "all" as const, label: t("recentChats.allChats") },
                  { value: "mine" as const, label: t("recentChats.myChats") },
                ].map(({ value, label }) => (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => setScope(value)}
                    className={
                      scope === value ? "text-ui text-foreground" : "text-ui text-foreground/85"
                    }
                  >
                    <span>{label}</span>
                    {scope === value ? (
                      <Check className="ml-auto h-3.5 w-3.5 text-subtle-foreground" aria-hidden />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                <div className="px-2 pb-1 pt-2 text-aux text-subtle-foreground">
                  {t("recentChats.status")}
                </div>
                {[
                  { value: "all" as const, label: t("recentChats.statusAll") },
                  { value: "active" as const, label: t("recentChats.statusActive") },
                  { value: "archived" as const, label: t("recentChats.statusArchived") },
                ].map(({ value, label }) => {
                  const selected = statusFilter === value;
                  return (
                    <DropdownMenuItem
                      key={value}
                      onSelect={() => setStatusFilter(value)}
                      className={
                        selected ? "text-ui text-foreground" : "text-ui text-foreground/85"
                      }
                    >
                      <span>{label}</span>
                      {selected ? (
                        <Check className="ml-auto h-3.5 w-3.5 text-subtle-foreground" aria-hidden />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {headerControls}
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 scrollbar-idle-hidden"
          onClickCapture={markOpening}
        >
          <NewChatRow
            kind={mode === "concierge" ? "topic" : "chat"}
            label={t(mode === "concierge" ? "recentChats.newTopic" : "recentChats.newChat")}
            shortcut={wideWindow && !coarsePointer ? newChatShortcutForPlatform() : null}
          />
          {mode === "concierge" && conciergeChatId ? (
            <>
              <ConciergeChats
                mainChatId={conciergeChatId}
                activeSessionId={activeSessionId}
                statusFilter={statusFilter}
                topicSessions={conciergeTopicSessions}
              />
              {renderTasks()}
            </>
          ) : (
            <section aria-labelledby="recent-chats-projects-heading" data-projects-section>
              <h2
                id="recent-chats-projects-heading"
                className="flex h-8 min-h-[var(--control-min-h)] items-center px-2 text-aux text-subtle-foreground"
              >
                {t("recentChats.sectionProjects")}
              </h2>
              {phase === "loading" ? (
                <div className="space-y-1 px-2 py-2" aria-hidden>
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-4/5" />
                  <Skeleton className="h-8 w-3/5" />
                </div>
              ) : (
                <div className="space-y-1">
                  {projectGroups.map(renderProjectGroup)}
                  {/* Only with nothing to show: a refetch that fails while the
                    list already has rows keeps the rows rather than blanking them. */}
                  {phase === "error" && sessions.length === 0 ? (
                    <div className="px-3 py-8 text-center" role="alert">
                      <p className="text-aux text-subtle-foreground">
                        {t("recentChats.searchLoadError")}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => void refetch()}
                      >
                        {t("recentChats.searchRetry")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          )}
        </div>
        <RomeConfirmDialog
          open={pendingDeleteId !== null}
          destructive
          title={t("recentChats.delete")}
          description={t("recentChats.deleteConfirm")}
          confirmLabel={t("recentChats.delete")}
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => {
            const id = pendingDeleteId;
            setPendingDeleteId(null);
            if (id) void handleDelete(id);
          }}
        />
      </div>
    </TooltipProvider>
  );
}
