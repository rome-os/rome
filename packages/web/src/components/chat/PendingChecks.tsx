import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ChatPendingChecksResponse } from "@rome/api-types/concierge";
import { IconButton } from "@/components/ui/icon-button";
import { fetchJson } from "@/lib/fetch-json";
import { formatTaskTime } from "@/components/concierge/tasks";

const checksKey = (chatId: string) => ["chat-checks", chatId] as const;

/**
 * The checks pending in a chat, which the agent scheduled to wake it later,
 * each with a Cancel. Read again at every turn boundary (`turnKey`), which is
 * when the agent schedules one, and when one fires and wakes the chat.
 */
export function PendingChecks({ chatId, turnKey }: { chatId: string; turnKey: unknown }) {
  const { t, i18n } = useTranslation("chat");
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: checksKey(chatId),
    queryFn: () =>
      fetchJson<ChatPendingChecksResponse>(
        `/api/chat/sessions/${encodeURIComponent(chatId)}/checks`,
        { fallback: t("checks.loadFailed") },
      ),
  });
  useEffect(() => {
    void turnKey;
    void queryClient.invalidateQueries({ queryKey: checksKey(chatId) });
  }, [turnKey, chatId, queryClient]);
  const cancel = useMutation({
    mutationFn: (id: string) =>
      fetchJson<void>(
        `/api/chat/sessions/${encodeURIComponent(chatId)}/checks/${encodeURIComponent(id)}`,
        { method: "DELETE", fallback: t("checks.cancelFailed") },
      ),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: checksKey(chatId) }),
  });
  const checks = data?.checks ?? [];
  if (checks.length === 0) return null;
  const now = Date.now();
  return (
    <ul aria-label={t("checks.label")} className="flex flex-col gap-1 px-1 pb-1">
      {checks.map((check) => {
        const when = formatTaskTime(check.at, now, i18n.language);
        const line = check.waitingFor
          ? t("checks.waiting", { what: check.waitingFor, when })
          : t("checks.timed", { name: check.name, when });
        return (
          <li
            key={check.id}
            className="flex items-center gap-2 rounded-12 border border-border bg-surface/95 py-1 pl-3 pr-1 text-aux text-muted-foreground backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
          >
            <Clock className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{line}</span>
            <IconButton
              size="xs"
              label={t("checks.cancel", { name: check.name })}
              icon={<X />}
              disabled={cancel.isPending && cancel.variables === check.id}
              onClick={() => cancel.mutate(check.id)}
              className="text-muted-foreground hover:text-foreground"
            />
          </li>
        );
      })}
    </ul>
  );
}
