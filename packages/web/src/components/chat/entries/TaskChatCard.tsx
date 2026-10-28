import { ChatBubbleIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { chatStatusTopic, useLiveEvents } from "@/hooks/use-live-events";

const sessionRunningSchema = z.object({ sessionId: z.string(), running: z.boolean() });

type TaskStatus = "running" | "waiting" | "failed" | "idle";

/**
 * A task chat another agent started on the guardian's behalf: its title, its
 * live status, and a link that opens it.
 */
export function TaskChatCard({ chatId, title }: { chatId: string; title: string }) {
  const { t } = useTranslation("chat");
  const { sessions, invalidate } = useChatSessions("all", "all");
  const [liveRunning, setLiveRunning] = useState<boolean | null>(null);
  useLiveEvents(chatStatusTopic, {
    session_running: {
      schema: sessionRunningSchema,
      fn: ({ sessionId, running }) => {
        if (sessionId !== chatId) return;
        setLiveRunning(running);
        // A stop changes awaitingGuardian and lastTurnFailed, which the list carries.
        if (!running) void invalidate();
      },
    },
  });
  const session = sessions?.find((candidate) => candidate.id === chatId);
  const running = liveRunning ?? session?.running ?? false;
  const status: TaskStatus = running
    ? "running"
    : session?.awaitingGuardian
      ? "waiting"
      : session?.lastTurnFailed
        ? "failed"
        : "idle";
  return (
    <div className="flex w-full max-w-md items-center gap-3 rounded-16 border border-border bg-surface px-3 py-2">
      <ChatBubbleIcon className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-foreground">{session?.name ?? title}</span>
        <span className="text-aux text-muted-foreground">
          {t("concierge.taskChat")} · {t(`concierge.taskStatus.${status}`)}
        </span>
      </div>
      <Button asChild variant="ghost" size="sm" className="shrink-0">
        <Link to={`/chat/${chatId}`}>{t("concierge.openTaskChat")}</Link>
      </Button>
    </div>
  );
}
