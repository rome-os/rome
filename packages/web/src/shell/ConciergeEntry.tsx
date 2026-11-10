import type { ConciergeChatDto } from "@rome/api-types/concierge";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { archiveSession, deleteSession, renameSession } from "@/lib/chat-api";
import { Badge } from "@/components/ui/badge";
import { RomeLogo } from "@/components/logo";
import {
  CONCIERGE_SESSION_QUERY_KEY,
  CONCIERGE_UNREAD_CAP,
  useConciergeChats,
  useConciergeName,
  useConciergeUnread,
  useRefreshTopicChats,
} from "@/hooks/use-concierge";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { MAIN_CHAT_PATH, sessionActivityTime } from "@/lib/chat-session";
import type { ChatSession } from "@/lib/chat-types";
import { emitSessionsChanged, useSessionsChanged } from "@/lib/session-events";
import { ACTIVE_CLASS, IDLE_CLASS, LINK_CLASS } from "./sidebar-shared";

const anyEvent = z.unknown();

/** How many topic chats show before the More row. */
export const TOPIC_CHATS_VISIBLE = 5;

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
 * The sidebar's main chat entry, with a badge counting the agent messages the
 * guardian has not read, and the plus that opens a blank topic chat. A new
 * message recounts, and so does a read in this tab; another tab or device
 * catches up on its next focus refetch. The open chat reads what arrives, so
 * the entry shows no badge while it is active. The plus takes the badge's
 * place while the row is hovered or focused, so the two never overlap. On a
 * touch screen, which has no hover, it shows while there is nothing unread.
 */
