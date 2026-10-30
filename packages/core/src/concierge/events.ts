// Changes in task chats reach the Concierge as `<task_events>` system turns,
// coalesced per row (task-events.ts), and a Concierge turn that wrote text
// without speaking gets one reminder turn.

import type { AgentTurnFinishedEvent } from "@rome-os/app-runtime";
import type { AgentLifecycleDispatcher } from "../core/agent-lifecycle.js";
import { createLogger } from "../logger.js";
import { NUDGE_PROMPT, shouldNudge } from "./nudge.js";
import {
  CONCIERGE_ACCOUNT,
  type ConciergeService,
  isConciergeAgent,
  TASK_CHAT_TRIGGER_KIND,
} from "./service.js";
import { hasText, latestSaid, taskChatPlace } from "./task-chat.js";
import { type DirtyTask, TaskEventCoalescer } from "./task-events.js";
import { openQuestion } from "./transcript.js";

const log = createLogger("concierge-events");

/** How much of a task chat's reply a task event carries. */
const REPLY_EXCERPT_CHARS = 600;
const DETAIL_EXCERPT_CHARS = 300;
const SETTLE_POLL_MS = 200;
const SETTLE_TIMEOUT_MS = 10_000;

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const excerpt = (text: string, max: number) => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

/** The text of a stored user message, for the guardian's words in a task event. */
function userText(content: string): string {
  try {
    const parts: unknown = JSON.parse(content);
    if (!Array.isArray(parts)) return content;
    return parts
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { content?: unknown }).content ?? "")
          : "",
      )
      .join(" ");
  } catch {
    return content;
  }
}

// The lifecycle event fires when the agent ends its turn, before the chat's
// stream has written the turn's cards and reply. The stream ends after both.
async function waitForTurnStream(
  service: ConciergeService,
  chatId: string,
  turnId: string,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!service.dashboard.chats.activeTurns(chatId).includes(turnId)) return;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

/**
 * The `<task_events>` payload for these rows, read from the database now:
 * one `<task>` per row that still exists, with what changed and the latest
 * words from the chat.
 */
async function renderTaskEvents(
  service: ConciergeService,
  tasks: DirtyTask[],
): Promise<string | null> {
  const { tasks: store, messages } = service.deps;
  const blocks: string[] = [];
  for (const task of tasks) {
    const found = await store.repo.getWithChat(task.taskId);
    if (!found) continue;
    const { row } = found;
    const changes = task.changes.map((change) => change.kind);
    const lines: string[] = [];
    // A catch-up carries no event of its own, so it says what the chat holds now:
    // without its last words and whether it still runs, the Concierge cannot judge it.
    const caughtUp = changes.includes("catch_up");
    if (row.sessionId && caughtUp) {
      const running = service.dashboard.chats.activeTurns(row.sessionId).length > 0;
      lines.push(`chat: ${running ? "running" : "idle"}`);
    }
    const wantsReply = caughtUp || changes.some((kind) => kind.startsWith("turn_end"));
    if (row.sessionId && wantsReply) {
      const [latest] = await latestSaid(
        messages,
        taskChatPlace(row.sessionId),
        1,
        (message) => message.direction === "fromRome" && hasText(message),
      );
      if (latest) lines.push(`reply: ${excerpt(latest.body.text, REPLY_EXCERPT_CHARS)}`);
    }
    for (const change of task.changes) {
      if (change.detail) lines.push(change.detail);
    }
    if (changes.includes("chat_deleted")) lines.push("The task chat was deleted.");
    const attrs = [
      `id="${attr(row.id)}"`,
      row.sessionId ? `chat_id="${attr(row.sessionId)}"` : null,
      `title="${attr(row.title)}"`,
      `state="${row.state}"`,
      `changes="${attr([...new Set(changes)].join(", "))}"`,
      task.quiet ? 'quiet="true"' : null,
    ]
      .filter(Boolean)
      .join(" ");
    blocks.push(`<task ${attrs}>\n${lines.join("\n")}\n</task>`);
  }
  return blocks.length > 0 ? `<task_events>\n${blocks.join("\n")}\n</task_events>` : null;
}

