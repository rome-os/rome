import type { ConciergeChatDto } from "@rome/api-types/concierge";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Hash,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { useTopicChatArchive } from "@/components/concierge/TopicChatArchiveDialog";
import { TopicChatDeleteDialog } from "@/components/concierge/TopicChatDeleteDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { readStored, writeStored } from "@/lib/stored-preference";
import { IconButton } from "@/components/ui/icon-button";
import { archiveSession, deleteSession, pinSession, renameSession } from "@/lib/chat-api";
import { findScrollableYAncestor } from "@/lib/scroll-container";
import { useRenameInPlace } from "@/hooks/use-rename-in-place";
import { Badge } from "@/components/ui/badge";
import { RomeLogo } from "@/components/logo";
import {
  CONCIERGE_SESSION_QUERY_KEY,
  CONCIERGE_UNREAD_CAP,
  useConciergeChats,
  useConciergeUnread,
  useRefreshTopicChats,
} from "@/hooks/use-concierge";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { MAIN_CHAT_PATH, sessionActivityTime } from "@/lib/chat-session";
import type { ChatSession } from "@/lib/chat-types";
import { emitSessionsChanged, useSessionsChanged } from "@/lib/session-events";
import { ACTIVE_CLASS, IDLE_CLASS, LINK_CLASS } from "./sidebar-shared";
import { useListEnd } from "@/hooks/use-list-end";

const anyEvent = z.unknown();

/** How many topic chats show at first, and how many more each scroll to the end adds. */
export const TOPIC_CHATS_PAGE = 30;

const OLDER_TOPICS_OPEN_KEY = "rome-older-topic-chats-open";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A topic chat as the sidebar lists it. */
export interface TopicChatRow extends ConciergeChatDto {
  archived: boolean;
  /** Milliseconds since epoch, or infinity while the chat list has not caught up. */
  activityAt: number;
  /** When its owner pinned it; null when it is not pinned. An archived chat is never shown pinned. */
  pinnedAt: string | null;
}

/**
 * The topic chats the Concierge section lists under a status filter: the
 * pinned ones first, the latest pinned on top, then the rest, latest first.
 * Active ones come from the Concierge's own list, which carries their unread
 * counts; their pins and times come from the chat list. Archived ones are
 * only in the chat list and are never shown pinned. A topic chat the chat
 * list has not caught up with yet counts as the newest.
 */
export function topicChatRows(
  statusFilter: "all" | "active" | "archived",
  activeTopics: readonly ConciergeChatDto[],
  topicSessions: readonly ChatSession[],
): TopicChatRow[] {
  const listed = new Map(topicSessions.map((session) => [session.id, session]));
  const rows: Array<TopicChatRow & { pin: number }> = [];
  if (statusFilter !== "archived") {
    // The Concierge lists them oldest first. Walking it backwards leaves the
    // newest first among those the chat list has no time for, as the sort
    // below keeps ties in place.
    for (const chat of [...activeTopics].reverse()) {
      const session = listed.get(chat.id);
      const pinnedAt = session?.pinnedAt ?? null;
      rows.push({
        ...chat,
        archived: false,
        pinnedAt,
        activityAt: session ? sessionActivityTime(session) : Number.POSITIVE_INFINITY,
        pin: pinnedAt ? new Date(pinnedAt).getTime() : Number.NEGATIVE_INFINITY,
      });
    }
  }
  if (statusFilter !== "active") {
    for (const session of topicSessions) {
      if (!session.archivedAt) continue;
      rows.push({
        id: session.id,
        name: session.name,
        main: false,
        unread: 0,
        archived: true,
        pinnedAt: null,
        activityAt: sessionActivityTime(session),
        pin: Number.NEGATIVE_INFINITY,
      });
    }
  }
  return rows
    .sort((a, b) => (a.pin !== b.pin ? b.pin - a.pin : b.activityAt - a.activityAt))
    .map(({ pin: _pin, ...row }) => row);
}

/**
 * A row's unread count, on the bottom right corner of its icon, so the icon
 * still shows. One red in every theme, ringed in the row's fill. Up to 99+;
 * the pill widens to the left, so it never reaches the name.
 */
function UnreadCorner({ count, label }: { count: number; label: string }) {
  const { t } = useTranslation("common");
  return (
    <Badge
      shape="pill"
      className="absolute -right-1.5 -bottom-1 h-2.75 min-w-2.75 justify-center border-0 bg-unread px-[var(--row-count-px)] font-semibold tabular-nums ring-2 ring-background group-hover:ring-surface-hover dark:group-hover:ring-surface"
      data-concierge-unread
      role="img"
      aria-label={t("recentChats.conciergeUnreadBadge", { count, label })}
    >
      {label}
    </Badge>
  );
}

/**
 * The sidebar's main chat entry, with a badge counting the agent messages the
 * guardian has not read. A new message recounts, and a read in this tab clears
 * it; another tab or device catches up on its next message or reconnect. The open
 * chat reads what arrives, so the entry shows no badge while it is active.
 */
