import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock, MessageSquare, Radio, Workflow } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import {
  TASK_LIST_CHANGED_EVENT,
  type TaskListCheckItem,
  type TaskListFollowItem,
  type TaskListGroupKey,
  type TaskListItem,
  type TaskListResponse,
  type TaskListRoutineItem,
  type TaskListTaskItem,
} from "@rome/api-types/task-list";
import { taskStatusOfDto } from "@rome/api-types/concierge-task-status";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveEvents } from "@/hooks/use-live-events";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { requestConciergeJump } from "./concierge-jump";
import { TaskGlyph } from "./TaskGlyph";
import { formatTaskTime } from "./tasks";
import { describeRoutineTrigger, describeTaskSchedule, formatClock } from "./task-list-words";

export const chatTaskListKey = (chatId: string) => ["chat-tasks", chatId] as const;
const listUrl = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}/tasks`;
const changedSchema = z.object({ chatId: z.string() });

/** How many ended rows show at first, and how many more each "Show more" adds. */
export const ENDED_PAGE = 20;

type Translate = ReturnType<typeof useTranslation<"chat">>["t"];

/** One quiet line under a row's title: its state, then the time that goes with it. */
const stateLine = (...parts: Array<string | null | undefined | false>) =>
  parts.filter(Boolean).join(" · ");

/** A row's button, shown on hover and focus, and always on a touch screen. */
interface RowButton {
  label: string;
  text: string;
  onPress: () => void;
}

/**
 * A row of the task list, the same for every kind: a mark, the title with a
 * small link to its task chat when it has one, and one line of state and time
 * under it. The right side holds buttons only, never information, and they
 * show on hover; a pending row keeps them shown and disabled. The row itself
 * does nothing when pressed.
 */
function Row({
  glyph,
  title,
  chat,
  state,
  tone,
  dimmed,
  buttons = [],
  pending = false,
  onNavigate,
}: {
  glyph: ReactNode;
  title: string;
  chat?: { id: string; label: string } | null;
  state: string;
  tone?: "warning" | "destructive";
  dimmed?: boolean;
  buttons?: RowButton[];
  /** A press is under way: the buttons stay shown and take no other. */
  pending?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <li
      data-task-list-row
      className="group/row flex min-h-12 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover"
    >
      <span className={cn("flex shrink-0", dimmed && "opacity-60")}>{glyph}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span
            className={cn(
              "min-w-0 truncate text-ui",
              dimmed ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </span>
          {chat ? (
            <Link
              to={`/chat/${chat.id}`}
              onClick={onNavigate}
              aria-label={chat.label}
              title={chat.label}
              className="flex size-5 shrink-0 items-center justify-center rounded-4 text-subtle-foreground outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
            >
              <MessageSquare className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
        {state ? (
          <div
            className={cn(
              "truncate text-aux",
              tone === "warning"
                ? "text-warning"
                : tone === "destructive"
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            {state}
          </div>
        ) : null}
      </div>
      {buttons.length > 0 ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1",
            !pending &&
              "touch-show opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100",
          )}
        >
          {buttons.map((button) => (
            <Button
              key={button.text}
              variant="ghost"
              size="xs"
              aria-label={button.label}
              disabled={pending}
              onClick={button.onPress}
            >
              {button.text}
            </Button>
          ))}
        </span>
      ) : null}
    </li>
  );
}

/** What a task's line says: what it waits for, that it runs, when it runs next, or how it ended. */
function taskState(
  item: TaskListTaskItem,
  t: Translate,
  now: number,
  locale: string,
  pending: "stop" | "respond" | undefined,
): string {
  if (pending === "stop") return t("concierge.taskList.task.stopping");
  if (pending === "respond") return t("concierge.taskList.task.opening");
  const { task, schedule, check } = item;
  const status = taskStatusOfDto(task);
  const repeats = schedule ? describeTaskSchedule(schedule, t, locale) : null;
  const when = (at: number) => formatTaskTime(at, now, locale);
  switch (status.status) {
    case "needs_you":
      return stateLine(
        task.openWait?.kind === "approval"
          ? t("concierge.taskList.task.waitingApproval")
          : t("concierge.taskList.task.waitingAnswer"),
        task.waitingSince != null && when(task.waitingSince),
      );
    case "active":
      return stateLine(repeats, t("concierge.taskList.task.running"));
    case "later":
      if (check?.at != null) {
        return check.recurring
          ? stateLine(repeats, when(check.at))
          : t("concierge.taskList.task.checksIn", { when: when(check.at) });
      }
      return repeats ?? t("concierge.taskList.task.notStarted");
    case "ended":
      return stateLine(
        t(`concierge.taskList.task.ended.${status.endReason ?? "done"}`),
        when(task.completedAt ?? task.updatedAt),
      );
  }
}

function TaskRow({
  item,
  now,
  pending,
  onPress,
  onNavigate,
}: {
  item: TaskListTaskItem;
  now: number;
  pending: "stop" | "respond" | undefined;
  onPress: (action: "stop" | "respond") => void;
  onNavigate?: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const { task } = item;
  const status = taskStatusOfDto(task);
  // Respond only where a card waits on its owner; Stop on every task that has not ended.
  const buttons: RowButton[] = [];
  if (status.status === "needs_you") {
    buttons.push({
      label: t("concierge.taskList.actions.respondTo", { title: task.title }),
      text: t("concierge.taskList.actions.respond"),
      onPress: () => onPress("respond"),
    });
  }
  if (status.status !== "ended") {
    buttons.push({
      label: t("concierge.taskList.actions.stopTask", { title: task.title }),
      text: t("concierge.taskList.actions.stop"),
      onPress: () => onPress("stop"),
    });
  }
  return (
    <Row
      glyph={<TaskGlyph status={status} />}
      title={task.title}
      chat={
        task.chat
          ? {
              id: task.chat.id,
              label: t("concierge.taskList.actions.openChat", { title: task.title }),
            }
          : null
      }
      state={taskState(item, t, now, i18n.language, pending)}
      tone={status.status === "needs_you" && !pending ? "warning" : undefined}
      dimmed={status.status === "ended"}
      buttons={buttons}
      pending={pending !== undefined}
      onNavigate={onNavigate}
    />
  );
}

function CheckRow({ item, now }: { item: TaskListCheckItem; now: number }) {
  const { t, i18n } = useTranslation("chat");
  const { check } = item;
  const when = check.at === null ? null : formatTaskTime(check.at, now, i18n.language);
  return (
    <Row
      glyph={<Clock className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={check.name}
      state={
        check.waitingFor
          ? stateLine(t("concierge.taskList.check.waiting", { what: check.waitingFor }), when)
          : when
            ? t("concierge.taskList.task.checksIn", { when })
            : ""
      }
    />
  );
}

function FollowRow({ item }: { item: TaskListFollowItem }) {
  const { t, i18n } = useTranslation("chat");
  const digest =
    item.digestTimes.length > 0
      ? t("concierge.taskList.follow.digest", {
          times: new Intl.ListFormat(i18n.language, { style: "short", type: "unit" }).format(
            item.digestTimes.map((time) => formatClock(time, i18n.language)),
          ),
        })
      : null;
  return (
    <Row
      glyph={<Radio className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={item.target}
      state={stateLine(
        item.label,
        item.state === "unavailable"
          ? t("concierge.taskList.follow.unavailable")
          : item.state === "off" && t("concierge.taskList.follow.off"),
        digest,
      )}
      dimmed={item.state !== "active"}
    />
  );
}

function RoutineRow({ item, now }: { item: TaskListRoutineItem; now: number }) {
  const { t, i18n } = useTranslation("chat");
  const failed = item.lastRun?.status === "error";
  return (
    <Row
      glyph={<Workflow className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={item.name}
      state={stateLine(
        describeRoutineTrigger(item.trigger, t, i18n.language),
        !item.enabled && t("concierge.taskList.routine.paused"),
        item.nextRunAt !== null && formatTaskTime(item.nextRunAt, now, i18n.language),
        failed && t("concierge.taskList.routine.lastFailed"),
      )}
      tone={failed ? "destructive" : undefined}
      dimmed={!item.enabled}
    />
  );
}

const itemKey = (item: TaskListItem) =>
  item.kind === "task"
    ? `task:${item.task.id}`
    : item.kind === "check"
      ? `check:${item.check.id}`
      : item.kind === "follow"
        ? `follow:${item.source}:${item.target}`
        : `routine:${item.id}`;

/** Three placeholder rows while the first read is on its way, so the panel is never blank. */
function LoadingRows() {
  const { t } = useTranslation("chat");
  return (
    <div role="status" aria-label={t("concierge.taskList.loading")} className="px-4 pb-6 pt-4">
      <Skeleton className="mb-2 ml-3 h-3 w-20" />
      <div className="divide-y divide-border overflow-hidden rounded-12 border border-border bg-surface">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex min-h-12 items-center gap-3 px-3 py-2">
            <Skeleton className="size-4 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Whether a pressed task's row can let go of its pending look: a stop once
 * the task reads as ended; a respond only when its jump lands.
 */
function settled(item: TaskListTaskItem | undefined, action: "stop" | "respond"): boolean {
  if (!item) return true;
  return action === "stop" && taskStatusOfDto(item.task).status === "ended";
}

/**
 * A Concierge chat's task list, the Tasks panel: what runs for the chat,
 * grouped as Needs you, Active, Later, Running on its own and Ended, each a
 * titled card of rows. Ended starts folded and shows the newest rows first.
 * It reads again whenever the server says something in it changed.
 */
export function TaskList({ chatId, onNavigate }: { chatId: string; onNavigate?: () => void }) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [endedOpen, setEndedOpen] = useState(false);
  const [endedShown, setEndedShown] = useState(ENDED_PAGE);
  const [pending, setPending] = useState<ReadonlyMap<string, "stop" | "respond">>(new Map());
  const { data, isError } = useQuery({
    queryKey: chatTaskListKey(chatId),
    queryFn: () =>
      fetchJson<TaskListResponse>(listUrl(chatId), {
        fallback: t("concierge.taskList.loadFailed"),
      }),
  });
  const reread = () => queryClient.invalidateQueries({ queryKey: chatTaskListKey(chatId) });
  useLiveEvents(
    { topic: chatTasksTopicName(chatId), sseUrl: `${listUrl(chatId)}/events` },
    { [TASK_LIST_CHANGED_EVENT]: { schema: changedSchema, fn: reread } },
    { onReconnect: reread },
  );
  // Times count down by the minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // A pressed Stop stays pending until the task is no longer at work.
  useEffect(() => {
    if (!data || pending.size === 0) return;
    const tasks = new Map(
      data.groups.flatMap((group) =>
        group.items.flatMap((item) =>
          item.kind === "task" ? [[item.task.id, item] as const] : [],
        ),
      ),
    );
    const left = new Map([...pending].filter(([id, action]) => !settled(tasks.get(id), action)));
    if (left.size !== pending.size) setPending(left);
  }, [data, pending]);

  const press = (item: TaskListTaskItem, action: "stop" | "respond") => {
    const id = item.task.id;
    setPending((current) => new Map(current).set(id, action));
    const release = () =>
      setPending((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    if (action === "respond") {
      const target = item.cardMessageId;
      if (!target) {
        // No message of this chat shows the card it waits on: its task chat holds it.
        release();
        if (!item.task.chat) {
          toast.error(t("concierge.tasks.sourceMissing"));
          return;
        }
        onNavigate?.();
        navigate(`/chat/${item.task.chat.id}`);
        return;
      }
      onNavigate?.();
      void requestConciergeJump(target).finally(release);
      return;
    }
    void fetchJson<unknown>(`${listUrl(chatId)}/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      fallback: t("concierge.taskList.failed.stop"),
    }).then(reread, (error: Error) => {
      release();
      toast.error(error.message);
    });
  };

  if (isError) {
    return (
      <p className="px-4 py-6 text-center text-aux text-muted-foreground">
        {t("concierge.taskList.loadFailed")}
      </p>
    );
  }
  if (!data) return <LoadingRows />;
  if (data.groups.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-ui text-muted-foreground">
        {t("concierge.taskList.empty")}
      </p>
    );
  }
  const row = (item: TaskListItem) => {
    switch (item.kind) {
      case "task":
        return (
          <TaskRow
            key={itemKey(item)}
            item={item}
            now={now}
            pending={pending.get(item.task.id)}
            onPress={(action) => press(item, action)}
            onNavigate={onNavigate}
          />
        );
      case "check":
        return <CheckRow key={itemKey(item)} item={item} now={now} />;
      case "follow":
        return <FollowRow key={itemKey(item)} item={item} />;
      case "routine":
        return <RoutineRow key={itemKey(item)} item={item} now={now} />;
    }
  };
  return (
    <div className="flex flex-col gap-5 px-4 pb-6 pt-4">
      {data.groups.map((group) => {
        const folds = group.key === "ended";
        const open = !folds || endedOpen;
        const heading = t(`concierge.taskList.groups.${group.key satisfies TaskListGroupKey}`);
        const items = folds ? group.items.slice(0, endedShown) : group.items;
        const more = group.items.length - items.length;
        return (
          <section key={group.key} aria-label={heading} data-task-list-group={group.key}>
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
                {items.map(row)}
                {more > 0 ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => setEndedShown((shown) => shown + ENDED_PAGE)}
                      className="flex min-h-10 w-full items-center justify-center text-aux text-muted-foreground outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
                    >
                      {t("concierge.taskList.showMore", { count: Math.min(more, ENDED_PAGE) })}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
