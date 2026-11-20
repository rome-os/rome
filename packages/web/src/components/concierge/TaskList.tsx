import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Clock,
  Ellipsis,
  Pause,
  Play,
  Radio,
  Square,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import {
  TASK_LIST_CHANGED_EVENT,
  TASK_LIST_ENDED_PAGE,
  TASK_LIST_PANEL_GROUPING,
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
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
/** The list in the one panel's groups, from `cursor` on for the ended group alone. */
const readUrl = (chatId: string, cursor?: string) =>
  `${listUrl(chatId)}?grouping=${TASK_LIST_PANEL_GROUPING}${
    cursor ? `&endedBefore=${encodeURIComponent(cursor)}` : ""
  }`;
const changedSchema = z.object({ chatId: z.string(), follows: z.literal(true).optional() });

/** How many ended rows show at first, and how many more each "Show more" adds. */
export const ENDED_PAGE = TASK_LIST_ENDED_PAGE;

type Translate = ReturnType<typeof useTranslation<"chat">>["t"];

/** One quiet line under a row's title: its state, then the time that goes with it. */
const stateLine = (...parts: Array<string | null | undefined | false>) =>
  parts.filter(Boolean).join(" · ");

/**
 * A Concierge chat's task list, read now and whenever the server says
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
      fetchJson<TaskListResponse>(readUrl(chatId ?? ""), {
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

/** One action of a row's ⋯ menu. */
interface RowAction {
  text: string;
  icon: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}

/**
 * A row of the task list, the same for every kind: a mark, the title, and one
 * line of state and time under it. A task chat's row opens its chat when
 * pressed, `to` being the chat. The right side holds only the ⋯ button of the
 * row's actions, shown on hover and focus and always on a touch screen; a
 * pending row keeps it shown and disabled.
 */
function Row({
  glyph,
  title,
  times = [],
  to,
  state,
  tone,
  dimmed,
  actions = [],
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
  actions?: RowAction[];
  /** An action is under way: the menu stays shown and takes no other. */
  pending?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("chat");
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
            // menu sits above it.
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
      {actions.length > 0 ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("concierge.taskList.actions.more", { title })}
              disabled={pending}
              className={cn(
                "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-6 text-muted-foreground outline-none transition-[opacity,color,background-color] hover:bg-surface-active hover:text-foreground focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-ring/50 disabled:pointer-events-none data-[state=open]:bg-surface-active data-[state=open]:text-foreground data-[state=open]:opacity-100",
                !pending &&
                  "touch-show opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100",
              )}
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" className="min-w-[160px]">
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.text}
                variant={action.destructive ? "destructive" : undefined}
                onSelect={action.onSelect}
              >
                {action.icon}
                {action.text}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

/** What a row is doing while its action is under way, as its line says it. */
type Pending = "stopping" | "cancelling" | "pausing" | "resuming" | "deleting" | "unfollowing";

/** What a task chat's line says: its status word, then the time that goes with it. */
function taskState(
  item: TaskListTaskItem,
  t: Translate,
  now: number,
  locale: string,
  pending: Pending | undefined,
): string {
  if (pending) return t(`concierge.taskList.pending.${pending}`);
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

const actionIcon = "size-3.5 shrink-0";

function TaskRow({
  item,
  now,
  pending,
  onStop,
  onNavigate,
}: {
  item: TaskListTaskItem;
  now: number;
  pending: Pending | undefined;
  onStop: () => void;
  onNavigate?: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const { task } = item;
  const status = taskStatusOfDto(task);
  // Stop only, on every task chat that has not ended: the row itself opens it.
  // A scheduled task's Stop ends its schedule too.
  const actions: RowAction[] =
    status.status === "ended"
      ? []
      : [
          {
            text: t("concierge.taskList.actions.stop"),
            icon: <Square className={actionIcon} aria-hidden />,
            onSelect: onStop,
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
      actions={actions}
      pending={pending !== undefined}
      onNavigate={onNavigate}
    />
  );
}

function CheckRow({
  item,
  now,
  pending,
  onCancel,
}: {
  item: TaskListCheckItem;
  now: number;
  pending: Pending | undefined;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const { check } = item;
  const when = check.at === null ? null : formatTaskTime(check.at, now, i18n.language);
  return (
    <Row
      glyph={<Clock className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={check.name}
      state={
        pending
          ? t(`concierge.taskList.pending.${pending}`)
          : check.waitingFor
            ? stateLine(t("concierge.taskList.check.waiting", { what: check.waitingFor }), when)
            : when
              ? t("concierge.taskList.task.checksIn", { when })
              : ""
      }
      actions={[
        {
          text: t("concierge.taskList.actions.cancel"),
          icon: <X className={actionIcon} aria-hidden />,
          onSelect: onCancel,
        },
      ]}
      pending={pending !== undefined}
    />
  );
}

/** "18:00": the time of day of `at`, as the locale writes it. */
const clockOf = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(at));

function FollowRow({
  item,
  pending,
  onUnfollow,
}: {
  item: TaskListFollowItem;
  pending: Pending | undefined;
  onUnfollow: () => void;
}) {
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
      state={
        pending
          ? t(`concierge.taskList.pending.${pending}`)
          : stateLine(
              connectorOf(connectors, item.source)?.label ?? item.label,
              state === "unavailable"
                ? t("concierge.taskList.follow.unavailable")
                : state === "off" && t("concierge.taskList.follow.off"),
              digest,
              item.nextAt != null &&
                t("concierge.taskList.follow.next", { when: clockOf(item.nextAt, i18n.language) }),
            )
      }
      dimmed={state !== "active"}
      actions={[
        {
          text: t("concierge.taskList.actions.unfollow"),
          icon: <X className={actionIcon} aria-hidden />,
          onSelect: onUnfollow,
        },
      ]}
      pending={pending !== undefined}
    />
  );
}

function RoutineRow({
  item,
  now,
  pending,
  onToggle,
  onDelete,
}: {
  item: TaskListRoutineItem;
  now: number;
  pending: Pending | undefined;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const failed = item.lastRun?.status === "error";
  return (
    <Row
      glyph={<Workflow className="size-4 shrink-0 text-subtle-foreground" aria-hidden />}
      title={item.name}
      state={
        pending
          ? t(`concierge.taskList.pending.${pending}`)
          : stateLine(
              describeRoutineTrigger(item.trigger, t, i18n.language),
              !item.enabled && t("concierge.taskList.routine.paused"),
              item.nextRunAt !== null && formatTaskTime(item.nextRunAt, now, i18n.language),
              failed && t("concierge.taskList.routine.lastFailed"),
              item.fromTask &&
                t("concierge.taskList.routine.fromTask", { title: item.fromTask.title }),
            )
      }
      tone={failed && !pending ? "destructive" : undefined}
      dimmed={!item.enabled}
      actions={[
        item.enabled
          ? {
              text: t("concierge.taskList.actions.pause"),
              icon: <Pause className={actionIcon} aria-hidden />,
              onSelect: onToggle,
            }
          : {
              text: t("concierge.taskList.actions.resume"),
              icon: <Play className={actionIcon} aria-hidden />,
              onSelect: onToggle,
            },
        {
          text: t("concierge.taskList.actions.delete"),
          icon: <Trash2 className={actionIcon} aria-hidden />,
          destructive: true,
          onSelect: onDelete,
        },
      ]}
      pending={pending !== undefined}
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
 * A Concierge chat's task list: one list of groups, Needs you, Active, Later,
 * Scheduled and Ended, each a titled card of rows, with an empty group left
 * out. Ended starts folded and shows the newest rows first. Each row's ⋯
 * menu holds its few actions; Delete asks first, and the rest apply at once
 * and show pending until the list reads again. It reads again whenever the
 * server says something in it changed.
 */
export function TaskList({ chatId, onNavigate }: { chatId: string; onNavigate?: () => void }) {
  const { t } = useTranslation("chat");
  const [endedOpen, setEndedOpen] = useState(false);
  // Older ended rows "Show more" read, past the first page, and the next page's cursor.
  const [older, setOlder] = useState<{ items: TaskListItem[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // The rows whose action is under way, by their key.
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
  // The routine whose Delete waits for its confirmation.
  const [deleting, setDeleting] = useState<TaskListRoutineItem | null>(null);
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
    if (!data || ![...pending.values()].includes("stopping")) return;
    const tasks = new Map(
      data.groups.flatMap((group) =>
        group.items.flatMap((item) =>
          item.kind === "task" ? [[itemKey(item), item] as const] : [],
        ),
      ),
    );
    const left = new Map(
      [...pending].filter(([key, what]) => {
        if (what !== "stopping") return true;
        const item = tasks.get(key);
        return item !== undefined && taskStatusOfDto(item.task).status !== "ended";
      }),
    );
    if (left.size !== pending.size) setPending(left);
  }, [data, pending]);

  const settle = (key: string) =>
    setPending((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  /**
   * Runs one row action: the row shows `what` at once, and lets go once the
   * list read after it is in, or at once when it fails. A Stop lets go only
   * when the task reads as ended.
   */
  const act = (
    item: TaskListItem,
    what: Pending,
    path: string,
    init: { method: "POST" | "DELETE"; json?: unknown },
    failed: string,
  ) => {
    const key = itemKey(item);
    setPending((current) => new Map(current).set(key, what));
    void fetchJson<unknown>(`${listUrl(chatId)}/${path}`, { ...init, fallback: failed }).then(
      async () => {
        await reread();
        if (what !== "stopping") settle(key);
      },
      (error: Error) => {
        settle(key);
        toast.error(error.message);
      },
    );
  };
  const stop = (item: TaskListTaskItem) =>
    act(
      item,
      "stopping",
      `${encodeURIComponent(item.task.id)}/stop`,
      { method: "POST" },
      t("concierge.taskList.failed.stop"),
    );
  const cancel = (item: TaskListCheckItem) =>
    act(
      item,
      "cancelling",
      `checks/${encodeURIComponent(item.check.id)}/cancel`,
      { method: "POST" },
      t("concierge.taskList.failed.cancel"),
    );
  const unfollow = (item: TaskListFollowItem) =>
    act(
      item,
      "unfollowing",
      "follows/unfollow",
      { method: "POST", json: { source: item.source, target: item.target } },
      t("concierge.taskList.failed.unfollow"),
    );
  const toggle = (item: TaskListRoutineItem) =>
    act(
      item,
      item.enabled ? "pausing" : "resuming",
      `routines/${encodeURIComponent(item.id)}/${item.enabled ? "pause" : "resume"}`,
      { method: "POST" },
      t(item.enabled ? "concierge.taskList.failed.pause" : "concierge.taskList.failed.resume"),
    );
  const remove = (item: TaskListRoutineItem) =>
    act(
      item,
      "deleting",
      `routines/${encodeURIComponent(item.id)}`,
      { method: "DELETE" },
      t("concierge.taskList.failed.delete"),
    );

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
    fetchJson<TaskListResponse>(readUrl(chatId, cursor), {
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
    const key = itemKey(item);
    switch (item.kind) {
      case "task":
        return (
          <TaskRow
            key={key}
            item={item}
            now={now}
            pending={pending.get(key)}
            onStop={() => stop(item)}
            onNavigate={onNavigate}
          />
        );
      case "check":
        return (
          <CheckRow
            key={key}
            item={item}
            now={now}
            pending={pending.get(key)}
            onCancel={() => cancel(item)}
          />
        );
      case "follow":
        return (
          <FollowRow
            key={key}
            item={item}
            pending={pending.get(key)}
            onUnfollow={() => unfollow(item)}
          />
        );
      case "routine":
        return (
          <RoutineRow
            key={key}
            item={item}
            now={now}
            pending={pending.get(key)}
            onToggle={() => toggle(item)}
            onDelete={() => setDeleting(item)}
          />
        );
    }
  };

  return (
    <TooltipProvider delayDuration={500}>
      {data.groups.length === 0 ? (
        <p className="px-4 py-6 text-center text-ui text-muted-foreground">
          {t("concierge.taskList.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-5 px-4 pb-6 pt-4">
          {data.groups.map((group) => {
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
      <RomeConfirmDialog
        open={deleting !== null}
        destructive
        title={t("concierge.taskList.deleteRoutine.title", { name: deleting?.name ?? "" })}
        description={t("concierge.taskList.deleteRoutine.description")}
        confirmLabel={t("concierge.taskList.actions.delete")}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const item = deleting;
          setDeleting(null);
          if (item) remove(item);
        }}
      />
    </TooltipProvider>
  );
}
