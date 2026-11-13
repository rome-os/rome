import {
  AlarmClockOff,
  Archive,
  Check,
  ChevronDown,
  ListChecks,
  MessageSquare,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { ConciergeTaskAction, ConciergeTaskDto } from "@rome/api-types/concierge";
import {
  type ConciergeTaskStatusResult,
  taskStatusOfDto,
} from "@rome/api-types/concierge-task-status";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { useActiveSessionId } from "@/hooks/use-active-session-id";
import { useConciergeName } from "@/hooks/use-concierge";
import { cn } from "@/lib/utils";
import { inputsSettledSchema, settlePresses } from "./check-presses";
import { chatStatusTopic, useLiveEvents } from "@/hooks/use-live-events";
import { requestConciergeJump } from "./concierge-jump";
import { doneMessage, pressText, sendTaskAction, stopTask } from "./send-task-action";
import { StopGlyph } from "./StopGlyph";
import { TaskGlyph } from "./TaskGlyph";
import { formatTaskTime, groupTasks, taskTime, tasksOfChat, type TaskGroupKey } from "./tasks";
import { type PendingAction, settlePending, usePendingActions } from "./task-pending";
import { useConciergeTasks } from "./use-concierge-tasks";

/** What a row's button does: a press the Concierge hears, or cancelling its checks. */
type RowAction = ConciergeTaskAction | "cancelCheck";

/**
 * The action a row offers: Stop on an active row with a chat, Done on one
 * that needs the guardian, Archive on an ended one, and Cancel check on a
 * later one waiting on a check.
 */
function rowAction(task: ConciergeTaskDto, status: ConciergeTaskStatusResult): RowAction | null {
  if (status.status === "active" && task.chat) return "stop";
  if (status.status === "needs_you") return "done";
  if (status.status === "ended") return "archive";
  if (status.status === "later" && task.laterAt != null) return "cancelCheck";
  return null;
}

/** Cancels task `task`'s pending checks; the task stays, read again without them. */
async function cancelTaskChecks(task: Pick<ConciergeTaskDto, "id">, failed: string) {
  try {
    const response = await fetch(`/api/concierge/tasks/${encodeURIComponent(task.id)}/checks`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) toast.error(failed);
  } catch {
    toast.error(failed);
  }
}

function TaskRow({
  task,
  rows,
  pending,
  now,
  onNavigate,
}: {
  task: ConciergeTaskDto;
  rows: readonly ConciergeTaskDto[];
  pending: PendingAction | undefined;
  now: number;
  onNavigate?: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const name = useConciergeName();
  const taskStatus = taskStatusOfDto(task);
  const action = rowAction(task, taskStatus);
  const finished = taskStatus.status === "ended";
  // An ended task that did not finish says why, ahead of the Concierge's words.
  const ended =
    taskStatus.endReason && taskStatus.endReason !== "done"
      ? t(`concierge.tasks.ended.${taskStatus.endReason}`)
      : null;
  const detail = [ended, task.summary].filter(Boolean).join(" · ");
  // One quiet line under the title: what a press did so far, else the Concierge's own words.
  const status = pending
    ? pending.phase === "pending"
      ? t(`concierge.tasks.pending.${pending.action}`)
      : t(`concierge.tasks.${pending.phase}`, { name })
    : [detail, task.notSynced ? t("concierge.tasks.notSynced") : null].filter(Boolean).join(" · ");
  const at = taskTime(task);
  const retry = pending !== undefined && pending.phase !== "pending";
  const press = (kind: RowAction) => {
    if (kind === "cancelCheck") {
      // Only its checks go: the task stays, and Rome reads its status again.
      void cancelTaskChecks(task, t("checks.cancelFailed"));
    } else if (kind === "stop") {
      // A stop needs no turn of the Concierge: Rome stops the task at once.
      void stopTask(task);
    } else if (kind === "done") {
      const { text, replyToMessageId } = doneMessage(t, task, rows);
      void sendTaskAction(task, kind, text, replyToMessageId);
    } else {
      void sendTaskAction(task, kind, pressText(t, kind, task, rows));
    }
  };
  // Closes the mobile sheet first, so the transcript behind it is what scrolls into view.
  const jump = () => {
    if (!task.sourceMessageId) {
      toast.error(t("concierge.tasks.sourceMissing"));
      return;
    }
    onNavigate?.();
    requestConciergeJump(task.sourceMessageId);
  };
  const label = retry ? t("concierge.tasks.retry") : action ? t(`concierge.tasks.${action}`) : "";
  const shown = retry || (action !== null && pending === undefined);
  return (
    <ListRow
      asChild
      size="md"
      className="group/row relative transition-colors hover:bg-surface-hover"
    >
      <li data-task-id={task.id} data-task-status={taskStatus.status}>
        <TaskGlyph status={taskStatus} />
        <ListRowContent>
          <button
            type="button"
            onClick={jump}
            // A button sizes to its content even as a block, so without the
            // full width a long title pushes the row past the panel's edge.
            className="block w-full min-w-0 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-1 focus-visible:after:-outline-offset-1 focus-visible:after:outline-solid focus-visible:after:outline-ring/50"
          >
            <TitleText task={task} finished={finished} />
          </button>
          {status ? (
            <ListRowDescription className="truncate" role={pending ? "status" : undefined}>
              {status}
            </ListRowDescription>
          ) : null}
        </ListRowContent>
        {task.chat ? (
          <Button
            asChild
            variant="ghost"
            size="icon-xs"
            className="relative z-10 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Link
              to={`/chat/${task.chat.id}`}
              onClick={onNavigate}
              aria-label={t("concierge.tasks.openChat", { title: task.title })}
              title={t("concierge.tasks.openChat", { title: task.title })}
            >
              <MessageSquare />
            </Link>
          </Button>
        ) : null}
        {at !== null || shown ? (
          <span className="relative z-10 grid shrink-0 items-center justify-items-end">
            {at !== null ? (
              <span
                className={cn(
                  "col-start-1 row-start-1 text-aux tabular-nums text-subtle-foreground",
                  // Where an action takes this place, the time yields to it.
                  shown &&
                    "transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0",
                  shown && retry === false && "[@media(hover:none)]:opacity-0",
                )}
              >
                {formatTaskTime(at, now, i18n.language)}
              </span>
            ) : null}
            {shown ? (
              <IconButton
                size="xs"
                label={label}
                onClick={() => press(retry ? (pending?.action ?? "stop") : (action ?? "stop"))}
                className={cn(
                  "col-start-1 row-start-1 text-muted-foreground hover:text-foreground",
                  !retry &&
                    "touch-show opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
                )}
                icon={
                  retry ? (
                    <RotateCcw />
                  ) : action === "stop" ? (
                    <StopGlyph />
                  ) : action === "done" ? (
                    <Check />
                  ) : action === "cancelCheck" ? (
                    <AlarmClockOff />
                  ) : (
                    <Archive />
                  )
                }
              />
            ) : null}
          </span>
        ) : null}
      </li>
    </ListRow>
  );
}

function TitleText({ task, finished }: { task: ConciergeTaskDto; finished: boolean }) {
  return (
    <ListRowTitle className={cn("truncate", finished && "text-muted-foreground")}>
      {task.title}
    </ListRowTitle>
  );
}

/**
 * The Concierge's task list: what waits for the guardian, what is at work,
 * what is checked later, and what ended. Read-only: a button sends the
 * Concierge a message, and the row changes when the Concierge writes it.
 */
export function ConciergeTaskPanel({
  chatId,
  onNavigate,
}: {
  /** The Concierge chat whose rows it lists; the open chat's when left out. */
  chatId?: string | null;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("chat");
  const name = useConciergeName();
  const activeSessionId = useActiveSessionId();
  const openChatId = chatId === undefined ? activeSessionId : chatId;
  // Finished work is history, so that group starts folded.
  const [folded, setFolded] = useState<ReadonlySet<TaskGroupKey>>(new Set(["ended"]));
  const [showAllDone, setShowAllDone] = useState(false);
  // Every finished row is loaded and the 7-day window is applied here, so the
  // panel knows how many older ones "Show older" holds.
  // Only the open Concierge chat's rows: each chat has its own list.
  const { tasks: allTasks, loaded } = useConciergeTasks({ allDone: true });
  const tasks = tasksOfChat(allTasks, openChatId);
  const pending = usePendingActions();

  // Rows the Concierge wrote settle their pending buttons, and a turn that took
  // a press in and ended without a write tells that button nothing changed.
  // The server says when that turn ended; the panel pages no chat for it.
  useLiveEvents(chatStatusTopic, {
    inputs_settled: { schema: inputsSettledSchema, fn: settlePresses },
  });
  useEffect(() => {
    for (const task of tasks) settlePending(task);
  }, [tasks]);

  const now = Date.now();
  const groups = groupTasks(tasks, { now, showAllDone });
  if (!loaded) return null;
  if (groups.length === 0) {
    return (
      <EmptyState className="h-full">
        <EmptyStateIcon>
          <ListChecks />
        </EmptyStateIcon>
        <EmptyStateTitle>{t("concierge.tasks.emptyTitle")}</EmptyStateTitle>
        <EmptyStateDescription>
          {t("concierge.tasks.emptyDescription", { name })}
        </EmptyStateDescription>
      </EmptyState>
    );
  }
  const toggle = (key: TaskGroupKey) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="flex h-full flex-col overflow-y-auto pb-safe">
      {groups.map((group) => {
        const open = !folded.has(group.key);
        return (
          <section key={group.key}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(group.key)}
              className="flex w-full items-center gap-1 px-3 pb-1 pt-4 text-left text-aux text-muted-foreground outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
            >
              <ChevronDown
                className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
                aria-hidden
              />
              <span>{t(`concierge.tasks.groups.${group.key}`)}</span>
              {/* A flex container draws no gap for the space; it keeps the name "Needs you 1". */}{" "}
              <span className="tabular-nums text-subtle-foreground">
                {group.tasks.length + group.hidden}
              </span>
            </button>
            {open ? (
              <List asChild>
                <ul>
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      rows={tasks}
                      pending={pending.get(task.id)}
                      now={now}
                      onNavigate={onNavigate}
                    />
                  ))}
                  {group.key === "ended" && (group.hidden > 0 || showAllDone) ? (
                    <li>
                      <ListRow
                        asChild
                        size="sm"
                        interactive
                        className="text-aux text-muted-foreground"
                      >
                        <button type="button" onClick={() => setShowAllDone((value) => !value)}>
                          <ChevronDown
                            className={cn("size-4 shrink-0", showAllDone && "rotate-180")}
                            aria-hidden
                          />
                          {showAllDone
                            ? t("concierge.tasks.showLess")
                            : t("concierge.tasks.showMore", { count: group.hidden })}
                        </button>
                      </ListRow>
                    </li>
                  ) : null}
                </ul>
              </List>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
