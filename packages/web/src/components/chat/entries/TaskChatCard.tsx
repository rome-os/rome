import { ChevronRight } from "lucide-react";
import { ChatBubbleIcon } from "@radix-ui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { z } from "zod";
import { taskStatusOfDto } from "@rome/api-types/concierge-task-status";
import { stopTask } from "@/components/concierge/send-task-action";
import { useConciergeTasks } from "@/components/concierge/use-concierge-tasks";
import { Button } from "@/components/ui/button";
import { useApprovals } from "@/hooks/use-approvals";
import { listSessionMessagePage, postSessionTurnJson } from "@/lib/chat-api";
import type { ApprovalCardStatus, ChatMessage } from "@/lib/chat-types";
import { ApprovalCard } from "../approval/ApprovalCard";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { chatStatusTopic, useLiveEvents } from "@/hooks/use-live-events";
import { QuestionCard } from "./QuestionCard";

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
}) {
  const { show, ...card } = props;
  if (useContext(PublicTaskChatContext)) return <StaticTaskChatCard title={props.title} />;
  if (show === "ask") return <TaskAskCard {...card} />;
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
}: {
  chatId: string;
  title: string;
  isLatestForChat: boolean;
}) {
  const { t } = useTranslation("chat");
  const { sessions, invalidate } = useChatSessions("all", "all");
  const { tasks } = useConciergeTasks();
  const [open, setOpen] = useState(false);
  const session = sessions?.find((candidate) => candidate.id === chatId);
  const task = tasks.find((candidate) => candidate.chat?.id === chatId);
  const derived = task ? taskStatusOfDto(task) : null;
  const waiting = isLatestForChat && session?.awaitingGuardian === true;
  const expired = waiting && derived?.endReason === "no_response";
  if (expired && !open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="flex max-w-md items-center gap-1 rounded-4 px-1 text-left text-aux text-muted-foreground outline-1 outline-offset-1 outline-transparent transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50 motion-reduce:transition-none"
      >
        {t("concierge.ask.expiredFold")}
        <ChevronRight className="size-3 shrink-0" aria-hidden />
      </button>
    );
  }
  if (waiting) {
    return (
      <div className="flex w-full min-w-0 max-w-md flex-col">
        <WaitingTaskCard
          key={chatId}
          chatId={chatId}
          onRefresh={invalidate}
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
  return <FoldedAskCard chatId={chatId} />;
}

const resultSchema = z.object({
  type: z.literal("interaction_result"),
  toolUseId: z.string(),
  output: z.record(z.string(), z.unknown()).optional(),
});

/** An answer short enough to repeat on the folded card. */
const SHORT_ANSWER = 24;

/**
 * A task's question or approval that is no longer open: what it asked, then
 * how it ended (the answer, or that it was dismissed; an approval approved,
 * rejected, or turned down by Rome when the wait ran out; or still waiting
 * on a newer copy below). It opens to the original, read-only.
 */
function FoldedAskCard({ chatId }: { chatId: string }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const messages = useQuery({
    queryKey: ["task-chat-cards", chatId],
    queryFn: () => listSessionMessagePage(chatId, { limit: 2 }),
  });
  const approvals = useApprovals();
  const approval = (approvals.data ?? [])
    .flatMap((row) => {
      const payload = approvalPayloadSchema.safeParse(row.payload);
      return payload.success && payload.data.channelContext.threadId === chatId
        ? [{ row, payload: payload.data }]
        : [];
    })
    .sort((a, b) => Date.parse(b.row.createdAt) - Date.parse(a.row.createdAt))[0];
  // The latest question asked, and the latest answer, with when each came.
  let answer: { at: string; toolUseId: string; output: Record<string, unknown> } | null = null;
  let asked: { at: string; part: z.infer<typeof interactionSchema> } | null = null;
  for (const message of messages.data?.messages ?? []) {
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
        answer = {
          at: message.createdAt,
          toolUseId: result.data.toolUseId,
          output: result.data.output ?? {},
        };
      }
      const interaction = interactionSchema.safeParse(raw);
      if (interaction.success && interaction.data.type === "pending_interaction") {
        asked = { at: message.createdAt, part: interaction.data };
      }
    }
  }
  const lastQuestionAt = Math.max(
    asked ? Date.parse(asked.at) : 0,
    answer ? Date.parse(answer.at) : 0,
  );
  const approvalIsLatest =
    approval !== undefined && Date.parse(approval.row.createdAt) > lastQuestionAt;
  const questionOpen =
    !approvalIsLatest &&
    asked !== null &&
    (answer === null || Date.parse(asked.at) > Date.parse(answer.at));
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
    outcome =
      approval.row.resolvedBy === "rome:task-ended"
        ? t("concierge.ask.turnedDown")
        : approval.row.status === "rejected"
          ? t("concierge.ask.rejected")
          : t("concierge.ask.approved");
  } else if (answer?.output.dismissed === true) {
    outcome = t("concierge.ask.dismissed");
  } else {
    const values = (Array.isArray(answer?.output.answers) ? answer.output.answers : [])
      .map((entry) =>
        entry && typeof entry === "object" ? (entry as { value?: unknown }).value : undefined,
      )
      .filter((value): value is string => typeof value === "string" && value.trim() !== "");
    const text = values.join(", ");
    outcome =
      text && text.length <= SHORT_ANSWER
        ? t("concierge.ask.answeredWith", { answer: text })
        : t("concierge.ask.answered");
  }
  return (
    <div className="flex w-full min-w-0 max-w-md flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 flex-col rounded-12 border border-border bg-surface px-4 py-2 text-left outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50 motion-reduce:transition-none"
      >
        {title ? (
          <span className="w-full truncate text-aux text-muted-foreground">{title}</span>
        ) : null}
        <span className="text-ui text-foreground">{outcome}</span>
      </button>
      {open ? (
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
          />
        ) : !questionOpen && asked?.part.render?.componentId === "question-card" ? (
          <QuestionCard
            toolUseId={asked.part.toolUseId}
            props={props}
            result={
              answer && answer.toolUseId === asked.part.toolUseId
                ? answer.output
                : { dismissed: true }
            }
            onSubmit={() => {}}
            onDismiss={() => {}}
          />
        ) : null
      ) : null}
    </div>
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
  const { tasks } = useConciergeTasks();
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
    <div className="w-full min-w-0 max-w-md space-y-3 rounded-16 border border-border bg-surface px-3 py-2">
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
      status === "waiting" &&
      derived?.endReason === "no_response" ? (
        // The wait ran out and the task ended, yet its card still takes an answer.
        <p className="text-aux text-muted-foreground">{t("concierge.tasks.expired")}</p>
      ) : null}
      {embedWait && isLatestForChat && status === "waiting" && (
        <WaitingTaskCard key={chatId} chatId={chatId} onRefresh={invalidate} />
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

function latestOpenInteraction(messages: ChatMessage[]) {
  const open = new Map<
    string,
    { part: z.infer<typeof interactionSchema>; key: string; at: string }
  >();
  // Results close only earlier cards: a later turn can reuse the same toolUseId.
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "user") continue;
    let parts: unknown;
    try {
      parts = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;
    for (const [index, raw] of parts.entries()) {
      const parsed = interactionSchema.safeParse(raw);
      if (!parsed.success) continue;
      const part = parsed.data;
      open.delete(part.toolUseId);
      if (part.type === "pending_interaction") {
        open.set(part.toolUseId, { part, key: `${message.id}:${index}`, at: message.createdAt });
      }
    }
  }
  return [...open.values()].at(-1);
}

function WaitingTaskCard({
  chatId,
  onRefresh,
  header,
  countsAsWaiting = true,
}: {
  chatId: string;
  onRefresh: () => Promise<void>;
  /** Shown at the top inside the question or approval card. */
  header?: ReactNode;
  /** Whether the "Needs you" jump counts it; an expired question does not. */
  countsAsWaiting?: boolean;
}) {
  const { t } = useTranslation("chat");
  const messages = useQuery({
    queryKey: ["task-chat-cards", chatId],
    // Waiting questions follow the last user prompt. Pages contain whole turns,
    // so two turns cover that question even when a turn has many message rows.
    queryFn: () => listSessionMessagePage(chatId, { limit: 2 }),
    refetchOnMount: "always",
  });
  const approvals = useApprovals({ status: "pending" });
  const [submitted, setSubmitted] = useState<{
    key: string;
    output: Record<string, unknown>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const interaction = latestOpenInteraction(messages.data?.messages ?? []);
  const approval = (approvals.data ?? [])
    .flatMap((row) => {
      const payload = approvalPayloadSchema.safeParse(row.payload);
      return row.status === "pending" &&
        payload.success &&
        payload.data.channelContext.threadId === chatId
        ? [{ row, payload: payload.data }]
        : [];
    })
    .sort((a, b) => Date.parse(b.row.createdAt) - Date.parse(a.row.createdAt))[0];

  async function refresh() {
    await Promise.all([messages.refetch(), approvals.refetch(), onRefresh()]);
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

  return (
    <div
      data-chat-task-waiting={countsAsWaiting ? chatId : undefined}
      className="min-w-0 wrap-anywhere"
    >
      {error && (
        <p role="status" className="mb-2 text-aux text-muted-foreground">
          {error}
        </p>
      )}
      {approval &&
      (!interaction || Date.parse(approval.row.createdAt) > Date.parse(interaction.at)) ? (
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
