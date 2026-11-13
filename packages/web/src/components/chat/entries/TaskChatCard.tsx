import { ChatBubbleIcon } from "@radix-ui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { taskStatusOfDto } from "@rome/api-types/concierge-task-status";
import { stopTask } from "@/components/concierge/send-task-action";
import { useConciergeTasks } from "@/components/concierge/use-concierge-tasks";
import { Button } from "@/components/ui/button";
import { useApprovals } from "@/hooks/use-approvals";
import { listSessionMessagePage, postSessionTurnJson } from "@/lib/chat-api";
import type { ApprovalCardStatus, ChatMessage } from "@/lib/chat-types";
import type { ConciergeOpenWait } from "@rome/api-types/concierge";
import { ApprovalCard } from "../approval/ApprovalCard";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { chatStatusTopic, useLiveEvents } from "@/hooks/use-live-events";
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
  /** When the message holding the card was said, as an ISO time. */
  shownAt?: string;
}) {
  const { show, shownAt, ...card } = props;
  if (useContext(PublicTaskChatContext)) return <StaticTaskChatCard title={props.title} />;
  if (show === "ask") return <TaskAskCard {...card} shownAt={shownAt} />;
  return <LiveTaskChatCard {...card} embedWait={show === undefined} />;
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
  shownAt,
}: {
  chatId: string;
  title: string;
  isLatestForChat: boolean;
  shownAt?: string;
}) {
  const { t } = useTranslation("chat");
  const { sessions, invalidate } = useChatSessions("all", "all");
  // The whole list: a card or thread outlives the panel's window of recent ended tasks.
  const { tasks, reload } = useConciergeTasks({ allDone: true });
  const refresh = async () => {
    await Promise.all([invalidate(), reload()]);
  };
  const [open, setOpen] = useState(false);
  const session = sessions?.find((candidate) => candidate.id === chatId);
  const task = tasks.find((candidate) => candidate.chat?.id === chatId);
  const derived = task ? taskStatusOfDto(task) : null;
  const wait = isLatestForChat ? (task?.openWait ?? null) : null;
  const expired = wait !== null && derived?.endReason === "no_response";
  if (expired && !open) return <ExpiredAskCard wait={wait} onOpen={() => setOpen(true)} />;
  if (wait) {
    return (
      // As wide as a received chat bubble can be (`ChatBubble`'s cap).
      <div className="flex w-full min-w-0 max-w-[min(100%,var(--container-2xl))] flex-col">
        <WaitingTaskCard
          key={chatId}
          chatId={chatId}
          wait={wait}
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
  if (!session) return null;
  return <FoldedAskCard chatId={chatId} shownAt={shownAt} />;
}

/**
 * An expired question, folded to a card: what it asked, then that it expired
 * and takes an answer still. A click opens the form.
 */
function ExpiredAskCard({ wait, onOpen }: { wait: ConciergeOpenWait; onOpen: () => void }) {
  const { t } = useTranslation("chat");
  const props = wait.kind === "card" ? wait.render?.props : undefined;
  const question = (props?.questions as { question?: unknown }[] | undefined)?.[0]?.question;
  return (
    <SettledCard
      title={typeof question === "string" ? question : null}
      outcome={t("concierge.ask.expiredFold")}
      onOpen={onOpen}
      chevron
    />
  );
}

/** Pages of a chat's messages fetched at most, going back to a card's time. */
const PAGES_BACK = 5;

/**
 * Task chat `chatId`'s messages from now back to `until` and a little
 * before, so the question open then and every answer since are in it. The
 * newest page alone when `until` is not set.
 */
async function messagesBack(chatId: string, until: number): Promise<ChatMessage[]> {
  // Pages hold whole turns; two cover the newest question.
  if (!Number.isFinite(until)) {
    return (await listSessionMessagePage(chatId, { limit: 2 }))?.messages ?? [];
  }
  const out: ChatMessage[] = [];
  let before: string | null = null;
  let crossed = false;
  for (let page = 0; page < PAGES_BACK; page += 1) {
    const got = await listSessionMessagePage(chatId, { limit: 2, before });
    if (!got) break;
    out.unshift(...got.messages);
    const oldest = got.messages[0];
    // One page past the card's time holds the question it showed.
    if (crossed || !got.nextCursor || !oldest) break;
    crossed = Date.parse(oldest.createdAt) <= until;
    before = got.nextCursor;
  }
  return out;
}

const resultSchema = z.object({
  type: z.literal("interaction_result"),
  toolUseId: z.string(),
  output: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A task's question or approval that is no longer open: what it asked, then
 * how it ended (the answer, or that it was dismissed; an approval approved,
 * rejected, or turned down by Rome when the wait ran out; or still waiting
 * on a newer copy below). It opens to the original, read-only.
 */
function FoldedAskCard({ chatId, shownAt }: { chatId: string; shownAt?: string }) {
  const { t } = useTranslation("chat");
  // The card shows the wait that was open when it was said: the newest
  // question or approval that began by then, whatever the task asked later.
  // A card with no time shows the chat's newest.
  const until = shownAt ? Date.parse(shownAt) : Number.POSITIVE_INFINITY;
  const messages = useQuery({
    queryKey: ["task-chat-cards", chatId, shownAt ?? null],
    queryFn: () => messagesBack(chatId, until),
  });
  const approvals = useApprovals();
  const approval = (approvals.data ?? [])
    .flatMap((row) => {
      const payload = approvalPayloadSchema.safeParse(row.payload);
      return payload.success &&
        payload.data.channelContext.threadId === chatId &&
        Date.parse(row.createdAt) <= until
        ? [{ row, payload: payload.data }]
        : [];
    })
    .sort((a, b) => Date.parse(b.row.createdAt) - Date.parse(a.row.createdAt))[0];
  // The question it showed, and the answers given, by question.
  const answers = new Map<string, { at: string; output: Record<string, unknown> }>();
  let asked: { at: string; part: z.infer<typeof interactionSchema> } | null = null;
  for (const message of messages.data ?? []) {
    let parts: unknown;
    try {
      parts = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;
    for (const raw of parts) {
      const result = resultSchema.safeParse(raw);
      if (result.success) {
        answers.set(result.data.toolUseId, {
          at: message.createdAt,
          output: result.data.output ?? {},
        });
      }
      const interaction = interactionSchema.safeParse(raw);
      if (
        interaction.success &&
        interaction.data.type === "pending_interaction" &&
        Date.parse(message.createdAt) <= until &&
        (!asked || Date.parse(message.createdAt) >= Date.parse(asked.at))
      ) {
        asked = { at: message.createdAt, part: interaction.data };
      }
    }
  }
  const answer = asked ? (answers.get(asked.part.toolUseId) ?? null) : null;
  const approvalIsLatest =
    approval !== undefined &&
    (asked === null || Date.parse(approval.row.createdAt) > Date.parse(asked.at));
  const questionOpen = !approvalIsLatest && asked !== null && answer === null;
  const props = asked?.part.render?.props;
  const questionTitle = (props?.questions as { question?: unknown }[] | undefined)?.[0]?.question as
    | string
    | undefined;
  const title = approvalIsLatest
    ? approval.payload.preview?.kind === "generic"
      ? approval.payload.preview.title
      : approval.row.description
    : (questionTitle ?? null);
  let outcome: string;
  if ((approvalIsLatest && approval.row.status === "pending") || questionOpen) {
    outcome = t("concierge.ask.waitingBelow");
  } else if (approvalIsLatest) {
    outcome = approvalOutcome(t, approval.row.status, approval.row.resolvedBy);
  } else {
    outcome = answerOutcome(t, answer?.output ?? {});
  }
  return (
    <SettledCard
      title={title}
      outcome={outcome}
      full={
        approvalIsLatest ? (
          <ApprovalCard
            approvalId={approval.row.id}
            actionName={approval.payload.actionName}
            preview={
              approval.payload.preview ?? {
                kind: "generic",
                title: approval.row.description,
                summary: "",
              }
            }
            status={approval.row.status as ApprovalCardStatus}
            onResolved={() => {}}
            settled="full"
          />
        ) : !questionOpen && asked?.part.render?.componentId === "question-card" ? (
          <QuestionCard
            toolUseId={asked.part.toolUseId}
            props={props}
            result={answer ? answer.output : { dismissed: true }}
            onSubmit={() => {}}
            onDismiss={() => {}}
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
}: {
  chatId: string;
  title: string;
  isLatestForChat: boolean;
  /** A card from before the question showed on its own carries it inside. */
  embedWait: boolean;
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
  const { tasks, reload } = useConciergeTasks({ allDone: true });
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
            onClick={() => void stopTask(task)}
          >
            {t("concierge.tasks.stop")}
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to={`/chat/${chatId}`}>{t("concierge.openTaskChat")}</Link>
        </Button>
      </div>
      {embedWait &&
      isLatestForChat &&
      !running &&
      task?.openWait &&
      derived?.endReason === "no_response" ? (
        // The wait ran out and the task ended, yet its card still takes an answer.
        <p className="text-aux text-muted-foreground">{t("concierge.tasks.expired")}</p>
      ) : null}
      {embedWait && isLatestForChat && !running && task?.openWait && (
        <WaitingTaskCard key={chatId} chatId={chatId} wait={task.openWait} onRefresh={refresh} />
      )}
    </div>
  );
}

const interactionSchema = z.object({
  type: z.enum(["pending_interaction", "interaction_result"]),
  toolUseId: z.string(),
  render: z
    .object({
      builtin: z.boolean().optional(),
      componentId: z.string(),
      props: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

const approvalPayloadSchema = z.object({
  channelContext: z.object({ threadId: z.string() }),
  actionName: z.string().optional().catch(undefined),
  preview: z
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
    .catch(undefined),
});

/**
 * The card or approval a task waits on its owner for, as the server names it
 * in the task's `openWait`, so the card and the task's status follow one rule.
 */
function WaitingTaskCard({
  chatId,
  wait,
  onRefresh,
  header,
  countsAsWaiting = true,
}: {
  chatId: string;
  wait: ConciergeOpenWait;
  onRefresh: () => Promise<void>;
  /** Shown at the top inside the question or approval card. */
  header?: ReactNode;
  /** Whether the "Needs you" jump counts it; an expired question does not. */
  countsAsWaiting?: boolean;
}) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const approvals = useApprovals({ status: "pending" });
  const [submitted, setSubmitted] = useState<{
    key: string;
    output: Record<string, unknown>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const interaction =
    wait.kind === "card"
      ? {
          part: { toolUseId: wait.id, render: wait.render ?? undefined },
          key: `${wait.messageId}:${wait.id}`,
        }
      : undefined;
  const approval =
    wait.kind === "approval"
      ? (approvals.data ?? []).flatMap((row) => {
          const payload = approvalPayloadSchema.safeParse(row.payload);
          return row.id === wait.id && row.status === "pending" && payload.success
            ? [{ row, payload: payload.data }]
            : [];
        })[0]
      : undefined;

  async function refresh() {
    await Promise.all([approvals.refetch(), onRefresh()]);
  }

  async function submit(toolUseId: string, output: Record<string, unknown>) {
    if (!interaction || submitted?.key === interaction.key) return;
    setSubmitted({ key: interaction.key, output });
    setError(null);
    try {
      // This turn belongs to the task, never to the main Chat's stream state.
      const result = await postSessionTurnJson(chatId, {
        parts: [{ type: "interaction_result", toolUseId, output }],
      });
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
          key={approval.row.id}
          approvalId={approval.row.id}
          actionName={approval.payload.actionName}
          preview={
            approval.payload.preview ?? {
              kind: "generic",
              title: approval.row.description,
              summary: "",
            }
          }
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
          key={`${interaction.key}:${attempt}`}
          toolUseId={interaction.part.toolUseId}
          props={interaction.part.render.props}
          result={submitted?.key === interaction.key ? submitted.output : undefined}
          onSubmit={(toolUseId, output) => {
            void submit(toolUseId, output);
          }}
          onDismiss={(toolUseId) => {
            void submit(toolUseId, { dismissed: true });
          }}
          header={header}
        />
      ) : null}
    </div>
  );
}
