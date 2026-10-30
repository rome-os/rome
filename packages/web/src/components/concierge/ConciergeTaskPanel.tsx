import { Archive, ChevronDown, ListChecks, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ConciergeTaskAction, ConciergeTaskDto } from "@rome/api-types/concierge";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { cn } from "@/lib/utils";
import { checkPresses } from "./check-presses";
import { pressText, sendTaskAction } from "./send-task-action";
import { StopGlyph } from "./StopGlyph";
import { TaskGlyph } from "./TaskGlyph";
import { formatTaskTime, groupTasks, taskTime, type TaskGroupKey } from "./tasks";
import { type PendingAction, settlePending, usePendingActions } from "./task-pending";
import { useConciergeTasks } from "./use-concierge-tasks";

/** How often a pending press asks whether its turn has ended. */
const CHECK_PRESSES_MS = 2_000;

/** The action a row offers: Stop on a Doing row with a chat, Archive on a Done one. */
function rowAction(task: ConciergeTaskDto): ConciergeTaskAction | null {
  if (task.state === "doing" && task.chat) return "stop";
  if (task.state === "done" || task.state === "dropped") return "archive";
  return null;
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
  const action = rowAction(task);
  const finished = task.state === "done" || task.state === "dropped";
  const detail =
    task.state === "watching" || task.state === "needs_user"
      ? (task.waitingOn ?? task.summary)
      : task.summary;
  // One quiet line under the title: what a press did so far, else the Concierge's own words.
  const status = pending
    ? pending.phase === "pending"
      ? t(`concierge.tasks.pending.${pending.action}`)
      : t(`concierge.tasks.${pending.phase}`)
    : [detail, task.notSynced ? t("concierge.tasks.notSynced") : null].filter(Boolean).join(" · ");
  const at = taskTime(task);
  const retry = pending !== undefined && pending.phase !== "pending";
  const press = (kind: ConciergeTaskAction) =>
    void sendTaskAction(task, kind, pressText(t, kind, task, rows));
  const label = retry ? t("concierge.tasks.retry") : action ? t(`concierge.tasks.${action}`) : "";
  const shown = retry || (action !== null && pending === undefined);
  return (
    <ListRow
      asChild
      size="md"
      className={cn("group/row relative", task.chat && "transition-colors hover:bg-surface-hover")}
    >
      <li data-task-id={task.id} data-task-state={task.state}>
        <TaskGlyph state={task.state} />
        <ListRowContent>
          {task.chat ? (
            <Link
              to={`/chat/${task.chat.id}`}
              onClick={onNavigate}
              aria-label={t("concierge.tasks.openChat", { title: task.title })}
              className="block min-w-0 outline-none after:absolute after:inset-0 focus-visible:after:outline-1 focus-visible:after:-outline-offset-1 focus-visible:after:outline-solid focus-visible:after:outline-ring/50"
            >
              <TitleText task={task} finished={finished} />
            </Link>
          ) : (
            <TitleText task={task} finished={finished} />
          )}
          {status ? (
            <ListRowDescription className="truncate" role={pending ? "status" : undefined}>
              {status}
            </ListRowDescription>
          ) : null}
        </ListRowContent>
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
                icon={retry ? <RotateCcw /> : action === "stop" ? <StopGlyph /> : <Archive />}
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
 * The Concierge's task list: what needs the guardian, what it is doing, what is
 * next, what it is watching, and what it finished. Read-only: a button sends the
 * Concierge a message, and the row changes when the Concierge writes it.
 */
export function ConciergeTaskPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation("chat");
  // Finished work is history, so that group starts folded.
  const [folded, setFolded] = useState<ReadonlySet<TaskGroupKey>>(new Set(["done"]));
  const [showAllDone, setShowAllDone] = useState(false);
  // Every finished row is loaded and the 7-day window is applied here, so the
  // panel knows how many older ones "Show older" holds.
  const { tasks, loaded } = useConciergeTasks({ allDone: true });
  const pending = usePendingActions();

  // Rows the Concierge wrote settle their pending buttons, and a turn that took
  // a press in and ended without a write tells that button nothing changed.
  const waiting = [...pending.values()].some((press) => press.phase === "pending");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void checkPresses().catch(() => {}), CHECK_PRESSES_MS);
    return () => clearInterval(timer);
  }, [waiting]);
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
        <EmptyStateDescription>{t("concierge.tasks.emptyDescription")}</EmptyStateDescription>
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
                  {group.key === "done" && (group.hidden > 0 || showAllDone) ? (
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
