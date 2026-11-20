import type { ConciergeChatDto } from "@rome/api-types/concierge";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Ellipsis, Hash, Pencil, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { IconButton } from "@/components/ui/icon-button";
import { archiveSession, deleteSession, renameSession } from "@/lib/chat-api";
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

/** A topic chat as the sidebar lists it. */
export interface TopicChatRow extends ConciergeChatDto {
  archived: boolean;
}

/**
 * The topic chats the Concierge section lists under a status filter, latest
 * first. Active ones come from the Concierge's own list, which carries their
 * unread counts. Archived ones are only in the chat list. A topic chat the
 * chat list has not caught up with yet counts as the newest.
 */
export function topicChatRows(
  statusFilter: "all" | "active" | "archived",
  activeTopics: readonly ConciergeChatDto[],
  topicSessions: readonly ChatSession[],
): TopicChatRow[] {
  const listed = new Map(topicSessions.map((session) => [session.id, session]));
  const rows: Array<TopicChatRow & { at: number }> = [];
  if (statusFilter !== "archived") {
    // The Concierge lists them oldest first. Walking it backwards leaves the
    // newest first among those the chat list has no time for, as the sort
    // below keeps ties in place.
    for (const chat of [...activeTopics].reverse()) {
      const session = listed.get(chat.id);
      rows.push({
        ...chat,
        archived: false,
        at: session ? sessionActivityTime(session) : Number.POSITIVE_INFINITY,
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
        at: sessionActivityTime(session),
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at).map(({ at: _at, ...row }) => row);
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

/**
 * The sidebar's Concierge section: the main chat's entry, then the topic
 * chats, latest first, {@link TOPIC_CHATS_PAGE} at a time: scrolling near the
 * end of the list shows the next page. Each topic chat has its unread badge
 * and a menu to rename, archive or unarchive, and delete it. The status filter applies here too:
 * the main chat is never archived, so the archived filter hides it.
 */
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
  // A topic chat's rows read two lists, so every change refetches both. A
  // reply in any topic chat, shown or not yet scrolled to, refetches them from
  // the chat list's status stream, so no row subscribes on its own.
  const refresh = useRefreshTopicChats();
  useSessionsChanged(refresh);
  // The open topic chat stays in view, even when it is past the pages shown.
  const activeIndex = topics.findIndex((chat) => chat.id === activeSessionId);
  const shown = Math.max(limit, activeIndex + 1);
  const visible = topics.slice(0, shown);
  const hasMore = topics.length > shown;
  // Near the end of the list, the next page: the list's scroller is the root,
  // so the page lands a little before the guardian reaches the last row.
  const end = useListEnd({
    enabled: hasMore,
    page: shown,
    onReached: () => setLimit(shown + TOPIC_CHATS_PAGE),
    rootMargin: "0px 0px 160px 0px",
  });
  return (
    <section aria-label={t("recentChats.conciergeSection")} data-concierge-section>
      {statusFilter === "archived" ? null : (
        <ConciergeEntry chatId={mainChatId} active={activeSessionId === mainChatId} />
      )}
      {visible.map((chat) => (
        <ConciergeTopicEntry
          key={chat.id}
          chat={chat}
          active={activeSessionId === chat.id}
          onChanged={refresh}
          onGone={() => {
            if (activeSessionId === chat.id) navigate(MAIN_CHAT_PATH);
          }}
        />
      ))}
      {hasMore ? <div ref={end.ref} aria-hidden className="h-px" data-topic-chats-end /> : null}
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
          <Hash aria-hidden className="size-4 shrink-0" />
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
          <DropdownMenuItem onSelect={() => rename.start(chat.id, chat.name)}>
            <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("recentChats.rename")}
          </DropdownMenuItem>
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