export function ConciergeEntry({ chatId, active }: { chatId: string; active: boolean }) {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const unread = useConciergeUnread(chatId);
  const recount = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONCIERGE_SESSION_QUERY_KEY });
  }, [queryClient]);
  useLiveEvents(
    chatSessionTopic(chatId),
    { message_insert: { schema: anyEvent, fn: recount } },
    { onReconnect: recount },
  );
  useSessionsChanged(recount);
  const count = active ? 0 : unread;
  const label = count >= CONCIERGE_UNREAD_CAP ? "99+" : String(count);
  return (
    <div className="mb-[var(--row-gap)] flex items-center">
      <Link
        to={MAIN_CHAT_PATH}
        className={`${LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
        aria-current={active ? "page" : undefined}
        aria-label={
          count > 0
            ? t("recentChats.conciergeUnread", { name: t("recentChats.mainChat"), count, label })
            : undefined
        }
      >
        <span className="rome-sidebar-icon relative flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground">
          <RomeLogo className="size-4 shrink-0" aria-hidden />
          {count > 0 ? <UnreadCorner count={count} label={label} /> : null}
        </span>
        <span className="flex-1 truncate">{t("recentChats.mainChat")}</span>
      </Link>
    </div>
  );
}

/** The dashboard's topic list. Grouping rules: docs/domains/chats.md#topic-chat. */
export function ConciergeChats({
  mainChatId,
  activeSessionId,
  statusFilter,
  topicSessions,
}: {
  mainChatId: string;
  activeSessionId: string | null | undefined;
  statusFilter: "all" | "active" | "archived";
  /** The chat list's Concierge chats other than the main chat, under the same filter. */
  topicSessions: readonly ChatSession[];
}) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const conciergeChats = useConciergeChats();
  const topics = useMemo(
    () =>
      topicChatRows(
        statusFilter,
        conciergeChats.filter((chat) => !chat.main),
        topicSessions,
      ),
    [conciergeChats, statusFilter, topicSessions],
  );
  const [limit, setLimit] = useState(TOPIC_CHATS_PAGE);
  const [olderLimit, setOlderLimit] = useState(TOPIC_CHATS_PAGE);
  const [olderOpen, setOlderOpen] = useState(() => readStored(OLDER_TOPICS_OPEN_KEY) === "true");
  const olderId = useId();
  useEffect(() => {
    writeStored(OLDER_TOPICS_OPEN_KEY, String(olderOpen));
  }, [olderOpen]);
  // A topic chat's rows read two lists, so every change refetches both. A
  // reply in any topic chat, shown or not yet scrolled to, refetches them from
  // the chat list's status stream, so no row subscribes on its own.
  const refresh = useRefreshTopicChats();
  useSessionsChanged(refresh);
  const cutoff = Date.now() - WEEK_MS;
  const older: TopicChatRow[] = [];
  const current: TopicChatRow[] = [];
  for (const chat of topics) {
    if (
      chat.activityAt <= cutoff &&
      chat.pinnedAt === null &&
      chat.unread === 0 &&
      chat.id !== activeSessionId
    ) {
      older.push(chat);
    } else {
      current.push(chat);
    }
  }
  // Exceptions stay visible without revealing the rows between them and the page.
  const visible = current.filter(
    (chat, index) =>
      index < limit || chat.id === activeSessionId || chat.unread > 0 || chat.pinnedAt !== null,
  );
  const hasMore = current.length > visible.length;
  const end = useListEnd({
    enabled: hasMore,
    page: limit,
    onReached: () => setLimit(limit + TOPIC_CHATS_PAGE),
    rootMargin: "0px 0px 160px 0px",
  });
  const olderEnd = useListEnd({
    enabled: olderOpen && older.length > olderLimit,
    page: olderLimit,
    onReached: () => setOlderLimit(olderLimit + TOPIC_CHATS_PAGE),
    rootMargin: "0px 0px 160px 0px",
  });
  const renderTopic = (chat: TopicChatRow) => (
    <ConciergeTopicEntry
      key={chat.id}
      chat={chat}
      active={activeSessionId === chat.id}
      onChanged={refresh}
      onGone={() => {
        if (activeSessionId === chat.id) navigate(MAIN_CHAT_PATH);
      }}
    />
  );
  return (
    <section aria-label={t("recentChats.conciergeSection")} data-concierge-section>
      {statusFilter === "archived" ? null : (
        <ConciergeEntry chatId={mainChatId} active={activeSessionId === mainChatId} />
      )}
      {visible.map(renderTopic)}
      {hasMore ? <div ref={end.ref} aria-hidden className="h-px" data-topic-chats-end /> : null}
      {older.length > 0 ? (
        <>
          <Button
            variant="ghost"
            className={`${LINK_CLASS} ${IDLE_CLASS} mb-[var(--row-gap)] justify-start text-subtle-foreground aria-expanded:bg-transparent`}
            aria-expanded={olderOpen}
            aria-controls={olderId}
            data-older-topic-chats
            onClick={() => setOlderOpen(!olderOpen)}
          >
            {olderOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            <span>{t("recentChats.olderTopics", { count: older.length })}</span>
          </Button>
          <div id={olderId} hidden={!olderOpen}>
            {olderOpen ? older.slice(0, olderLimit).map(renderTopic) : null}
            {olderOpen && older.length > olderLimit ? (
              <div ref={olderEnd.ref} aria-hidden className="h-px" data-older-topic-chats-end />
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function ConciergeTopicEntry({
  chat,
  active,
  onChanged,
  onGone,
}: {
  chat: TopicChatRow;
  active: boolean;
  onChanged: () => void;
  onGone: () => void;
}) {
  const { t } = useTranslation("common");
  // An untitled chat shows as a new chat until its first message names it.
  const name = chat.name || t("recentChats.newChat");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const count = active ? 0 : chat.unread;
  const label = count >= CONCIERGE_UNREAD_CAP ? "99+" : String(count);
  const pinned = chat.pinnedAt !== null;
  const togglePin = async () => {
    try {
      await pinSession(chat.id, !pinned);
    } catch {
      toast.error(t("recentChats.pinFailed"));
    }
    onChanged();
    emitSessionsChanged();
  };
  const rename = useRenameInPlace({
    onCommit: async (id, name) => {
      await renameSession(id, name).catch(() => undefined);
      onChanged();
      emitSessionsChanged();
    },
  });
  // `choice` stops the follows and open tasks of a delete or an archive, and
  // moves an unarchived chat's follows back.
  const retire = async (how: "archive" | "unarchive" | "delete", choice = false) => {
    try {
      if (how === "delete") await deleteSession(chat.id, choice ? { followsAndTasks: "stop" } : {});
      else if (how === "archive")
        await archiveSession(chat.id, true, choice ? { followsAndTasks: "stop" } : {});
      else await archiveSession(chat.id, false, choice ? { follows: "moveBack" } : {});
    } catch {
      toast.error(t("recentChats.topicChatRetireFailed"));
    }
    onChanged();
    emitSessionsChanged();
    // An unarchived chat stays open where it is.
    if (how !== "unarchive") onGone();
  };
  const archiving = useTopicChatArchive({
    chatId: chat.id,
    name,
    topic: true,
    onArchive: (stopWork) => void retire("archive", stopWork),
    onUnarchive: (moveBack) => void retire("unarchive", moveBack),
  });
  if (rename.editingId === chat.id) {
    return (
      <input
        {...rename.inputProps}
        aria-label={t("recentChats.renameLabel")}
        className="my-1 ml-3 h-[var(--control-h-sm)] min-w-0 rounded-4 border border-foreground/20 bg-background px-1 py-1 text-ui text-foreground outline-none"
      />
    );
  }
  return (
    <div
      className="group/topic relative mb-[var(--row-gap)] flex items-center"
      data-concierge-topic={chat.id}
    >
      <Link
        to={`/chat/${chat.id}`}
        className={`${LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
        aria-current={active ? "page" : undefined}
        aria-label={
          count > 0 ? t("recentChats.topicChatUnread", { name, count, label }) : undefined
        }
      >
        <span className="rome-sidebar-icon relative flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground">
          {pinned ? (
            <Pin aria-hidden className="size-4 shrink-0" data-topic-pinned />
          ) : (
            <Hash aria-hidden className="size-4 shrink-0" />
          )}
          {count > 0 ? <UnreadCorner count={count} label={label} /> : null}
        </span>
        {/* The menu button floats over the row's end, so the name keeps clear
            of it. */}
        <span
          className={`flex-1 truncate pr-[var(--control-h-sm)] ${chat.archived ? "text-subtle-foreground" : ""}`}
        >
          {name}
        </span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="sm"
            label={t("recentChats.topicChatActions", { name })}
            icon={<Ellipsis aria-hidden />}
            className="touch-show absolute right-1 text-subtle-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/topic:opacity-100"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="end"
          className="min-w-[180px]"
          {...rename.menuContentProps}
        >
          {/* An archived topic chat is renamed once it is unarchived. */}
          {chat.archived ? null : (
            <DropdownMenuItem onSelect={() => rename.start(chat.id, chat.name)}>
              <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("recentChats.rename")}
            </DropdownMenuItem>
          )}
          {chat.archived ? null : (
            <DropdownMenuItem onSelect={() => void togglePin()}>
              {pinned ? (
                <PinOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <Pin className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {pinned ? t("recentChats.unpin") : t("recentChats.pin")}
            </DropdownMenuItem>
          )}
          {chat.archived ? (
            <DropdownMenuItem onSelect={() => void archiving.unarchive()}>
              <ArchiveRestore className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("recentChats.unarchive")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void archiving.archive()}>
              <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("recentChats.archive")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("recentChats.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TopicChatDeleteDialog
        open={confirmDelete}
        chatId={chat.id}
        name={name}
        archived={chat.archived}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={(stopWork) => {
          setConfirmDelete(false);
          void retire("delete", stopWork);
        }}
      />
      {archiving.dialog}
    </div>
  );
}
