// Turns finished in task chats become `<task_event>` system turns in the
// Concierge chat, and a Concierge turn that wrote text without speaking gets
// one reminder turn.

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
import { openQuestion } from "./transcript.js";

const log = createLogger("concierge-events");

/** How much of a task chat's reply a `task_finished` event carries. */
const REPLY_EXCERPT_CHARS = 1200;
const SETTLE_POLL_MS = 200;
const SETTLE_TIMEOUT_MS = 10_000;

type TaskEvent =
  | {
      type: "task_finished";
      chatId: string;
      title: string;
      status: AgentTurnFinishedEvent["status"];
      initiator: "concierge" | "guardian" | "system";
      replyExcerpt: string;
      replyChars: number;
    }
  | { type: "task_needs_input"; chatId: string; question: string; options?: string[] };

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The event as the Concierge model reads it. */
function formatTaskEvent(event: TaskEvent): string {
  if (event.type === "task_needs_input") {
    const options = event.options?.length ? ` options="${attr(event.options.join(" | "))}"` : "";
    return `<task_event type="task_needs_input" chat_id="${attr(event.chatId)}"${options}>\n${event.question}\n</task_event>`;
  }
  return (
    `<task_event type="task_finished" chat_id="${attr(event.chatId)}" title="${attr(event.title)}" ` +
    `status="${event.status}" initiator="${event.initiator}" reply_chars="${event.replyChars}">\n` +
    `${event.replyExcerpt}\n</task_event>`
  );
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

/** Starts listening. Returns the unsubscribe. */
export function startConciergeEvents(
  service: ConciergeService,
  dispatcher: Pick<AgentLifecycleDispatcher, "onFinished">,
): () => void {
  const remindersRunning = new Set<string>();

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

  const onTaskChatTurn = async (event: AgentTurnFinishedEvent, chatId: string) => {
    if (!(await service.isEnabled())) return;
    const { webchatRepo } = service.deps;
    const chat = await webchatRepo.getSession(chatId);
    if (chat?.triggerKind !== TASK_CHAT_TRIGGER_KIND) return;
    const conciergeChatId = await service.findChatId();
    if (!conciergeChatId) return;
    await waitForTurnStream(service, chatId, event.turn.turnId);
    const rows = await webchatRepo.getTurnChatMessages(chatId, event.turn.turnId);
    const userRows = rows.filter((row) => row.role === "user");
    // A follow-up the task chat queued or deferred sits under the turn that
    // answered it, so the turn is Concierge's when any of its inputs was said
    // as Concierge's account.
    const started = userRows.some((row) => row.senderId === CONCIERGE_ACCOUNT.id);
    const question = event.status === "completed" ? openQuestion(rows) : null;
    const reply = event.output.text.trim();
    const taskEvent: TaskEvent = question
      ? { type: "task_needs_input", chatId, ...question }
      : {
          type: "task_finished",
          chatId,
          title: chat.triggerName ?? chat.name,
          status: event.status,
          initiator: started ? "concierge" : userRows.length > 0 ? "guardian" : "system",
          replyExcerpt: reply.slice(0, REPLY_EXCERPT_CHARS),
          replyChars: reply.length,
        };
    await service.runSystemTurn(conciergeChatId, formatTaskEvent(taskEvent));
  };

  return dispatcher.onFinished((event) => {
    const thread = event.turn.threadContext;
    // A subagent's turn belongs to its parent's turn, which reports on its own.
    if (event.turn.parent || thread?.channel !== "webchat" || !thread.threadId) return;
    const chatId = thread.threadId;
    const handled = isConciergeAgent(event.turn.agentName)
      ? onConciergeTurn(event, chatId)
      : onTaskChatTurn(event, chatId);
    handled.catch((error: unknown) =>
      log.warn("concierge turn handling failed", {
        chatId,
        turnId: event.turn.turnId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}
