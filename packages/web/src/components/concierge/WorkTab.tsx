import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClockOff,
  ChevronDown,
  Clock,
  MessageSquare,
  Pause,
  Play,
  Radio,
  Repeat,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import {
  CHAT_WORK_CHANGED_EVENT,
  type ChatWorkCheckItem,
  type ChatWorkFollowItem,
  type ChatWorkGroupKey,
  type ChatWorkItem,
  type ChatWorkResponse,
  type ChatWorkRoutineItem,
  type ChatWorkTaskItem,
} from "@rome/api-types/chat-work";
import { taskStatusOfDto } from "@rome/api-types/concierge-task-status";
import { chatWorkTopicName } from "@rome/api-types/live-events";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useLiveEvents } from "@/hooks/use-live-events";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { requestConciergeJump } from "./concierge-jump";
import { StopGlyph } from "./StopGlyph";
import { TaskGlyph } from "./TaskGlyph";
import { formatTaskTime } from "./tasks";
import { describeRoutineTrigger, describeTaskSchedule, formatClock } from "./work";

export const chatWorkKey = (chatId: string) => ["chat-work", chatId] as const;
const workUrl = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}/work`;
const workChangedSchema = z.object({ chatId: z.string() });

type Translate = ReturnType<typeof useTranslation<"chat">>["t"];

/** One of the row's buttons: a label, an icon, and what a press does. */
interface RowAction {
  label: string;
  icon: ReactNode;
  run: () => void;
}

/**
 * A row of the Work tab: a mark, a title with one quiet line under it, the
 * time that matters on the right, and its buttons. The buttons show on hover
 * or focus, and always on a touch screen, where the time yields to them.
 */
function WorkRow({
  glyph,
  title,
  titleExtra,
  detail,
  detailTone,
  time,
  dimmed,
  open,
  onTitle,
  actions,
}: {
  glyph: ReactNode;
  title: string;
  titleExtra?: ReactNode;
  detail?: string | null;
  detailTone?: "warning" | "destructive";
  time?: string | null;
  dimmed?: boolean;
  open?: { to: string; label: string; onNavigate?: () => void };
  onTitle?: () => void;
  actions: RowAction[];
}) {
  // Where buttons take the time's place, the time yields to them on hover or focus.
  const hasButtons = actions.length > 0 || open !== undefined;
  const titleText = (
    <span className={cn("flex min-w-0 items-center gap-1.5", dimmed && "text-muted-foreground")}>
      <span className="min-w-0 truncate text-ui text-foreground">{title}</span>
      {titleExtra}
    </span>
  );
  return (
    <li className="group/row relative flex min-h-12 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover">
      <span className={cn("flex shrink-0", dimmed && "opacity-60")}>{glyph}</span>
      <div className="min-w-0 flex-1">
        {onTitle ? (
          <button
            type="button"
            onClick={onTitle}
            // Full width, so a long title stays inside the card.
            className="block w-full min-w-0 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-1 focus-visible:after:-outline-offset-1 focus-visible:after:outline-solid focus-visible:after:outline-ring/50"
          >
            {titleText}
          </button>
        ) : (
          titleText
        )}
        {detail ? (
          <div
            className={cn(
              "truncate text-aux",
              detailTone === "warning"
                ? "text-warning"
                : detailTone === "destructive"
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            {detail}
          </div>
        ) : null}
      </div>
      {time || hasButtons ? (
        <span className="relative z-10 grid shrink-0 items-center justify-items-end">
          {time ? (
            <span
              className={cn(
                "col-start-1 row-start-1 text-aux tabular-nums text-subtle-foreground",
                hasButtons &&
                  "transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0 [@media(hover:none)]:opacity-0",
              )}
            >
              {time}
            </span>
          ) : null}
          <span
            className={cn(
              "col-start-1 row-start-1 flex items-center gap-0.5",
              hasButtons &&
                "touch-show opacity-0 transition-opacity focus-within:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
            )}
          >
            {actions.map((action) => (
              <IconButton
                key={action.label}
                size="xs"
                label={action.label}
                icon={action.icon}
                onClick={action.run}
                className="text-muted-foreground hover:text-foreground"
              />
            ))}
            {open ? (
              <Button
                asChild
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
              >
                <Link
                  to={open.to}
                  onClick={open.onNavigate}
                  aria-label={open.label}
                  title={open.label}
                >
                  <MessageSquare />
                </Link>
              </Button>
            ) : null}
          </span>
        </span>
      ) : null}
    </li>
  );
}

/** What a task's line says: what it waits for, that it runs, when it runs next, or how it ended. */
function taskDetail(item: ChatWorkTaskItem, t: Translate, now: number, locale: string) {
  const { task, schedule, check } = item;
  const status = taskStatusOfDto(task);
  const repeats = schedule ? describeTaskSchedule(schedule, t, locale) : null;
  switch (status.status) {
    case "needs_you":
      return task.openWait?.kind === "approval"
        ? t("concierge.work.task.waitingApproval")
        : t("concierge.work.task.waitingAnswer");
    case "active":
      return [t("concierge.work.task.running"), repeats].filter(Boolean).join(" · ");
    case "later": {
      if (check?.at != null) {
        const when = formatTaskTime(check.at, now, locale);
        return check.recurring
          ? [repeats, t("concierge.work.task.nextRun", { when })].filter(Boolean).join(" · ")
          : t("concierge.work.task.checksIn", { when });
      }
      return repeats ?? t("concierge.work.task.notStarted");
    }
    case "ended":
      return t(`concierge.work.task.ended.${status.endReason ?? "done"}`);
  }
}

function TaskRow({
  item,
  chatId,
  now,
  onNavigate,
}: {
  item: ChatWorkTaskItem;
  chatId: string;
  now: number;
  onNavigate?: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const { task, schedule, check } = item;
  const status = taskStatusOfDto(task);
  const act = useWorkAction(chatId);
  const ended = status.status === "ended";
  const actions: RowAction[] = [];
  if (status.status === "later" && check) {
    actions.push({
      label: check.recurring
        ? t("concierge.work.actions.skipRun")
        : t("concierge.work.actions.cancelCheck"),
      icon: <AlarmClockOff />,
      run: () =>
        act({
          path: `checks/${encodeURIComponent(check.id)}`,
          method: "DELETE",
          failed: t(
            check.recurring ? "concierge.work.failed.skipRun" : "concierge.work.failed.cancelCheck",
          ),
        }),
    });
  }
  if (!ended) {
    actions.push({
      label: t("concierge.work.actions.stop", { title: task.title }),
      icon: <StopGlyph />,
      run: () =>
        act({
          path: `tasks/${encodeURIComponent(task.id)}/stop`,
          method: "POST",
          failed: t("concierge.work.failed.stop"),
        }),
    });
  }
  const time =
    status.status === "later" && check?.at != null
      ? formatTaskTime(check.at, now, i18n.language)
      : ended
        ? formatTaskTime(task.completedAt ?? task.updatedAt, now, i18n.language)
        : null;
  return (
    <WorkRow
      glyph={<TaskGlyph status={status} />}
      title={task.title}
      titleExtra={
        schedule ? (
          <Repeat
            className="size-3.5 shrink-0 text-subtle-foreground"
            aria-label={t("concierge.work.task.repeats")}
          />
        ) : null
      }
      detail={taskDetail(item, t, now, i18n.language)}
      detailTone={status.status === "needs_you" ? "warning" : undefined}
      time={time}
      dimmed={ended}
      // The title goes to the message the task works for, in this chat.
      onTitle={
        task.sourceMessageId
          ? () => {
              onNavigate?.();
              requestConciergeJump(task.sourceMessageId as string);
            }
          : undefined
      }
      open={
        task.chat
          ? {
              to: `/chat/${task.chat.id}`,
              label: t("concierge.work.actions.open", { title: task.title }),
              onNavigate,
            }
          : undefined
      }
      actions={actions}
    />
  );
}

function CheckRow({ item, chatId, now }: { item: ChatWorkCheckItem; chatId: string; now: number }) {
  const { t, i18n } = useTranslation("chat");
  const act = useWorkAction(chatId);
  const { check } = item;
  return (
    <WorkRow
      glyph={<Clock className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={check.name}
      detail={
        check.waitingFor ? t("concierge.work.check.waiting", { what: check.waitingFor }) : null
      }
      time={check.at === null ? null : formatTaskTime(check.at, now, i18n.language)}
      actions={[
        {
          label: t("concierge.work.actions.cancelCheck"),
          icon: <X />,
          run: () =>
            act({
              path: `checks/${encodeURIComponent(check.id)}`,
              method: "DELETE",
              failed: t("concierge.work.failed.cancelCheck"),
            }),
        },
      ]}
    />
  );
}

function FollowRow({ item, chatId }: { item: ChatWorkFollowItem; chatId: string }) {
  const { t, i18n } = useTranslation("chat");
  const act = useWorkAction(chatId);
  const digest =
    item.digestTimes.length > 0
      ? t("concierge.work.follow.digest", {
          times: new Intl.ListFormat(i18n.language, { style: "short", type: "unit" }).format(
            item.digestTimes.map((time) => formatClock(time, i18n.language)),
          ),
        })
      : null;
  const state =
    item.state === "unavailable"
      ? t("concierge.work.follow.unavailable")
      : item.state === "off"
        ? t("concierge.work.follow.off")
        : null;
  return (
    <WorkRow
      glyph={<Radio className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={item.target}
      detail={[item.label, state, digest].filter(Boolean).join(" · ")}
      dimmed={item.state !== "active"}
      actions={[
        {
          label: t("concierge.work.actions.unfollow", { target: item.target }),
          icon: <X />,
          run: () =>
            act({
              path: "follows/unfollow",
              method: "POST",
              json: { source: item.source, target: item.target },
              failed: t("concierge.work.failed.unfollow"),
            }),
        },
      ]}
    />
  );
}

function RoutineRow({
  item,
  chatId,
  now,
}: {
  item: ChatWorkRoutineItem;
  chatId: string;
  now: number;
}) {
  const { t, i18n } = useTranslation("chat");
  const act = useWorkAction(chatId);
  const failed = item.lastRun?.status === "error";
  const path = `routines/${encodeURIComponent(item.id)}`;
  const actions: RowAction[] = [
    item.enabled
      ? {
          label: t("concierge.work.actions.pause", { name: item.name }),
          icon: <Pause />,
          run: () =>
            act({
              path: `${path}/pause`,
              method: "POST",
              failed: t("concierge.work.failed.pause"),
            }),
        }
      : {
          label: t("concierge.work.actions.resume", { name: item.name }),
          icon: <Play />,
          run: () =>
            act({
              path: `${path}/resume`,
              method: "POST",
              failed: t("concierge.work.failed.resume"),
            }),
        },
  ];
  // An app keeps its own routines: only it deletes one.
  if (!item.managed) {
    actions.push({
      label: t("concierge.work.actions.delete", { name: item.name }),
      icon: <Trash2 />,
      run: () => act({ path, method: "DELETE", failed: t("concierge.work.failed.delete") }),
    });
  }
  return (
    <WorkRow
      glyph={<Workflow className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={item.name}
      detail={[
        describeRoutineTrigger(item.trigger, t, i18n.language),
        item.enabled ? null : t("concierge.work.routine.paused"),
        failed ? t("concierge.work.routine.lastFailed") : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      detailTone={failed ? "destructive" : undefined}
      time={item.nextRunAt === null ? null : formatTaskTime(item.nextRunAt, now, i18n.language)}
      dimmed={!item.enabled}
      actions={actions}
    />
  );
}

/** Sends one of the tab's actions and reads the tab again; a failure shows as a toast. */
function useWorkAction(chatId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      path,
      method,
      json,
      failed,
    }: {
      path: string;
      method: "POST" | "DELETE";
      json?: unknown;
      failed: string;
    }) => fetchJson<unknown>(`${workUrl(chatId)}/${path}`, { method, json, fallback: failed }),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatWorkKey(chatId) }),
  });
  return mutation.mutate;
}

function ItemRow({
  item,
  chatId,
  now,
  onNavigate,
}: {
  item: ChatWorkItem;
  chatId: string;
  now: number;
  onNavigate?: () => void;
}) {
  switch (item.kind) {
    case "task":
      return <TaskRow item={item} chatId={chatId} now={now} onNavigate={onNavigate} />;
    case "check":
      return <CheckRow item={item} chatId={chatId} now={now} />;
    case "follow":
      return <FollowRow item={item} chatId={chatId} />;
    case "routine":
      return <RoutineRow item={item} chatId={chatId} now={now} />;
  }
}

const itemKey = (item: ChatWorkItem) =>
  item.kind === "task"
    ? `task:${item.task.id}`
    : item.kind === "check"
      ? `check:${item.check.id}`
      : item.kind === "follow"
        ? `follow:${item.source}:${item.target}`
        : `routine:${item.id}`;

/**
 * The Work tab of a Concierge chat's Agent page: what runs for the chat,
 * grouped as Needs you, Active, Later, Running on its own and Ended, each a
 * titled card of rows. Ended starts folded. Read again whenever the server
 * says something in it changed.
 */
export function WorkTab({ chatId, onNavigate }: { chatId: string; onNavigate?: () => void }) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  const [endedOpen, setEndedOpen] = useState(false);
  const { data, isError } = useQuery({
    queryKey: chatWorkKey(chatId),
    queryFn: () =>
      fetchJson<ChatWorkResponse>(workUrl(chatId), { fallback: t("concierge.work.loadFailed") }),
  });
  useLiveEvents(
    { topic: chatWorkTopicName(chatId), sseUrl: `${workUrl(chatId)}/events` },
    {
      [CHAT_WORK_CHANGED_EVENT]: {
        schema: workChangedSchema,
        fn: () => queryClient.invalidateQueries({ queryKey: chatWorkKey(chatId) }),
      },
    },
    { onReconnect: () => queryClient.invalidateQueries({ queryKey: chatWorkKey(chatId) }) },
  );
  // Times count down by the minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (isError) {
    return (
      <p className="px-4 py-6 text-center text-aux text-muted-foreground">
        {t("concierge.work.loadFailed")}
      </p>
    );
  }
  if (!data) return null;
  if (data.groups.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-ui text-muted-foreground">
        {t("concierge.work.empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5 px-4 pb-6 pt-1">
      {data.groups.map((group) => {
        const folds = group.key === "ended";
        const open = !folds || endedOpen;
        const heading = t(`concierge.work.groups.${group.key satisfies ChatWorkGroupKey}`);
        return (
          <section key={group.key} aria-label={heading} data-work-group={group.key}>
            {folds ? (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setEndedOpen((value) => !value)}
                className="mb-1.5 flex items-center gap-1 px-3 text-aux font-medium text-muted-foreground outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
              >
                <ChevronDown
                  className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
                  aria-hidden
                />
                {heading}{" "}
                <span className="tabular-nums text-subtle-foreground">{group.items.length}</span>
              </button>
            ) : (
              <h3 className="mb-1.5 px-3 text-aux font-medium text-muted-foreground">{heading}</h3>
            )}
            {open ? (
              <ul className="divide-y divide-border overflow-hidden rounded-12 border border-border bg-surface">
                {group.items.map((item) => (
                  <ItemRow
                    key={itemKey(item)}
                    item={item}
                    chatId={chatId}
                    now={now}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