/** Starts listening. Returns the unsubscribe. */
export function startConciergeEvents(
  service: ConciergeService,
  dispatcher: Pick<AgentLifecycleDispatcher, "onFinished">,
): () => void {
  const remindersRunning = new Set<string>();
  const { tasks, webchatRepo, approvals } = service.deps;

  const coalescer = new TaskEventCoalescer({
    now: () => Date.now(),
    isEnabled: () => service.isEnabled(),
    render: (dirty) => renderTaskEvents(service, dirty),
    deliver: async (prompt, options) => {
      const chatId = await service.findChatId();
      if (chatId) await service.runSystemTurn(chatId, prompt, options);
    },
    giveUp: (taskId) => tasks.markNotSynced(taskId),
  });
  service.attachTaskEvents(coalescer);

  const onConciergeTurn = async (event: AgentTurnFinishedEvent, chatId: string) => {
    // Read before any await: the reminder's own finish event fires while the
    // reminder still runs, and the flag clears as soon as it returns.
    const reminderRunning = remindersRunning.has(chatId);
    if (!(await service.isEnabled())) return;
    const nudge = shouldNudge({
      status: event.status,
      text: event.output.text,
      reminderRunning,
    });
    if (!nudge) return;
    remindersRunning.add(chatId);
    try {
      await service.runSystemTurn(chatId, NUDGE_PROMPT);
    } finally {
      remindersRunning.delete(chatId);
    }
  };

  // Every task chat has a row; a chat that has none (one from before the
  // todo list) is not reported until the Concierge links it.
  const taskOf = async (chatId: string) => {
    const chat = await webchatRepo.getSession(chatId);
    if (chat?.triggerKind !== TASK_CHAT_TRIGGER_KIND) return null;
    return (await tasks.repo.findBySession(chatId))?.id ?? null;
  };

  const onTaskChatTurn = async (event: AgentTurnFinishedEvent, chatId: string) => {
    if (!(await service.isEnabled())) return;
    const taskId = await taskOf(chatId);
    if (!taskId) return;
    await waitForTurnStream(service, chatId, event.turn.turnId);
    const rows = await webchatRepo.getTurnChatMessages(chatId, event.turn.turnId);
    const userRows = rows.filter((row) => row.role === "user");
    // A follow-up the task chat queued or deferred sits under the turn that
    // answered it, so the turn is Concierge's when any of its inputs was said
    // as Concierge's account.
    const started = userRows.some((row) => row.senderId === CONCIERGE_ACCOUNT.id);
    const by = started ? "concierge" : userRows.length > 0 ? "guardian" : "system";
    const question = event.status === "completed" ? openQuestion(rows) : null;
    if (question) {
      const options = question.options?.length ? ` (options: ${question.options.join(" | ")})` : "";
      coalescer.mark({
        taskId,
        kind: `turn_end:completed question by=${by}`,
        urgent: true,
        detail: `question: ${question.question}${options}`,
      });
      return;
    }
    coalescer.mark({
      taskId,
      kind: `turn_end:${event.status} by=${by}`,
      // A result the Concierge asked for, or an error, is worth telling now.
      // The guardian's own turns, scheduled ones and a stop wait.
      urgent: event.status === "error" || (event.status === "completed" && started),
    });
  };

  const onGuardianMessage = async (message: {
    sessionId: string;
    role: string;
    senderId?: string | null;
    content: string;
  }) => {
    if (message.role !== "user" || message.senderId === CONCIERGE_ACCOUNT.id) return;
    if (!(await service.isEnabled())) return;
    const taskId = await taskOf(message.sessionId);
    if (!taskId) return;
    coalescer.mark({
      taskId,
      kind: "guardian_message",
      urgent: false,
      detail: `guardian: ${excerpt(userText(message.content), DETAIL_EXCERPT_CHARS)}`,
    });
  };

  const onApproval = async (approval: {
    status: string;
    description: string;
    payload: unknown;
  }) => {
    if (approval.status !== "pending") return;
    const context = (approval.payload as { channelContext?: { threadId?: unknown } } | null)
      ?.channelContext;
    if (typeof context?.threadId !== "string") return;
    if (!(await service.isEnabled())) return;
    const taskId = await taskOf(context.threadId);
    if (!taskId) return;
    coalescer.mark({
      taskId,
      kind: "approval",
      urgent: true,
      detail: `approval: ${excerpt(approval.description, DETAIL_EXCERPT_CHARS)}`,
    });
  };

  const guard = (label: string, work: Promise<void>) =>
    work.catch((error: unknown) =>
      log.warn(`${label} failed`, {
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  // After a restart, a chat that was active since its row was written may
  // have changes the Concierge never heard of.
  void guard(
    "task catch-up",
    tasks.repo.listBehindTheirChat().then((rows) => {
      for (const row of rows) {
        coalescer.mark({ taskId: row.id, kind: "catch_up", urgent: false });
      }
    }),
  );

  const unsubscribers = [
    tasks.repo.onChange(({ row }, change) => {
      if (change === "write") coalescer.settle(row.id);
    }),
    webchatRepo.onMessageInserted(
      (message) => void guard("guardian message", onGuardianMessage(message)),
    ),
    approvals.onCreated((approval) => void guard("approval event", onApproval(approval))),
    dispatcher.onFinished((event) => {
      const thread = event.turn.threadContext;
      // A subagent's turn belongs to its parent's turn, which reports on its own.
      if (event.turn.parent || thread?.channel !== "webchat" || !thread.threadId) return;
      const chatId = thread.threadId;
      const handled = isConciergeAgent(event.turn.agentName)
        ? onConciergeTurn(event, chatId)
        : onTaskChatTurn(event, chatId);
      void guard(`concierge turn handling (${event.turn.turnId})`, handled);
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    coalescer.stop();
    service.attachTaskEvents(null);
  };
}
