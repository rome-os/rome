import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock, Radio, Square, Workflow } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import {
  TASK_LIST_CHANGED_EVENT,
  TASK_LIST_ENDED_PAGE,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  connectorOf,
  followStateWith,
  refreshConciergeConnectors,
  useConciergeConnectors,
} from "@/hooks/use-concierge-connectors";
import { useLiveEvents } from "@/hooks/use-live-events";
import { fetchJson } from "@/lib/fetch-json";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { cn } from "@/lib/utils";
import { TaskGlyph } from "./TaskGlyph";
import { formatTaskTime } from "./tasks";
import { describeRoutineTrigger, describeTaskSchedule, formatClock } from "./task-list-words";

export const chatTaskListKey = (chatId: string) => ["chat-tasks", chatId] as const;
const listUrl = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}/tasks`;
const changedSchema = z.object({ chatId: z.string(), follows: z.literal(true).optional() });

/** How many ended rows show at first, and how many more each "Show more" adds. */
export const ENDED_PAGE = TASK_LIST_ENDED_PAGE;

/** What a list shows: the task chats, or the routines, follows and reminders that run on their own. */
export type TaskListView = "tasks" | "routines";

/** The groups the Tasks view lists, in order. The rest are routines. */
const TASK_GROUPS: readonly TaskListGroupKey[] = ["needs_you", "active", "later", "ended"];

type Translate = ReturnType<typeof useTranslation<"chat">>["t"];

/** One quiet line under a row's title: its state, then the time that goes with it. */
const stateLine = (...parts: Array<string | null | undefined | false>) =>
  parts.filter(Boolean).join(" · ");

/**
 * A Concierge chat's Tasks view, read now and whenever the server says
 * something in it changed. The header reads it too, for the dot on its Tasks
 * button.
 */
export function useChatTaskList(chatId: string | null) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: chatTaskListKey(chatId ?? ""),
    enabled: chatId !== null,
    queryFn: () =>
      fetchJson<TaskListResponse>(listUrl(chatId ?? ""), {
        fallback: t("concierge.taskList.loadFailed"),
      }),
  });
  const reread = () => queryClient.invalidateQueries({ queryKey: chatTaskListKey(chatId ?? "") });
  useLiveEvents(
    {
      topic: chatTasksTopicName(chatId ?? ""),
      sseUrl: `${listUrl(chatId ?? "")}/events`,
    },
    {
      [TASK_LIST_CHANGED_EVENT]: {
        schema: changedSchema,
        fn: ({ follows }) => {
          if (!chatId) return;
          void reread();
          // A new or changed follow may name a source the snapshot has not read.
          if (follows) void refreshConciergeConnectors(queryClient);
        },
      },
    },
    {
      enabled: chatId !== null,
      onReconnect: () => {
        void reread();
        void refreshConciergeConnectors(queryClient);
      },
    },
  );
  return {
    ...query,
    reread,
    /** Whether a task chat of the chat needs its owner. */
    needsYou: query.data?.groups.some((group) => group.key === "needs_you") ?? false,
  };
}

/** A row title's tooltip: when it ended, for a task chat that did. */
function timesOf(t: Translate, endedAt?: number | null): string[] {
  const at = (value: number) => formatMessageTimestamp(new Date(value).toISOString());
  return endedAt != null ? [t("concierge.taskList.endedAt", { when: at(endedAt) })] : [];
}

/** A row's icon button, shown on hover and focus, and always on a touch screen. */
interface RowButton {
  /** What it does to this row, for a screen reader. */
  label: string;
  /** Its name, as its tooltip says it. */
  text: string;
  icon: ReactNode;
  onPress: () => void;
}

/**
 * A row of the Tasks view, the same for every kind: a mark, the title, and one
 * line of state and time under it. A task chat's row opens its chat when
 * pressed, `to` being the chat. The right side holds buttons only, never
 * information, and they show on hover; a pending row keeps them shown and
 * disabled. The rows of what runs on its own have none.
 */
function Row({
  glyph,
  title,
  times = [],
  to,
  state,
  tone,
  dimmed,
  buttons = [],
  pending = false,
  onNavigate,
}: {
  glyph: ReactNode;
  title: string;
  /** The title's tooltip lines, such as when the row ended. */
  times?: string[];
  /** Where pressing the row goes: its task chat. */
  to?: string;
  state: string;
  tone?: "warning" | "destructive";
  dimmed?: boolean;
  buttons?: RowButton[];
  /** A press is under way: the buttons stay shown and take no other. */
  pending?: boolean;
  onNavigate?: () => void;
}) {
  const titleClass = cn(
    "min-w-0 truncate text-ui",
    dimmed ? "text-muted-foreground" : "text-foreground",
  );
  const titleEl = <span className={titleClass}>{title}</span>;
  return (
    <li
      data-task-list-row
      className={cn(
        "group/row relative flex min-h-12 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover",
      )}
    >
      <span className={cn("flex shrink-0", dimmed && "opacity-60")}>{glyph}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          {to ? (
            // The whole row is the link: its box covers the row, and the
            // buttons sit above it.
            <Link
              to={to}
              onClick={onNavigate}
              className={cn(
                titleClass,
                "outline-none outline-1 -outline-offset-1 outline-transparent after:absolute after:inset-0 focus-visible:after:outline-solid focus-visible:after:outline-1 focus-visible:after:-outline-offset-1 focus-visible:after:outline-ring/50",
              )}
            >
              {title}
            </Link>
          ) : times.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>{titleEl}</TooltipTrigger>
              <TooltipContent side="top" align="start">
                {times.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </TooltipContent>
            </Tooltip>
          ) : (
            titleEl
          )}
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
            "relative z-10 flex shrink-0 items-center gap-1",
            !pending &&
              "touch-show opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100",
          )}
        >
          {buttons.map((button) => (
            <Tooltip key={button.text}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-md"
                  aria-label={button.label}
                  disabled={pending}
                  onClick={button.onPress}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {button.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{button.text}</TooltipContent>
            </Tooltip>
          ))}
        </span>
      ) : null}
    </li>
  );
}

/** What a task chat's line says: its status word, then the time that goes with it. */
function taskState(
  item: TaskListTaskItem,
  t: Translate,
  now: number,
  locale: string,
  pending: boolean,
): string {
  if (pending) return t("concierge.taskList.task.stopping");
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
      return stateLine(repeats, t("concierge.taskList.task.active"), when(task.updatedAt));
    case "later":
      if (check?.at != null) {
        return check.recurring
          ? stateLine(repeats, when(check.at))
          : t("concierge.taskList.task.checksIn", { when: when(check.at) });
      }
      return repeats ?? "";
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
  onStop,
  onNavigate,
}: {
  item: TaskListTaskItem;
  now: number;
  pending: boolean;
  onStop: () => void;
  onNavigate?: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const { task } = item;
  const status = taskStatusOfDto(task);
  // Stop only, on every task chat that has not ended: the row itself opens it.
  const buttons: RowButton[] =
    status.status === "ended"
      ? []
      : [
          {
            label: t("concierge.taskList.actions.stopTask", { title: task.title }),
            text: t("concierge.taskList.actions.stop"),
            icon: <Square className="size-4" aria-hidden />,
            onPress: onStop,
          },
        ];
  return (
    <Row
      glyph={<TaskGlyph status={status} />}
      title={task.title}
      times={timesOf(t, status.status === "ended" ? (task.completedAt ?? task.updatedAt) : null)}
      to={`/chat/${encodeURIComponent(task.chat.id)}`}
      state={taskState(item, t, now, i18n.language, pending)}
      tone={status.status === "needs_you" && !pending ? "warning" : undefined}
      dimmed={status.status === "ended"}
      buttons={buttons}
      pending={pending}
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

function FollowRow({ item, now }: { item: TaskListFollowItem; now: number }) {
  const { t, i18n } = useTranslation("chat");
  const digest =
    item.digestTimes.length > 0
      ? t("concierge.taskList.follow.digest", {
          times: new Intl.ListFormat(i18n.language, { style: "short", type: "unit" }).format(
            item.digestTimes.map((time) => formatClock(time, i18n.language)),
          ),
        })
      : null;
  // Whether the service delivers now comes from the connector list, read once and shared.
  const { data: connectors } = useConciergeConnectors();
  const state = followStateWith(connectors, item);
  return (
    <Row
      glyph={<Radio className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={item.target}
      state={stateLine(
        connectorOf(connectors, item.source)?.label ?? item.label,
        state === "unavailable"
          ? t("concierge.taskList.follow.unavailable")
          : state === "off" && t("concierge.taskList.follow.off"),
        digest,
        item.nextAt != null && formatTaskTime(item.nextAt, now, i18n.language),
      )}
      dimmed={state !== "active"}
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
        item.fromTask && t("concierge.taskList.routine.fromTask", { title: item.fromTask.title }),
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
            <div className="flex flex-1 flex-col gap-2">
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
 * A Concierge chat's Tasks or Routines view. Tasks lists its task chats,
 * grouped as Needs you, Active, Later and Ended, each a titled card of rows;
 * Ended starts folded and shows the newest rows first. Routines lists what is
 * no task chat, such as routines, follows and one-off reminders, in one list
 * by the time each runs next. It reads again whenever the server says
 * something in it changed.
 */
export function TaskList({
  chatId,
  view = "tasks",
  onNavigate,
}: {
  chatId: string;
  view?: TaskListView;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("chat");
  const [endedOpen, setEndedOpen] = useState(false);
  // Older ended rows "Show more" read, past the first page, and the next page's cursor.
  const [older, setOlder] = useState<{ items: TaskListItem[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const { data, isError, reread } = useChatTaskList(chatId);
  // A re-read that changes the first page of ended rows may move rows across
  // the pages read before it: they go, and Show more reads on from the new
  // first page. A re-read with the same ended rows in the same order keeps them.
  const endedGroup = data?.groups.find((group) => group.key === "ended");
  const endedFirstPage = endedGroup
    ? [...endedGroup.items.map(itemKey), endedGroup.nextCursor ?? ""].join("\n")
    : null;
  const firstPageRead = useRef(endedFirstPage);
  firstPageRead.current = endedFirstPage;
  useEffect(() => {
    if (endedFirstPage !== null) setOlder(null);
  }, [endedFirstPage]);
  // Times count down by the minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // A pressed Stop stays pending until the task chat is no longer at work.
  useEffect(() => {
    if (!data || pending.size === 0) return;
    const tasks = new Map(
      data.groups.flatMap((group) =>
        group.items.flatMap((item) =>
          item.kind === "task" ? [[item.task.id, item] as const] : [],
        ),
      ),
    );
    const left = new Set(
      [...pending].filter((id) => {
        const item = tasks.get(id);
        return item !== undefined && taskStatusOfDto(item.task).status !== "ended";
      }),
    );
    if (left.size !== pending.size) setPending(left);
  }, [data, pending]);

  const stop = (item: TaskListTaskItem) => {
    const id = item.task.id;
    setPending((current) => new Set(current).add(id));
    void fetchJson<unknown>(`${listUrl(chatId)}/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      fallback: t("concierge.taskList.failed.stop"),
    }).then(reread, (error: Error) => {
      setPending((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
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
  const showMore = (cursor: string) => {
    setLoadingMore(true);
    const readFrom = firstPageRead.current;
    fetchJson<TaskListResponse>(`${listUrl(chatId)}?endedBefore=${encodeURIComponent(cursor)}`, {
      fallback: t("concierge.taskList.loadFailed"),
    })
      .then(
        (page) => {
          // The first page was read again meanwhile: this page may not follow it.
          if (firstPageRead.current !== readFrom) return;
          const ended = page.groups.find((group) => group.key === "ended");
          setOlder((current) => ({
            items: [...(current?.items ?? []), ...(ended?.items ?? [])],
            cursor: ended?.nextCursor ?? null,
          }));
        },
        (error: Error) => toast.error(error.message),
      )
      .finally(() => setLoadingMore(false));
  };
  const row = (item: TaskListItem) => {
    switch (item.kind) {
      case "task":
        return (
          <TaskRow
            key={itemKey(item)}
            item={item}
            now={now}
            pending={pending.has(item.task.id)}
            onStop={() => stop(item)}
            onNavigate={onNavigate}
          />
        );
      case "check":
        return <CheckRow key={itemKey(item)} item={item} now={now} />;
      case "follow":
        return <FollowRow key={itemKey(item)} item={item} now={now} />;
      case "routine":
        return <RoutineRow key={itemKey(item)} item={item} now={now} />;
    }
  };

  const onItsOwn = data.groups.find((group) => group.key === "on_its_own")?.items ?? [];
  const taskGroups = data.groups.filter((group) => TASK_GROUPS.includes(group.key));
  return (
    <TooltipProvider delayDuration={500}>
      {view === "routines" ? (
        onItsOwn.length === 0 ? (
          <p className="px-4 py-6 text-center text-ui text-muted-foreground">
            {t("concierge.taskList.emptyRoutines")}
          </p>
        ) : (
          <section
            aria-label={t("concierge.taskList.routines")}
            data-task-list-group="on_its_own"
            className="px-4 pb-6 pt-4"
          >
            <ul className="divide-y divide-border overflow-hidden rounded-12 border border-border bg-surface">
              {onItsOwn.map(row)}
            </ul>
          </section>
        )
      ) : taskGroups.length === 0 ? (
        <p className="px-4 py-6 text-center text-ui text-muted-foreground">
          {t("concierge.taskList.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-5 px-4 pb-6 pt-4">
          {taskGroups.map((group) => {
            const folds = group.key === "ended";
            const open = !folds || endedOpen;
            const heading = t(`concierge.taskList.groups.${group.key satisfies TaskListGroupKey}`);
            // The first page, then the older pages read since, each row once.
            const firstPage = new Set(group.items.map(itemKey));
            const items = folds
              ? [
                  ...group.items,
                  ...(older?.items ?? []).filter((item) => !firstPage.has(itemKey(item))),
                ]
              : group.items;
            const total = group.total ?? items.length;
            const cursor = older ? older.cursor : (group.nextCursor ?? null);
            const more = folds && cursor ? total - items.length : 0;
            return (
              <section key={group.key} aria-label={heading} data-task-list-group={group.key}>
                {folds ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setEndedOpen((value) => !value)}
                    className="mb-2 flex items-center gap-1 px-3 text-aux font-medium text-muted-foreground outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
                  >
                    <ChevronDown
                      className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
                      aria-hidden
                    />
                    {heading} <span className="tabular-nums text-subtle-foreground">{total}</span>
                  </button>
                ) : (
                  <h3 className="mb-2 px-3 text-aux font-medium text-muted-foreground">
                    {heading}
                  </h3>
                )}
                {open ? (
                  <ul className="divide-y divide-border overflow-hidden rounded-12 border border-border bg-surface">
                    {items.map(row)}
                    {more > 0 ? (
                      <li>
                        <button
                          type="button"
                          disabled={loadingMore}
                          onClick={() => cursor && showMore(cursor)}
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
      )}
    </TooltipProvider>
  );
}
