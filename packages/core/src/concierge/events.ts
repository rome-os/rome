// Changes in task chats reach the Concierge as `<task_events>` system turns,
// coalesced per row and delivered to the Concierge chat each row came from
// (task-events.ts), and a Concierge turn that wrote text without speaking gets
// one reminder turn.

import type { AgentTurnFailure, AgentTurnFinishedEvent } from "@rome-os/app-runtime";
import { CONCIERGE_DONE_DAYS } from "@rome/api-types/concierge";
import type { AgentTurnFailedBeforeStart, TurnListeners } from "../agent/index.js";
import { createLogger } from "../logger.js";
import { NUDGE_PROMPT, quotaRecoveryPrompt, shouldNudge } from "./nudge.js";
import {
  CONCIERGE_ACCOUNT,
  type ConciergeService,
  isConciergeAgent,
  TASK_CHAT_TRIGGER_KIND,
} from "./service.js";
import { hasText, latestSaid, taskChatPlace } from "./task-chat.js";
import { type DirtyTask, TaskEventCoalescer, type TaskEventDelivery } from "./task-events.js";
import { ConciergeActivityTracker } from "./activity.js";
import { isConciergeChat } from "./privacy.js";
import { openQuestion } from "./transcript.js";

import { failoverReason } from "./failover-reason.js";

const log = createLogger("concierge-events");

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

/** A task event carries a reply this long whole, and a longer one's start and end. */
const REPLY_HEAD_CHARS = 400;
const REPLY_TAIL_CHARS = 300;
/** How far a cut moves to land on a space or line break. */
const CUT_SLACK_CHARS = 30;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A long reply keeps its start and its end, where a closing question sits.
 *  Characters are graphemes, so a cut never splits an emoji. */
function replyExcerpt(text: string): string {
  const chars = Array.from(graphemes.segment(text.trim()), (part) => part.segment);
  if (chars.length <= REPLY_HEAD_CHARS + REPLY_TAIL_CHARS) return chars.join("");
  const space = (from: number, step: number) => {
    for (let i = from, n = 0; n < CUT_SLACK_CHARS; i += step, n++) {
      if (/\s/u.test(chars[i])) return i;
    }
    return -1;
  };
  const headSpace = space(REPLY_HEAD_CHARS - 1, -1);
  const end = headSpace < 0 ? REPLY_HEAD_CHARS : headSpace;
  const tailSpace = space(chars.length - REPLY_TAIL_CHARS, 1);
  const start = tailSpace < 0 ? chars.length - REPLY_TAIL_CHARS : tailSpace + 1;
  const note = `[… ${start - end} characters left out; chat_read shows the full reply]`;
  return `${chars.slice(0, end).join("")}\n${note}\n${chars.slice(start).join("")}`;
}

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
 * The `<task_events>` payloads for these rows, read from the database now, one
 * per Concierge chat the rows came from: one `<task>` per row that still
 * exists, with what changed and the latest words from the chat.
 */
