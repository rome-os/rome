import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { RomeLogo } from "@/components/logo";
import {
  CONCIERGE_SESSION_QUERY_KEY,
  CONCIERGE_UNREAD_CAP,
  useConciergeUnread,
} from "@/hooks/use-concierge";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { useSessionsChanged } from "@/lib/session-events";
import { ACTIVE_CLASS, IDLE_CLASS, LINK_CLASS } from "./sidebar-shared";

const anyEvent = z.unknown();

/**
 * The sidebar's Concierge entry, with a badge counting the agent messages the
 * guardian has not read. A new message recounts, and so does a read in this
 * tab; another tab or device catches up on its next focus refetch. The open
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
          className="shrink-0 tabular-nums"
          data-concierge-unread
          aria-hidden
        >
          {label}
        </Badge>
      ) : null}
    </Link>
  );
}
