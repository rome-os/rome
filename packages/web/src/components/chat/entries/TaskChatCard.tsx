import { ChatBubbleIcon } from "@radix-ui/react-icons";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { taskStatusOfDto } from "@rome/api-types/concierge-task-status";
import { toast } from "sonner";
import { stopTask } from "@/components/concierge/send-task-action";
import { useConciergeTasks } from "@/components/concierge/use-concierge-tasks";
import { Button } from "@/components/ui/button";
import { postWidgetEventTurn, widgetAnswerOutput } from "@/lib/chat-api";
import type { ApprovalCardStatus } from "@/lib/chat-types";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import type { TaskApprovalOutcome, TaskCard } from "@rome/api-types/chat";
import { ApprovalCard } from "../approval/ApprovalCard";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { chatStatusTopic, useLiveEvents } from "@/hooks/use-live-events";
import { isOpenWait } from "./live-task-cards";
import { QuestionCard } from "./QuestionCard";
import { answerOutcome, approvalOutcome, SettledCard } from "./SettledCard";

const sessionRunningSchema = z.object({ sessionId: z.string(), running: z.boolean() });

type TaskStatus = "running" | "waiting" | "failed" | "idle";

/**
 * Whether the card is read where no one is signed in, such as a shared chat's
 * public page. There a task chat shows as a fixed label: its status, its link
 * and its waiting card all read the signed-in API.
 */
export const PublicTaskChatContext = createContext(false);

/**
 * A task chat another agent started on the guardian's behalf. `show` is what
 * the card is: `task`, the task card (its title, live status, Stop and a link
 * that opens it), or `ask`, the task's question or approval alone under a
 * header that opens the task chat. A card from before has none, and shows the
 * task card with its waiting question or approval inside. On a public page,
 * its title alone.
 */
export function TaskChatCard(props: {
  chatId: string;
  title: string;
  isLatestForChat: boolean;
  show?: "task" | "ask";
  /** What the card shows and how it ended, as Rome filled it in when it handed the message out. */
  card?: TaskCard;
}) {
  const { show, ...rest } = props;
  if (useContext(PublicTaskChatContext)) return <StaticTaskChatCard title={props.title} />;
  if (show === "ask") return <TaskAskCard {...rest} />;
  return <LiveTaskChatCard {...rest} embedWait={show === undefined} />;
}

type AskedCard = Exclude<TaskCard, { kind: "unavailable" }>;

/**
 * Whether the task waits on its owner for this card now: it is the chat's
 * newest card for the task, it has no outcome yet, and the task names it as
 * its open wait. Once the list has loaded, a card whose task it does not hold
 * waits on no one.
 */
function waitsOn(
  card: TaskCard | undefined,
  task: ConciergeTaskDto | undefined,
  loaded: boolean,
): card is AskedCard {
  if (!card || card.kind === "unavailable" || card.outcome) return false;
  // Until the list loads, an open card is taken to wait, so it does not flash folded.
  if (!task) return !loaded;
  return isOpenWait(task.openWait, card);
}

/**
 * A task's question or approval, shown in the Concierge chat on its own. The
 * label under its message names the task. Once answered, decided or turned
 * down, or superseded by a later one, it folds to a small card: what it
 * asked, then how it ended, opening to the original read-only. An expired
 * question folds to one quiet line that opens to the form, and counts as
 * waiting nowhere until it is opened.
 */
function TaskAskCard({
  chatId,
  isLatestForChat,
  card,
}: {
  chatId: string;
  title: string;
  isLatestForChat: boolean;
  card?: TaskCard;
}) {
  const { t } = useTranslation("chat");
  const { invalidate } = useChatSessions("all", "all");
  // The whole list: a card or thread outlives the panel's window of recent ended tasks.
  const { tasks, loaded, reload } = useConciergeTasks({ allDone: true });
  const refresh = async () => {
    await Promise.all([invalidate(), reload()]);
  };
  const [open, setOpen] = useState(false);
  if (!card || card.kind === "unavailable") {
    return <p className="text-aux text-muted-foreground">{t("concierge.ask.unavailable")}</p>;
  }
  const task = tasks.find((candidate) => candidate.chat?.id === chatId);
  const waiting = isLatestForChat && waitsOn(card, task, loaded);
  const expired = card.kind === "question" && card.expired && !card.outcome;
  if (expired && waiting && !open)
    return <ExpiredAskCard card={card} onOpen={() => setOpen(true)} />;
  if (waiting) {
    return (
      // As wide as a received chat bubble can be (`ChatBubble`'s cap).
      <div className="flex w-full min-w-0 max-w-[min(100%,var(--container-2xl))] flex-col">
        <WaitingTaskCard
          key={chatId}
          chatId={chatId}
          card={card}
          onRefresh={refresh}
          // An expired question opened again takes an answer, yet waits on no one.
          countsAsWaiting={!expired}
          header={
            expired ? (
              <p className="text-aux text-muted-foreground">{t("concierge.tasks.expired")}</p>
            ) : undefined
          }
        />
      </div>
    );
  }
  return <FoldedAskCard card={card} />;
}

