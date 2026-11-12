import { ChatBubbleIcon } from "@radix-ui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useApprovals } from "@/hooks/use-approvals";
import { listSessionMessagePage, type WidgetEventOutcome } from "@/lib/chat-api";
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
  return (
    <div className="w-full min-w-0 max-w-md space-y-3 rounded-16 border border-border bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <ChatBubbleIcon className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-foreground">{session?.name ?? title}</span>
          <span className="text-aux text-muted-foreground">
            {t("concierge.taskChat")} · {t(`concierge.taskStatus.${status}`)}
          </span>
        </div>
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
  appId: z.string().optional(),
  render: z
    .object({
      builtin: z.boolean().optional(),
      componentId: z.string(),
      props: z.record(z.string(), z.unknown()).optional(),
      ui: z.unknown().optional(),
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
    { part: z.infer<typeof interactionSchema>; key: string; messageId: string; at: string }
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
        open.set(part.toolUseId, {
          part,
          key: `${message.id}:${index}`,
          messageId: message.id,
          at: message.createdAt,
        });
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

  // Core takes the card's events; this hears what it said. A card already
  // answered elsewhere refreshes and says so; a failure lets the guardian retry.
  function settled(outcome: WidgetEventOutcome) {
    if (outcome.ok) setError(null);
    else {
      setError(
        outcome.status === 400
          ? t("concierge.taskCardAlreadyAnswered")
          : t("stream.errors.sendFallback"),
      );
      setAttempt((value) => value + 1);
    }
    void refresh();
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
          widgetId={interaction.messageId}
          key={`${interaction.key}:${attempt}`}
          toolUseId={interaction.part.toolUseId}
          appId={interaction.part.appId ?? "core"}
          ui={interaction.part.render.ui}
          props={interaction.part.render.props}
          onSettled={settled}
        />
      ) : null}
    </div>
  );
}
