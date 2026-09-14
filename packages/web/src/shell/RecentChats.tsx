import { ChevronDownIcon, ChevronRightIcon, Pencil2Icon } from "@radix-ui/react-icons";
import {
  Archive,
  ArchiveRestore,
  Check,
  Ellipsis,
  Folder,
  FolderOpen,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { renameSession } from "@/lib/chat-api";
import { DEFAULT_PROJECT_NAME } from "@/lib/chat-constants";
import { usePinnedProjects } from "@/hooks/use-pinned-projects";
import {
  emitSessionsChanged,
  useArchiveSession,
  usePinSession,
  useSessionsChanged,
} from "@/lib/session-events";
import { chatSearchShortcutForPlatform } from "./ChatSearchDialog";

interface ChatSession {
  id: string;
  name: string;
  createdAt: string;
  activityAt: string;
  lastSeenActivityAt: string | null;
  unread: boolean;
  projectName: string;
  projectPath: string;
  archivedAt: string | null;
  archived: boolean;
  pinnedAt: string | null;
}

type GroupMode = "project" | "date";
type LoadPhase = "loading" | "ready" | "error";
type StatusFilter = "all" | "active" | "archived";

interface SessionGroup {
  key: string;
  label: string;
  items: ChatSession[];
  latest: number;
  projectPath: string;
}

const GROUP_MODE_STORAGE_KEY = "rome-recent-chats-group-mode";
const STATUS_FILTER_STORAGE_KEY = "rome-recent-chats-status-filter";
const COLLAPSED_GROUPS_STORAGE_KEY = "rome-recent-chats-collapsed-groups";

const DATE_BUCKETS = [
  { id: "today", tKey: "recentChats.groups.today" },
  { id: "yesterday", tKey: "recentChats.groups.yesterday" },
  { id: "previous7Days", tKey: "recentChats.groups.previous7Days" },
  { id: "previous30Days", tKey: "recentChats.groups.previous30Days" },
  { id: "older", tKey: "recentChats.groups.older" },
] as const;

type DateBucketId = (typeof DATE_BUCKETS)[number]["id"];

function activeSessionFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function readGroupMode(): GroupMode {
  if (typeof window === "undefined") return "project";
  const raw = window.localStorage.getItem(GROUP_MODE_STORAGE_KEY);
  return raw === "date" ? "date" : "project";
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

function dateBucketFor(createdAt: string, now: number): DateBucketId {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const t = new Date(createdAt).getTime();
  if (t >= today) return "today";
  if (t >= today - 86_400_000) return "yesterday";
  if (t >= today - 7 * 86_400_000) return "previous7Days";
  if (t >= today - 30 * 86_400_000) return "previous30Days";
  return "older";
}

function sessionActivityTime(session: ChatSession): number {
  const activity = new Date(session.activityAt || session.createdAt).getTime();
  if (Number.isFinite(activity)) return activity;
  const created = new Date(session.createdAt).getTime();
  return Number.isFinite(created) ? created : 0;
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

function projectPathForSession(session: ChatSession): string {
  return isDefaultProjectChat(session) ? DEFAULT_PROJECT_NAME : session.projectPath || "";
}

const PROJECT_DEFAULT_VISIBLE = 4;
const PROJECT_LOAD_MORE_COUNT = 10;
// Keep in sync with the server-side cap in webchat.ts (PATCH /chat/sessions/:id/name).
const SESSION_NAME_MAX_LENGTH = 50;

/**
 * The chat's name, linking to the chat and revealing its full text in a
 * tooltip while the sidebar is too narrow to show it whole.
 */
function ChatRowLink({ id, name, nested }: { id: string; name: string; nested: boolean }) {
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
        </Link>
      </TooltipTrigger>
      {/* Right of the row, so the bubble reaches into the page rather than
          covering the neighbouring chats it was opened to compare against. */}
      {nameClipped ? <TooltipContent side="right">{name}</TooltipContent> : null}
    </Tooltip>
  );
}

export interface RecentChatsProps {
  onSearch: () => void;
}

export function RecentChats({ onSearch }: RecentChatsProps) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readGroupMode());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => readStatusFilter());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    readStringSetFromStorage(COLLAPSED_GROUPS_STORAGE_KEY),
  );
  const { pinnedProjectPaths, togglePinnedProject } = usePinnedProjects();
  const [visibleGroupCounts, setVisibleGroupCounts] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renamingRef = useRef(false);
  const activeSessionId = activeSessionFromPath(location.pathname);
  const searchShortcut = chatSearchShortcutForPlatform();

  const loadSessions = useCallback(async () => {
    try {
      const query = statusFilter === "active" ? "" : `?status=${statusFilter}`;
      const res = await fetch(`/api/chat/sessions${query}`, { credentials: "include" });
      if (!res.ok) {
        setPhase("error");
        return;
      }
      const data = (await res.json()) as ChatSession[];
      setSessions(data.map((s) => ({ ...s, archived: Boolean(s.archivedAt) })));
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useSessionsChanged(() => {
    void loadSessions();
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GROUP_MODE_STORAGE_KEY, groupMode);
  }, [groupMode]);

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

  const pinnedChats = useMemo(
    () =>
      sessions
        .filter((session) => session.pinnedAt)
        .sort((a, b) => new Date(b.pinnedAt ?? 0).getTime() - new Date(a.pinnedAt ?? 0).getTime()),
    [sessions],
  );

  const pinnedProjects = useMemo(() => {
    const namesByPath = new Map<string, string>();
    const sessionsByPath = new Map<string, ChatSession[]>();
    for (const session of sessions) {
      const projectPath = projectPathForSession(session);
      if (!projectPath) continue;
      if (!namesByPath.has(projectPath)) {
        namesByPath.set(projectPath, session.projectName || projectNameFromPath(projectPath));
      }
      if (session.pinnedAt) continue;
      const projectSessions = sessionsByPath.get(projectPath) ?? [];
      projectSessions.push(session);
      sessionsByPath.set(projectPath, projectSessions);
    }
    return Array.from(pinnedProjectPaths).map((projectPath) => ({
      projectPath,
      name: namesByPath.get(projectPath) ?? projectNameFromPath(projectPath),
      items: (sessionsByPath.get(projectPath) ?? []).sort(
        (a, b) => sessionActivityTime(b) - sessionActivityTime(a),
      ),
    }));
  }, [pinnedProjectPaths, sessions]);

  const regularSessions = useMemo(
    () =>
      sessions
        .filter(
          (session) => !session.pinnedAt && !pinnedProjectPaths.has(projectPathForSession(session)),
        )
        .sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a)),
    [pinnedProjectPaths, sessions],
  );

  const projectGroups = useMemo<SessionGroup[]>(() => {
    const buckets = new Map<string, { label: string; items: ChatSession[]; projectPath: string }>();
    for (const session of regularSessions) {
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
    return Array.from(buckets.entries())
      .map(([rawKey, { label, items, projectPath }]) => ({
        key: `project:${rawKey}`,
        label,
        items,
        latest: sessionActivityTime(items[0]),
        projectPath,
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [regularSessions]);

  const dateGroups = useMemo<SessionGroup[]>(() => {
    const now = Date.now();
    const buckets = new Map<DateBucketId, ChatSession[]>();
    for (const session of regularSessions) {
      const id = dateBucketFor(session.activityAt || session.createdAt, now);
      const existing = buckets.get(id);
      if (existing) existing.push(session);
      else buckets.set(id, [session]);
    }
    return DATE_BUCKETS.flatMap((bucket) => {
      const items = buckets.get(bucket.id);
      if (!items || items.length === 0) return [];
      return [
        {
          key: `date:${bucket.id}`,
          label: t(bucket.tKey),
          items,
          latest: sessionActivityTime(items[0]),
          projectPath: "",
        },
      ];
    });
  }, [regularSessions, t]);

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
  const pinMutation = usePinSession();
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
      setSessions((prev) => {
        // Drop the row when it no longer matches the active filter (archiving
        // under "active", unarchiving under "archived"); otherwise reflect the
        // new flag in place (the "all" view). Archiving never forces navigation.
        if ((statusFilter === "active" && archived) || (statusFilter === "archived" && !archived)) {
          return prev.filter((s) => s.id !== id);
        }
        return prev.map((s) =>
          s.id === id
            ? { ...s, archived, archivedAt: archived ? new Date().toISOString() : null }
            : s,
        );
      });
    },
    [archiveMutation, statusFilter],
  );

  const handleUnarchive = useCallback(
    async (id: string) => {
      await setArchived(id, false);
    },
    [setArchived],
  );

  const setPinned = useCallback(
    async (id: string, pinned: boolean) => {
      try {
        await pinMutation(id, pinned);
      } catch {
        return;
      }
      setSessions((prev) =>
        prev.map((session) =>
          session.id === id
            ? { ...session, pinnedAt: pinned ? new Date().toISOString() : null }
            : session,
        ),
      );
    },
    [pinMutation],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/chat/sessions/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
      } catch {
        // ignore — refetch anyway
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      emitSessionsChanged();
      if (activeSessionId === id) {
        navigate("/chat");
      }
    },
    [activeSessionId, navigate],
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
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
      try {
        await renameSession(id, name);
      } catch {
        // Server rejected/unchanged — the refetch below reconciles either way.
      }
      emitSessionsChanged();
    },
    [editingValue, sessions, cancelRename],
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
    const unread = session.unread && !isActive;
    const isEditing = editingId === session.id;
    const togglePin = () => void setPinned(session.id, !session.pinnedAt);
    const beginRename = () => startRename(session);
    const toggleArchive = session.archived
      ? () => void handleUnarchive(session.id)
      : () => void setArchived(session.id, true);
    const shortcuts: Record<string, () => void> = {
      p: togglePin,
      r: beginRename,
      a: toggleArchive,
    };
    return (
      <div
        key={session.id}
        data-chat-row
        className={`group flex h-8 items-center gap-1 rounded-8 text-ui transition ${
          session.archived ? "text-subtle-foreground" : "text-foreground"
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
          <ChatRowLink id={session.id} name={session.name} nested={nested} />
        )}
        <span
          className={`relative mr-2 flex h-4 w-4 shrink-0 items-center justify-center ${
            isEditing ? "hidden" : ""
          }`}
        >
          {unread ? (
            <span
              className="h-2 w-2 rounded-full bg-info transition-opacity group-hover:opacity-0"
              role="img"
              aria-label={t("recentChats.unread")}
            />
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
              <DropdownMenuItem aria-keyshortcuts="P" onSelect={togglePin}>
                {session.pinnedAt ? (
                  <PinOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ) : (
                  <Pin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                {session.pinnedAt ? t("recentChats.unpinChat") : t("recentChats.pinChat")}
                <DropdownMenuShortcut aria-hidden>P</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem aria-keyshortcuts="R" onSelect={beginRename}>
                <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("recentChats.rename")}
                <DropdownMenuShortcut aria-hidden>R</DropdownMenuShortcut>
              </DropdownMenuItem>
              {session.archived ? (
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

  const renderProjectGroup = ({
    key,
    label,
    items,
    projectPath,
    pinned,
  }: {
    key: string;
    label: string;
    items: ChatSession[];
    projectPath: string;
    pinned: boolean;
  }) => {
    const collapsed = collapsedGroups.has(key);
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
      </>
    );
    return (
      <div key={key} className="mb-1" data-pinned-project-row={pinned || undefined}>
        <div className="group/project flex h-8 items-center gap-1 rounded-8 text-ui text-foreground transition hover:bg-surface-hover dark:hover:bg-surface">
          <button
            type="button"
            onClick={() => toggleGroup(key)}
            aria-expanded={!collapsed}
            title={label}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-8 border border-transparent pl-2 pr-1 text-left outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
          >
            {projectLabel}
          </button>
          {projectPath ? (
            <button
              type="button"
              onClick={() =>
                navigate("/chat", {
                  state: { projectPath },
                })
              }
              aria-label={t("recentChats.newChatInProject")}
              title={t("recentChats.newChatInProject")}
              className="touch-show shrink-0 rounded-4 p-1 text-subtle-foreground opacity-0 transition-opacity hover:text-foreground focus:outline-none focus-visible:opacity-100 group-hover/project:opacity-100"
            >
              <Pencil2Icon className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
          {projectPath ? (
            <span className="relative mr-2 flex h-4 w-4 shrink-0 items-center justify-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("recentChats.projectActions")}
                    title={t("recentChats.projectActions")}
                    className="absolute inset-0 flex items-center justify-center rounded-4 p-1 text-subtle-foreground opacity-0 transition-opacity hover:text-foreground focus:outline-none focus-visible:opacity-100 group-hover/project:opacity-100"
                  >
                    <Ellipsis className="h-3 w-3" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                  <DropdownMenuItem onSelect={() => togglePinnedProject(projectPath)}>
                    {pinned ? (
                      <PinOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    ) : (
                      <Pin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                    {pinned ? t("recentChats.unpin") : t("recentChats.pin")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          ) : null}
        </div>
        {collapsed ? null : (
          <>
            {visibleItems.map((session) => renderChatRow(session, true))}
            {remainingCount > 0 ? (
              <button
                type="button"
                onClick={() => loadMore(key)}
                className="ml-4 rounded-4 border border-transparent py-1 pr-1 text-left text-aux text-subtle-foreground transition outline-none hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
              >
                {t("recentChats.loadMore", { count: remainingCount })}
              </button>
            ) : null}
          </>
        )}
      </div>
    );
  };

  const hasPinned = pinnedChats.length > 0 || pinnedProjects.length > 0;
  const pinnedCollapsed = collapsedGroups.has("section:pinned");

  return (
    // skipDelayDuration 0 makes every row wait out the delay on its own:
    // Radix's default grace window would otherwise pop each name instantly
    // once one has opened, strobing the list as the pointer runs down it.
    <TooltipProvider delayDuration={300} skipDelayDuration={0}>
      <div className="flex flex-col">
        <div className="flex items-center justify-between px-5 pt-4">
          <span className="text-body text-foreground">{t("recentChats.title")}</span>
          <div className="flex items-center gap-1">
            <IconButton
              size="sm"
              label={t("recentChats.search")}
              title={t("recentChats.searchShortcut", { shortcut: searchShortcut })}
              onClick={onSearch}
              icon={<Search aria-hidden />}
              className="text-subtle-foreground hover:text-foreground"
            />
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
                <div className="px-2 pb-1 pt-1 text-aux text-subtle-foreground">
                  {t("recentChats.groupBy")}
                </div>
                {[
                  { mode: "date" as const, label: t("recentChats.groupByDate") },
                  { mode: "project" as const, label: t("recentChats.groupByProjects") },
                ].map(({ mode, label }) => {
                  const selected = groupMode === mode;
                  return (
                    <DropdownMenuItem
                      key={mode}
                      onSelect={() => setGroupMode(mode)}
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
          </div>
        </div>
        <div className="px-3 pt-2 pb-3">
          {hasPinned ? (
            <section
              aria-labelledby="recent-chats-pinned-heading"
              className="mb-4"
              data-pinned-section
            >
              <button
                type="button"
                id="recent-chats-pinned-heading"
                onClick={() => toggleGroup("section:pinned")}
                aria-expanded={!pinnedCollapsed}
                className="flex items-center gap-2 rounded-4 border border-transparent px-2 pb-1 pt-3 text-aux text-subtle-foreground transition outline-none hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
              >
                {t("recentChats.pinned")}
                {pinnedCollapsed ? (
                  <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
              {pinnedCollapsed ? null : (
                <div className="space-y-1">
                  {pinnedChats.map((session) => renderChatRow(session))}
                  {pinnedProjects.map(({ projectPath, name, items }) =>
                    renderProjectGroup({
                      key: `pinned-project:${projectPath}`,
                      label: name,
                      items,
                      projectPath,
                      pinned: true,
                    }),
                  )}
                </div>
              )}
            </section>
          ) : null}
          {phase === "loading" ? (
            <div className="space-y-1 px-2 py-2" aria-hidden>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-4/5" />
              <Skeleton className="h-8 w-3/5" />
            </div>
          ) : !hasPinned && regularSessions.length === 0 ? (
            // Only reachable with nothing to show: a refetch that fails while the
            // list already has rows keeps the rows rather than blanking them.
            phase === "error" ? (
              <div className="px-3 py-8 text-center" role="alert">
                <p className="text-aux text-subtle-foreground">
                  {t("recentChats.searchLoadError")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void loadSessions()}
                >
                  {t("recentChats.searchRetry")}
                </Button>
              </div>
            ) : (
              <div className="px-3 py-8 text-center text-aux text-subtle-foreground">
                {t("recentChats.empty")}
              </div>
            )
          ) : groupMode === "project" ? (
            projectGroups.length > 0 ? (
              <section
                aria-label={hasPinned ? undefined : t("recentChats.sectionProjects")}
                aria-labelledby={hasPinned ? "recent-chats-projects-heading" : undefined}
              >
                {hasPinned ? (
                  <h2
                    id="recent-chats-projects-heading"
                    className="px-2 pb-1 pt-3 text-aux text-subtle-foreground"
                  >
                    {t("recentChats.sectionProjects")}
                  </h2>
                ) : null}
                <div className="space-y-1">
                  {projectGroups.map(({ key, label, items, projectPath }) =>
                    renderProjectGroup({
                      key,
                      label,
                      items,
                      projectPath,
                      pinned: false,
                    }),
                  )}
                </div>
              </section>
            ) : null
          ) : (
            dateGroups.map(({ key, label, items }) => {
              const collapsed = collapsedGroups.has(key);
              return (
                <section key={key} className="mb-4 last:mb-0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(key)}
                    aria-expanded={!collapsed}
                    className="flex items-center gap-2 rounded-4 border border-transparent px-2 pb-1 pt-3 text-aux text-subtle-foreground transition outline-none hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
                  >
                    <span>{label}</span>
                    {collapsed ? (
                      <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </button>
                  {collapsed ? null : (
                    <div className="space-y-1">
                      {items.map((session) => renderChatRow(session))}
                    </div>
                  )}
                </section>
              );
            })
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