/**
 * An expired question, folded to a card: what it asked, then that it expired
 * and takes an answer still. A click opens the form.
 */
function ExpiredAskCard({ card, onOpen }: { card: AskedCard; onOpen: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <SettledCard
      title={titleOf(card)}
      outcome={t("concierge.ask.expiredFold")}
      onOpen={onOpen}
      chevron
    />
  );
}

/** What a card asked, for its folded line: its first question, or what the approval asks. */
function titleOf(card: AskedCard): string | null {
  if (card.kind === "approval") return card.title;
  const question = (card.render?.props?.questions as { question?: unknown }[] | undefined)?.[0]
    ?.question;
  return typeof question === "string" ? question : null;
}

/** An approval's outcome as the status and resolver its folded copy reads. */
function decided(outcome: TaskApprovalOutcome): { status: string; resolvedBy: string | null } {
  if (outcome.kind === "approved") return { status: "approved", resolvedBy: null };
  if (outcome.kind === "rejected") return { status: "rejected", resolvedBy: null };
  return {
    status: "rejected",
    resolvedBy: outcome.reason === "no_response" ? "rome:task-ended" : "rome:task-stopped",
  };
}

/** The preview an approval card draws, when its approval has one it understands. */
const previewSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("generic"),
      title: z.string(),
      summary: z.string(),
      fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    }),
    z.object({
      kind: z.literal("sensitive_message"),
      channel: z.string(),
      threadId: z.string(),
      text: z.string(),
      reason: z.string().optional(),
    }),
  ])
  .optional()
  .catch(undefined);

function previewOf(card: Extract<AskedCard, { kind: "approval" }>) {
  return (
    previewSchema.parse(card.preview) ?? {
      kind: "generic" as const,
      title: card.title,
      summary: "",
    }
  );
}

/**
 * A task's question or approval that is no longer open: what it asked, then
 * how it ended (the answer, or that it was dismissed; an approval approved,
 * rejected, or turned down by Rome when the wait ran out or the task was
 * stopped; or still waiting on a newer copy below). It opens to the
 * original, read-only.
 */
function FoldedAskCard({ card }: { card: AskedCard }) {
  const { t } = useTranslation("chat");
  let outcome: string;
  if (!card.outcome) outcome = t("concierge.ask.waitingBelow");
  else if (card.kind === "approval") {
    const { status, resolvedBy } = decided(card.outcome);
    outcome = approvalOutcome(t, status, resolvedBy);
  } else {
    outcome = answerOutcome(
      t,
      card.outcome.kind === "dismissed" ? { dismissed: true } : card.outcome.answer.output,
    );
  }
  return (
    <SettledCard
      title={titleOf(card)}
      outcome={outcome}
      full={
        card.kind === "approval" ? (
          <ApprovalCard
            approvalId={card.id}
            actionName={card.actionName}
            preview={previewOf(card)}
            status={(card.outcome ? decided(card.outcome).status : "pending") as ApprovalCardStatus}
            onResolved={() => {}}
            settled="full"
          />
        ) : card.outcome && card.render?.componentId === "question-card" ? (
          <QuestionCard
            widgetId={card.messageId}
            toolUseId={card.id}
            appId="core"
            ui={card.render.ui}
            props={card.render.props}
            result={
              card.outcome.kind === "answered" ? card.outcome.answer.output : { dismissed: true }
            }
            onAnswer={() => {}}
            settled="full"
          />
        ) : undefined
      }
    />
  );
}

function StaticTaskChatCard({ title }: { title: string }) {
  const { t } = useTranslation("chat");
  return (
    <div className="w-full min-w-0 max-w-md rounded-16 border border-border bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <ChatBubbleIcon className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-foreground">{title}</span>
          <span className="text-aux text-muted-foreground">{t("concierge.taskChat")}</span>
        </div>
      </div>
    </div>
  );
}

/** The card's word for each open status, by its key under `concierge.taskStatus`. */
const DERIVED_LABEL = {
  needs_you: "waiting",
  active: "running",
  later: "later",
} as const;

