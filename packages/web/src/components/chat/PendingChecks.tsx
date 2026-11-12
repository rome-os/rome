import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Clock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ChatPendingCheckDto, ChatPendingChecksResponse } from "@rome/api-types/concierge";
import { IconButton } from "@/components/ui/icon-button";
import { fetchJson } from "@/lib/fetch-json";
import { formatTaskTime } from "@/components/concierge/tasks";

const checksKey = (chatId: string) => ["chat-checks", chatId] as const;

/** Soonest first; a wait with no deadline last. */
function bySoonest(a: ChatPendingCheckDto, b: ChatPendingCheckDto): number {
  return (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY);
}

/**
 * The checks pending in a chat, which the agent scheduled to wake it later.
 * Folded, it is one line: the count and the soonest check. Opened, it lists
 * them all, soonest first, each with a Cancel, and a check for a task names
 * the task. Read again at every turn boundary (`turnKey`), which is when the
 * agent schedules one, and when one fires and wakes the chat.
 */
export function PendingChecks({ chatId, turnKey }: { chatId: string; turnKey: unknown }) {
  const { t, i18n } = useTranslation("chat");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
  const checks = [...(data?.checks ?? [])].sort(bySoonest);
  if (checks.length === 0) return null;
  const now = Date.now();
  // A check for a task goes by the task's title; a wait with no deadline has no time.
  const lineOf = (check: ChatPendingCheckDto) => {
    const when = check.at === null ? null : formatTaskTime(check.at, now, i18n.language);
    const name = check.taskTitle ?? check.name;
    if (when === null) return name;
    if (check.waitingFor && !check.taskTitle) {
      return t("checks.waiting", { what: check.waitingFor, when });
    }
    return t("checks.timed", { name, when });
  };
  const first = checks[0] as ChatPendingCheckDto;
  const summary =
    checks.length === 1
      ? lineOf(first)
      : t("checks.summary", { count: checks.length, next: lineOf(first) });
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col gap-1 px-1 pb-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t(open ? "checks.collapse" : "checks.expand")}
        onClick={() => setOpen((current) => !current)}
        className="flex min-w-0 items-center gap-2 rounded-12 border border-border bg-surface/95 px-3 py-1 text-left text-aux text-muted-foreground outline-1 outline-offset-0 outline-transparent backdrop-blur-md transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50 supports-[backdrop-filter]:bg-surface/80 motion-reduce:transition-none"
      >
        <Clock className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <Chevron className="size-3.5 shrink-0" aria-hidden />
      </button>
      {open ? (
        <ul aria-label={t("checks.label")} className="flex flex-col gap-1">
          {checks.map((check) => (
            <li
              key={check.id}
              className="flex items-center gap-2 rounded-12 border border-border bg-surface/95 py-1 pl-3 pr-1 text-aux text-muted-foreground backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
            >
              <Clock className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{lineOf(check)}</span>
              <IconButton
                size="xs"
                label={t(check.recurring ? "checks.skip" : "checks.cancel", {
                  name: check.taskTitle ?? check.name,
                })}
                icon={<X />}
                disabled={cancel.isPending && cancel.variables === check.id}
                onClick={() => cancel.mutate(check.id)}
                className="text-muted-foreground hover:text-foreground"
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