export function ConciergeEntry({
  chatId,
  active,
  onNewTopic,
}: {
  chatId: string;
  active: boolean;
  onNewTopic: () => void;
}) {
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
    <div className="group/concierge relative flex items-center">
      <Link
        to={MAIN_CHAT_PATH}
        className={`${LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
        aria-label={
          count > 0
            ? t("recentChats.conciergeUnread", { name: t("recentChats.mainChat"), count, label })
            : undefined
        }
      >
        <span
          className="rome-sidebar-icon flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground"
          aria-hidden
        >
          <RomeLogo className="size-4 shrink-0" aria-hidden />
        </span>
        <span className="flex-1 truncate">{t("recentChats.mainChat")}</span>
        {count > 0 ? (
          <Badge
            variant="destructive"
            className="shrink-0 tabular-nums group-focus-within/concierge:invisible group-hover/concierge:invisible"
            data-concierge-unread
            role="img"
            aria-label={t("recentChats.conciergeUnreadBadge", { count, label })}
          >
            {label}
          </Badge>
        ) : null}
      </Link>
      <IconButton
        size="sm"
        label={t("recentChats.newTopicChat")}
        icon={<Plus aria-hidden />}
        className={`absolute right-1 text-subtle-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-focus-within/concierge:opacity-100 group-hover/concierge:opacity-100 ${
          count > 0 ? "" : "touch-show"
        }`}
        onClick={onNewTopic}
        data-concierge-new-topic
      />
    </div>
  );
}

/**
 * The sidebar's Concierge section: the main chat's entry, then the topic
 * chats, latest first, the first {@link TOPIC_CHATS_VISIBLE} and a More row
 * for the rest. Each topic chat has its unread badge and a menu to rename,
 * archive or unarchive, and delete it. The status filter applies here too:
 * the main chat is never archived, so the archived filter hides it. The plus
 * beside the main entry opens a blank topic chat, which its first message
 * creates and names.
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
  const [expanded, setExpanded] = useState(false);
  // A topic chat's rows read two lists, so every change refetches both. A
  // reply in any topic chat, shown or folded under More, refetches them from
  // the chat list's status stream, so no row subscribes on its own.
  const refresh = useRefreshTopicChats();
  useSessionsChanged(refresh);
  // The open topic chat stays in view, even when it is past the first few.
  const activeIndex = topics.findIndex((chat) => chat.id === activeSessionId);
  const showAll = expanded || activeIndex >= TOPIC_CHATS_VISIBLE;
  const visible = showAll ? topics : topics.slice(0, TOPIC_CHATS_VISIBLE);
  const hidden = topics.length - visible.length;
  return (
    <section aria-label={t("recentChats.conciergeSection")} className="pt-1" data-concierge-section>
      {statusFilter === "archived" ? null : (
        <ConciergeEntry
          chatId={mainChatId}
          active={activeSessionId === mainChatId}
          // A blank topic chat, as a new chat opens blank: its first send creates it.
          onNewTopic={() => navigate("/chat", { state: { conciergeTopic: true } })}
        />
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
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-concierge-more
          className="ml-8 rounded-4 border border-transparent py-1 pr-1 text-left text-aux min-h-[var(--control-min-h)] text-subtle-foreground transition outline-none hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
        >
          {t("recentChats.moreTopicChats", { count: hidden })}
        </button>
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
  const conciergeName = useConciergeName();
  // An untitled chat shows as a new chat until its first message names it.
  const name = chat.name || t("recentChats.newChat");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(chat.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const count = active ? 0 : chat.unread;
  const label = count >= CONCIERGE_UNREAD_CAP ? "99+" : String(count);
  const rename = async () => {
    setEditing(false);
    const trimmed = value.trim();
    if (!trimmed || trimmed === chat.name) return;
    await renameSession(chat.id, trimmed).catch(() => undefined);
    onChanged();
    emitSessionsChanged();
  };
  const retire = async (how: "archive" | "unarchive" | "delete") => {
    try {
      if (how === "delete") await deleteSession(chat.id);
      else await archiveSession(chat.id, how === "archive");
    } catch {
      toast.error(t("recentChats.topicChatRetireFailed"));
    }
    onChanged();
    emitSessionsChanged();
    // An unarchived chat stays open where it is.
    if (how !== "unarchive") onGone();
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        aria-label={t("recentChats.renameLabel")}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void rename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setValue(chat.name);
            setEditing(false);
          }
        }}
        className="my-1 ml-6 h-[var(--control-h-sm)] min-w-0 rounded-4 border border-foreground/20 bg-background px-1 py-1 text-ui text-foreground outline-none"
      />
    );
  }
  return (
    <div className="group/topic relative flex items-center" data-concierge-topic={chat.id}>
      <Link
        to={`/chat/${chat.id}`}
        className={`${LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS} pl-8`}
        aria-label={
          count > 0 ? t("recentChats.topicChatUnread", { name, count, label }) : undefined
        }
      >
        {/* The menu button floats over the row's end, so the name keeps clear
            of it: the badge holds that room when there is one. */}
        <span
          className={`flex-1 truncate ${chat.archived ? "text-subtle-foreground" : ""} ${
            count > 0 ? "" : "pr-[var(--control-h-sm)]"
          }`}
        >
          {name}
        </span>
        {count > 0 ? (
          <Badge
            variant="destructive"
            className="shrink-0 tabular-nums group-hover/topic:invisible"
            data-concierge-unread
            role="img"
            aria-label={t("recentChats.conciergeUnreadBadge", { count, label })}
          >
            {label}
          </Badge>
        ) : null}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="sm"
            label={t("recentChats.topicChatActions", { name })}
            icon={<Ellipsis aria-hidden />}
            className="absolute right-1 text-subtle-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/topic:opacity-100"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" className="min-w-[180px]">
          <DropdownMenuItem
            onSelect={() => {
              setValue(chat.name);
              setTimeout(() => setEditing(true), 0);
            }}
          >
            <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("recentChats.rename")}
          </DropdownMenuItem>
          {chat.archived ? (
            <DropdownMenuItem onSelect={() => void retire("unarchive")}>
              <ArchiveRestore className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("recentChats.unarchive")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void retire("archive")}>
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
      <RomeConfirmDialog
        open={confirmDelete}
        destructive
        title={t("recentChats.delete")}
        description={t("recentChats.topicChatDeleteConfirm", { name: conciergeName })}
        confirmLabel={t("recentChats.delete")}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void retire("delete");
        }}
      />
    </div>
  );
}