function LiveTaskChatCard({
  chatId,
  title,
  isLatestForChat,
  embedWait,
  card,
}: {
  chatId: string;
  title: string;
  isLatestForChat: boolean;
  /** A card from before the question showed on its own carries it inside. */
  embedWait: boolean;
  card?: TaskCard;
}) {
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
  // The card says what the task list says: its task's status, when it has one.
  // The whole list: a card or thread outlives the panel's window of recent ended tasks.
  const { tasks, loaded, reload } = useConciergeTasks({ allDone: true });
  const refresh = async () => {
    await Promise.all([invalidate(), reload()]);
  };
  const task = tasks.find((candidate) => candidate.chat?.id === chatId);
  const derived = task ? taskStatusOfDto(task) : null;
  // An archived task chat's task was stopped with it, and the list holds no
  // archived row to read it from.
  const label =
    !derived && session?.archivedAt
      ? t("concierge.tasks.ended.stopped")
      : derived
        ? derived.status === "ended"
          ? derived.endReason === "done"
            ? t("concierge.taskStatus.idle")
            : t(`concierge.tasks.ended.${derived.endReason}`)
          : t(`concierge.taskStatus.${DERIVED_LABEL[derived.status]}`)
        : t(`concierge.taskStatus.${status}`);
  return (
    // One line keeps the compact cap. While a card from before holds its
    // question or approval (`data-chat-task-open`) it is as wide as a message.
    <div className="w-full min-w-0 max-w-md space-y-3 rounded-16 border border-border bg-surface px-3 py-2 has-[[data-chat-task-open]]:max-w-[min(100%,var(--container-2xl))]">
      <div className="flex min-w-0 items-center gap-3">
        <ChatBubbleIcon className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-foreground">{session?.name ?? title}</span>
          <span className="text-aux text-muted-foreground">
            {t("concierge.taskChat")} · {label}
          </span>
        </div>
        {task && derived && derived.status !== "ended" ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() =>
              void stopTask(task).then((ok) => {
                if (!ok) toast.error(t("concierge.taskList.failed.stop"));
              })
            }
          >
            {t("concierge.tasks.stop")}
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to={`/chat/${chatId}`}>{t("concierge.openTaskChat")}</Link>
        </Button>
      </div>
      {embedWait && isLatestForChat && !running && waitsOn(card, task, loaded) ? (
        <>
          {card.kind === "question" && card.expired ? (
            // The wait ran out and the task ended, yet its card still takes an answer.
            <p className="text-aux text-muted-foreground">{t("concierge.tasks.expired")}</p>
          ) : null}
          <WaitingTaskCard key={chatId} chatId={chatId} card={card} onRefresh={refresh} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The question or approval a task waits on its owner for, drawn from the card
 * Rome filled in, answerable here.
 */
function WaitingTaskCard({
  chatId,
  card,
  onRefresh,
  header,
  countsAsWaiting = true,
}: {
  chatId: string;
  card: AskedCard;
  onRefresh: () => Promise<void>;
  /** Shown at the top inside the question or approval card. */
  header?: ReactNode;
  /** Whether the "Needs you" jump counts it; an expired question does not. */
  countsAsWaiting?: boolean;
}) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const [submitted, setSubmitted] = useState<{
    key: string;
    output: Record<string, unknown>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const interaction =
    card.kind === "question"
      ? {
          part: { toolUseId: card.id, render: card.render ?? undefined },
          key: `${card.messageId}:${card.id}`,
          messageId: card.messageId,
        }
      : undefined;
  const approval = card.kind === "approval" ? card : undefined;

  async function refresh() {
    await onRefresh();
  }

  async function answer(widgetId: string, name: string, context: Record<string, unknown>) {
    if (!interaction || submitted?.key === interaction.key) return;
    setSubmitted({ key: interaction.key, output: widgetAnswerOutput(name, context) });
    setError(null);
    try {
      // This turn belongs to the task, never to the main Chat's stream state.
      const result = await postWidgetEventTurn(widgetId, { name, context });
      if (!result.ok) {
        setError(
          result.status === 400
            ? t("concierge.taskCardAlreadyAnswered")
            : result.message || t("stream.errors.sendFallback"),
        );
        setSubmitted(null);
        setAttempt((value) => value + 1);
      }
    } catch {
      setError(t("stream.errors.sendFallback"));
      setSubmitted(null);
      setAttempt((value) => value + 1);
    }
    await refresh();
  }

  const approvalCard = !!approval;
  const questionCard =
    !approvalCard &&
    !!interaction?.part.render?.builtin &&
    interaction.part.render.componentId === "question-card";
  return (
    <div
      data-chat-task-waiting={countsAsWaiting ? chatId : undefined}
      data-chat-task-open={approvalCard || questionCard ? "" : undefined}
      className="min-w-0 wrap-anywhere"
    >
      {error && (
        <p role="status" className="mb-2 text-aux text-muted-foreground">
          {error}
        </p>
      )}
      {approval ? (
        <ApprovalCard
          key={approval.id}
          approvalId={approval.id}
          actionName={approval.actionName}
          preview={previewOf(approval)}
          status="pending"
          header={header}
          onResolved={() => {
            void refresh();
          }}
        />
      ) : interaction &&
        !(
          interaction.part.render?.builtin &&
          interaction.part.render.componentId === "question-card"
        ) ? (
        // An app's own card, such as a sign-in, is answered in its task chat.
        <SettledCard
          title={null}
          outcome={t("concierge.ask.openToAnswer")}
          onOpen={() => navigate(`/chat/${chatId}`)}
          chevron
        />
      ) : interaction?.part.render?.builtin &&
        interaction.part.render.componentId === "question-card" ? (
        <QuestionCard
          widgetId={interaction.messageId}
          key={`${interaction.key}:${attempt}`}
          toolUseId={interaction.part.toolUseId}
          appId="core"
          ui={interaction.part.render.ui}
          props={interaction.part.render.props}
          result={submitted?.key === interaction.key ? submitted.output : undefined}
          onAnswer={(widgetId, _toolUseId, name, context) => {
            void answer(widgetId, name, context);
          }}
          header={header}
        />
      ) : null}
    </div>
  );
}