export async function renderTaskEvents(
  service: ConciergeService,
  tasks: DirtyTask[],
): Promise<TaskEventDelivery[]> {
  const { tasks: store, messages } = service.deps;
  const byChat = new Map<
    string,
    { taskIds: string[]; blocks: string[]; quiet: boolean; owner: string }
  >();
  for (const task of tasks) {
    const found = await store.repo.getWithChat(task.taskId);
    if (!found) continue;
    const { row } = found;
    // The chat the row reports to now: its own while live, else its owner's main chat.
    const key = found.conciergeChat.id;
    const group = byChat.get(key) ?? { taskIds: [], blocks: [], quiet: true, owner: found.owner };
    byChat.set(key, group);
    group.taskIds.push(task.taskId);
    group.quiet &&= task.quiet;
    const blocks = group.blocks;
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
      if (latest) lines.push(`reply: ${replyExcerpt(latest.body.text)}`);
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
  return [...byChat.entries()].map(([chatId, { taskIds, blocks, quiet, owner }]) => ({
    chatId,
    owner,
    taskIds,
    prompt: `<task_events>\n${blocks.join("\n")}\n</task_events>`,
    quiet,
  }));
}

/** Starts listening. Returns the unsubscribe. */
export function startConciergeEvents(
  service: ConciergeService,
  turns: Pick<TurnListeners, "listen">,
  options: { delay?: (ms: number) => Promise<void> } = {},
): () => void {
  const remindersRunning = new Set<string>();
  const recoveriesRunning = new Map<string, { finished?: AgentTurnFinishedEvent }>();
  const { tasks, webchatRepo, approvals } = service.deps;

  const coalescer = new TaskEventCoalescer({
    now: () => Date.now(),
    render: (dirty) => renderTaskEvents(service, dirty),
    deliver: async ({ chatId: from, owner, prompt, quiet }) => {
      // A row whose chat is gone or archived reports to the main chat.
      const chatId = await service.deliveryChat(from, owner);
      if (!chatId) return "failed";
      // A visitor dropped from the dashboard allow-list is told nothing; their
      // rows wait, and reach them once they are back.
      if (!(await service.isServed(owner))) return "failed";
      return await service.systemTurnOutcome(chatId, prompt, { quiet, pushLevel: "active" });
    },
    giveUp: (taskId) => tasks.markNotSynced(taskId),
  });
  service.attachTaskEvents(coalescer);

  const activity = startActivity(service, coalescer);

  const onConciergeTurn = async (event: AgentTurnFinishedEvent, chatId: string) => {
    // Read before any await: the reminder's own finish event fires while the
    // reminder still runs, and the flag clears as soon as it returns.
    const reminderRunning = remindersRunning.has(chatId);
    // Finish callbacks run before the backend promise settles. Capture them
    // synchronously so a recovery cannot start a second chain or a reminder.
    const active = recoveriesRunning.get(chatId);
    if (active) {
      active.finished = event;
      return;
    }
    if (event.status === "error") {
      const failure = event.output.failure;
      const reason = failoverReason(failure, service.deps.accounts.read());
      if (!reason || !failure) return;
      const chain: { finished?: AgentTurnFinishedEvent } = {};
      recoveriesRunning.set(chatId, chain);
      try {
        const recover = async (
          input: AgentTurnFailure,
          kind: typeof reason,
          sameThread: boolean,
        ): Promise<AgentTurnFinishedEvent | undefined> => {
          chain.finished = undefined;
          await service.runSystemTurn(
            chatId,
            quotaRecoveryPrompt(input.provider === "openai" ? "Codex" : "Claude", kind, sameThread),
          );
          return chain.finished;
        };
        let crossed = false;
        let next: AgentTurnFinishedEvent | undefined;
        if (reason === "temporary") {
          await (options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
            30_000,
          );
          // The wait may have ended the subscription that paid for this turn.
          if (!failoverReason(failure, service.deps.accounts.read())) return;
          next = await recover(failure, reason, true);
        } else {
          const moved = await service.switchForFailure(chatId, failure, reason);
          if (!moved) return;
          crossed = moved.from !== moved.to;
          next = await recover(failure, reason, !crossed);
        }
        if (crossed || next?.status !== "error" || !next.output.failure) return;
        const second = failoverReason(next.output.failure, service.deps.accounts.read());
        if (!second) return;
        const moved = await service.switchForFailure(chatId, next.output.failure, second, true);
        if (moved) await recover(next.output.failure, second, false);
      } finally {
        recoveriesRunning.delete(chatId);
      }
      return;
    }
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
    // The guardian's own words reach the chat through the user-input path, which
    // announces nothing, so they are read from the rows of the turn they started.
    const words = userRows.map((row) => userText(row.content)).join(" | ");
    const said = by === "guardian" ? `guardian: ${excerpt(words, DETAIL_EXCERPT_CHARS)}` : null;
    const question = event.status === "completed" ? openQuestion(rows) : null;
    if (question) {
      const options = question.options?.length ? ` (options: ${question.options.join(" | ")})` : "";
      coalescer.mark({
        taskId,
        kind: `turn_end:completed question by=${by}`,
        urgent: true,
        detail: [said, `question: ${question.question}${options}`].filter(Boolean).join("\n"),
      });
      return;
    }
    // A failed turn says why, so the Concierge can tell the guardian.
    const { failure, error } = event.output;
    const cause = event.status === "error" ? (failure?.message ?? error) : undefined;
    const why = cause ? `error: ${excerpt(cause, DETAIL_EXCERPT_CHARS)}` : null;
    const detail = [said, why].filter(Boolean);
    coalescer.mark({
      taskId,
      kind: `turn_end:${event.status} by=${by}`,
      // A result the Concierge asked for, or an error, is worth telling now.
      // The guardian's own turns, scheduled ones and a stop wait.
      urgent: event.status === "error" || (event.status === "completed" && started),
      ...(detail.length ? { detail: detail.join("\n") } : {}),
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

  // A turn that failed before it started fires no turn end, so it is told as a failed turn.
  const onFailedBeforeStart = ({ turn, error }: AgentTurnFailedBeforeStart) => {
    const thread = turn.threadContext;
    if (turn.parent || thread?.channel !== "webchat" || !thread.threadId) return;
    if (isConciergeAgent(turn.agentName)) return;
    const failed: AgentTurnFinishedEvent = {
      type: "agent-turn-finished",
      version: 1,
      turn,
      status: "error",
      timing: { startedAt: "", finishedAt: "", durationMs: 0 },
      output: { text: "", state: "none", error },
      metrics: { toolCallCount: 0, skillWritten: false },
    };
    void guard(`task turn failure (${turn.turnId})`, onTaskChatTurn(failed, thread.threadId));
  };
  service.attachFailedBeforeStart(onFailedBeforeStart);

  const unsubscribers = [
    turns.listen({
      couldNotStart: onFailedBeforeStart,
      ended: (event) => {
        const thread = event.turn.threadContext;
        // A subagent's turn belongs to its parent's turn, which reports on its own.
        if (event.turn.parent || thread?.channel !== "webchat" || !thread.threadId) return;
        const chatId = thread.threadId;
        const handled = isConciergeAgent(event.turn.agentName)
          ? onConciergeTurn(event, chatId)
          : onTaskChatTurn(event, chatId);
        void guard(`concierge turn handling (${event.turn.turnId})`, handled);
      },
    }),
    tasks.repo.onChange(({ row }, change) => {
      if (change === "write") coalescer.settle(row.id);
    }),
    approvals.onCreated((approval) => void guard("approval event", onApproval(approval))),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    activity();
    coalescer.stop();
    service.attachTaskEvents(null);
    service.attachFailedBeforeStart(null);
  };
}

/** How many sessions the activity remembers the Concierge chat of before it forgets them all. */
const MOVED_BY_CACHE_LIMIT = 5_000;

/**
 * Starts telling each Concierge chat's activity (activity.ts): its own turn
 * and the tool it is in, cards and approvals, its task chats, and the results
 * the coalescer is about to report. Returns the stop.
 */
function startActivity(service: ConciergeService, coalescer: TaskEventCoalescer): () => void {
  const { tasks, webchatRepo, approvals } = service.deps;
  const running = (chatId: string): boolean => {
    try {
      return service.dashboard.chats.isRunning(chatId);
    } catch {
      return false;
    }
  };

  // Which Concierge chat each session moves. A task chat's row can be written
  // after the chat starts, so a row write forgets its session's answer.
  const movedBy = new Map<string, string[]>();
  const chatOfTask = async (taskId: string): Promise<string | null> =>
    (await tasks.repo.getWithChat(taskId))?.conciergeChat.id ?? null;

  const tracker = new ConciergeActivityTracker({
    now: () => Date.now(),
    isRunning: running,
    openTool: (chatId) => {
      try {
        return service.dashboard.chats.openTool(chatId);
      } catch {
        return null;
      }
    },
    awaitingGuardianOf: (chatIds) => webchatRepo.awaitingGuardianOf(chatIds),
    tasksOf: async (chatId) => {
      const since = new Date(Date.now() - CONCIERGE_DONE_DAYS * 24 * 60 * 60 * 1000);
      return (await tasks.repo.listForPanel(since))
        .filter((task) => task.conciergeChat.id === chatId)
        .map((task) => ({
          id: task.row.id,
          title: task.row.title,
          chatId: task.chat?.id ?? null,
          updatedAt: task.row.updatedAt.getTime(),
        }));
    },
    reportPending: () => coalescer.awaitingReport,
    ownerOf: async (chatId) =>
      (await service.conciergeChat(chatId)) ? await service.ownerOfChat(chatId) : null,
    chatsOf: async (owner) => (await service.listChats(owner)).map((chat) => chat.id),
    chatsMovedBy: async (sessionId) => {
      const known = movedBy.get(sessionId);
      if (known) return known;
      const chat = await webchatRepo.getSession(sessionId);
      if (!chat) return [];
      let moved: string[] = [];
      if (isConciergeChat(chat)) {
        moved = [chat.id];
      } else if (chat.triggerKind === TASK_CHAT_TRIGGER_KIND) {
        const row = await tasks.repo.findBySession(sessionId);
        const target = row ? await chatOfTask(row.id) : null;
        if (target) moved = [target];
      }
      if (movedBy.size >= MOVED_BY_CACHE_LIMIT) movedBy.clear();
      movedBy.set(sessionId, moved);
      return moved;
    },
  });
  service.attachActivity(tracker);

  const guard = (work: Promise<void>) =>
    work.catch((error: unknown) =>
      log.warn("concierge activity update failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  const sessionChanged = (sessionId: string) => void guard(tracker.sessionChanged(sessionId));
  const approvalChanged = (approval: { payload: unknown }) => {
    const threadId = (approval.payload as { channelContext?: { threadId?: unknown } } | null)
      ?.channelContext?.threadId;
    if (typeof threadId === "string") sessionChanged(threadId);
  };

  // The rows about to be reported, so a row that stops being one moves its chat too.
  let reporting = new Set<string>();
  const reportChanged = () => {
    const now = new Set(coalescer.awaitingReport);
    const changed = [...new Set([...reporting, ...now])].filter(
      (taskId) => reporting.has(taskId) !== now.has(taskId),
    );
    reporting = now;
    for (const taskId of changed) {
      void guard(
        chatOfTask(taskId).then((chatId) => (chatId ? tracker.refresh(chatId) : undefined)),
      );
    }
  };

  const unsubscribers = [
    service.watchTurns(sessionChanged),
    webchatRepo.onMessageInserted((message) => sessionChanged(message.sessionId)),
    approvals.onCreated(approvalChanged),
    approvals.onResolved(approvalChanged),
    tasks.repo.onChange(({ row, conciergeChat }) => {
      if (row.sessionId) movedBy.delete(row.sessionId);
      void guard(tracker.refresh(conciergeChat.id));
    }),
    coalescer.onChange(reportChanged),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    tracker.stop();
    service.attachActivity(null);
  };
}
