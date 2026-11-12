import { ChatBubbleIcon } from "@radix-ui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { z } from "zod";
import { taskStatusOfDto } from "@rome/api-types/concierge-task-status";
import { stopTask } from "@/components/concierge/send-task-action";
import { useConciergeTasks } from "@/components/concierge/use-concierge-tasks";
import { Button } from "@/components/ui/button";
import { useApprovals } from "@/hooks/use-approvals";
import { listSessionMessagePage, postSessionTurnJson } from "@/lib/chat-api";
import type { ChatMessage } from "@/lib/chat-types";
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
 * A task chat another agent started on the guardian's behalf: its title, its
 * live status, and a link that opens it. On a public page, its title alone.
 */
export function TaskChatCard(props: { chatId: string; title: string; isLatestForChat: boolean }) {
  return useContext(PublicTaskChatContext) ? (
    <StaticTaskChatCard title={props.title} />
  ) : (
    <LiveTaskChatCard {...props} />
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
}: {
  chatId: string;
  title: string;
  isLatestForChat: boolean;
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
  const label = derived
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
      {isLatestForChat && status === "waiting" && (
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
}: {
  chatId: string;
  onRefresh: () => Promise<void>;
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
    <div data-chat-task-waiting={chatId} className="min-w-0 wrap-anywhere">
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
        />
      ) : null}
    </div>
  );
}
