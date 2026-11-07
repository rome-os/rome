import type { ConciergeChatDto } from "@rome/api-types/concierge";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
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
  CONCIERGE_CHATS_QUERY_KEY,
  CONCIERGE_SESSION_QUERY_KEY,
  CONCIERGE_UNREAD_CAP,
  useConciergeChats,
  useConciergeUnread,
} from "@/hooks/use-concierge";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { emitSessionsChanged, useSessionsChanged } from "@/lib/session-events";
import { ACTIVE_CLASS, IDLE_CLASS, LINK_CLASS } from "./sidebar-shared";

const anyEvent = z.unknown();

/**
 * The sidebar's Concierge entry, with a badge counting the agent messages the
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
        to={`/chat/${chatId}`}
        className={`${LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
        aria-label={count > 0 ? t("recentChats.conciergeUnread", { count, label }) : undefined}
      >
        <span
          className="rome-sidebar-icon flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground"
          aria-hidden
        >
          <RomeLogo className="size-4 shrink-0" aria-hidden />
        </span>
        <span className="flex-1 truncate">{t("recentChats.concierge")}</span>
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
 * The sidebar's Concierge entries: the main chat's entry, then one row per
 * topic chat, each with its unread badge and a menu to rename, archive or
 * delete it. The plus beside the main entry opens a blank topic chat, which
 * its first message creates and names.
 */
export function ConciergeChats({
  mainChatId,
  activeSessionId,
}: {
  mainChatId: string;
  activeSessionId: string | null | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const topics = useConciergeChats().filter((chat) => !chat.main);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONCIERGE_CHATS_QUERY_KEY });
  }, [queryClient]);
  useSessionsChanged(refresh);
  return (
    <>
      <ConciergeEntry
        chatId={mainChatId}
        active={activeSessionId === mainChatId}
        // A blank topic chat, as New chat opens a blank chat: its first send creates it.
        onNewTopic={() => navigate("/chat", { state: { conciergeTopic: true } })}
      />
      {topics.map((chat) => (
        <ConciergeTopicEntry
          key={chat.id}
          chat={chat}
          active={activeSessionId === chat.id}
          onChanged={refresh}
          onGone={() => {
            if (activeSessionId === chat.id) navigate(`/chat/${mainChatId}`);
          }}
        />
      ))}
    </>
  );
}

function ConciergeTopicEntry({
  chat,
  active,
  onChanged,
  onGone,
}: {
  chat: ConciergeChatDto;
  active: boolean;
  onChanged: () => void;
  onGone: () => void;
}) {
  const { t } = useTranslation("common");
  // An untitled chat shows as a new chat until its first message names it.
  const name = chat.name || t("recentChats.newChat");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(chat.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useLiveEvents(
    chatSessionTopic(chat.id),
    { message_insert: { schema: anyEvent, fn: onChanged } },
    { onReconnect: onChanged },
  );
  const count = active ? 0 : chat.unread;
  const label = count >= CONCIERGE_UNREAD_CAP ? "99+" : String(count);
  const rename = async () => {
    setEditing(false);
    const trimmed = value.trim();
    if (!trimmed || trimmed === chat.name) return;
    await renameSession(chat.id, trimmed).catch(() => undefined);
    onChanged();
  };
  const retire = async (how: "archive" | "delete") => {
    try {
      if (how === "archive") await archiveSession(chat.id, true);
      else await deleteSession(chat.id);
    } catch {
      toast.error(t("recentChats.topicChatRetireFailed"));
    }
    onChanged();
    emitSessionsChanged();
    onGone();
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
        <span className="flex-1 truncate">{name}</span>
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
          <DropdownMenuItem onSelect={() => void retire("archive")}>
            <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("recentChats.archive")}
          </DropdownMenuItem>
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
        description={t("recentChats.topicChatDeleteConfirm")}
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
