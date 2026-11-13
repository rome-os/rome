// What a task card in a Concierge chat shows: the question or approval its
// task chat waited on when the card was said, and how it ended. The stored
// `task_chat` part only points at its task chat. Rome fills the card in each
// time it hands the message out, in one read per page, and tells the chats
// that show it when it settles (docs/domains/chats.md#task).

import type {
  ChatCardSettledEvent,
  TaskApprovalOutcome,
  TaskCard,
  TaskQuestionOutcome,
} from "@rome/api-types/chat";
import { RESOLVED_BY_EXPIRY, RESOLVED_BY_STOP } from "./approval-expiry.js";
import type { ConciergeTaskRow } from "../db/repositories/concierge-tasks.js";
import type { AskedApproval, AskedQuestion, TaskChatCards } from "../webchat/repository.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-task-cards");

/** A card said in the same second as what it shows still shows it: stored times are whole seconds. */
const SAME_SECOND_MS = 1_000;

export interface TaskCardSources {
  /** What each task chat asked, in one read for all of them. */
  taskCardsOf(chatIds: readonly string[]): Promise<Map<string, TaskChatCards>>;
  /** The task rows of these task chats, for whether a wait expired. */
  findBySessions(chatIds: readonly string[]): Promise<ConciergeTaskRow[]>;
  /** How long a wait on the owner lasts, in milliseconds. */
  waitExpiry: number;
}

/** A `task_chat` part that shows a question or approval: an `ask` card, or one from before. */
function showsAsk(part: Record<string, unknown>): part is { type: "task_chat"; chatId: string } {
  return part.type === "task_chat" && typeof part.chatId === "string" && part.show !== "task";
}

/**
 * For each of `chatIds`, the newest of `messages` that shows that task chat's
 * question or approval card, else the newest that shows its task card. A
 * task chat no message shows is left out. `messages` come in the order said.
 */
export function cardMessagesOf(
  messages: readonly { id: string; content: string }[],
  chatIds: readonly string[],
): Map<string, string> {
  const wanted = new Set(chatIds);
  const ask = new Map<string, string>();
  const task = new Map<string, string>();
  for (const message of messages) {
    let parts: unknown;
    try {
      parts = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const { type, chatId } = part as Record<string, unknown>;
      if (type !== "task_chat" || typeof chatId !== "string" || !wanted.has(chatId)) continue;
      (showsAsk(part as Record<string, unknown>) ? ask : task).set(chatId, message.id);
    }
  }
  return new Map(
    chatIds.flatMap((chatId) => {
      const id = ask.get(chatId) ?? task.get(chatId);
      return id ? [[chatId, id] as const] : [];
    }),
  );
}

/** The answer a question card sent, as one line: its answers' values. */
function answerText(output: Record<string, unknown>): string {
  const answers = Array.isArray(output.answers) ? output.answers : [];
  return answers
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { value?: unknown }).value : undefined,
    )
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(", ");
}

function questionOutcome(question: AskedQuestion): TaskQuestionOutcome | undefined {
  if (!question.output) return undefined;
  if (question.output.dismissed === true) return { kind: "dismissed" };
  return {
    kind: "answered",
    answer: { text: answerText(question.output), output: question.output },
  };
}

function approvalOutcome(approval: AskedApproval): TaskApprovalOutcome | undefined {
  if (approval.status === "approved" || approval.status === "auto_approved") {
    return { kind: "approved" };
  }
  if (approval.status !== "rejected") return undefined;
  if (approval.resolvedBy === RESOLVED_BY_EXPIRY)
    return { kind: "turned_down", reason: "no_response" };
  if (approval.resolvedBy === RESOLVED_BY_STOP)
    return { kind: "turned_down", reason: "task_stopped" };
  return { kind: "rejected" };
}

/** The approval as a card draws it. */
export function approvalCard(approval: AskedApproval): Extract<TaskCard, { kind: "approval" }> {
  const payload = (approval.payload ?? {}) as { actionName?: unknown; preview?: unknown };
  // A preview the approval card can draw names it; else its description does.
  const preview = payload.preview as
    | { kind?: unknown; title?: unknown; summary?: unknown }
    | undefined;
  const title =
    preview?.kind === "generic" &&
    typeof preview.title === "string" &&
    typeof preview.summary === "string"
      ? preview.title
      : approval.description;
  const outcome = approvalOutcome(approval);
  return {
    kind: "approval",
    id: approval.id,
    title,
    ...(typeof payload.actionName === "string" ? { actionName: payload.actionName } : {}),
    ...(payload.preview !== undefined ? { preview: payload.preview } : {}),
    since: approval.since,
    ...(outcome ? { outcome } : {}),
  };
}

/** The question as a card draws it; `row` says whether its wait expired. */
export function questionCard(
  question: AskedQuestion,
  row: ConciergeTaskRow | undefined,
  waitExpiry: number,
): Extract<TaskCard, { kind: "question" }> {
  const outcome = questionOutcome(question);
  const expiredAt = row?.expiredWaitAt?.getTime();
  // Every item said by an ended wait's deadline was part of it (tasks.ts currentWait).
  const expired = !outcome && expiredAt !== undefined && question.since <= expiredAt + waitExpiry;
  return {
    kind: "question",
    id: question.id,
    messageId: question.messageId,
    render: question.render,
    since: question.since,
    expired,
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * The card a task card said at `at` shows: the newest question or approval
 * its task chat had asked by then, or `unavailable` when it had none.
 */
export function cardAt(
  asked: TaskChatCards | undefined,
  at: number,
  row: ConciergeTaskRow | undefined,
  waitExpiry: number,
): TaskCard {
  const by = at + SAME_SECOND_MS;
  const question = asked?.questions.filter((each) => each.since <= by).at(-1);
  const approval = asked?.approvals
    .filter((each) => each.since <= by)
    .sort((a, b) => a.since - b.since)
    .at(-1);
  if (approval && (!question || approval.since > question.since)) return approvalCard(approval);
  if (question) return questionCard(question, row, waitExpiry);
  return { kind: "unavailable" };
}

/**
 * `messages` with the card of each task card filled in, read once for the
 * whole page. A message with none comes back as it was; a page whose read
 * fails shows its cards as unavailable rather than failing.
 */
export async function withTaskCards<
  T extends { role: string; content: string; createdAt: Date | string },
>(sources: TaskCardSources, messages: T[]): Promise<T[]> {
  const parsed = messages.map((message) => {
    if (message.role !== "assistant" || !message.content.includes('"task_chat"')) return null;
    try {
      const parts: unknown = JSON.parse(message.content);
      if (!Array.isArray(parts)) return null;
      return parts.some((part) => part && typeof part === "object" && showsAsk(part))
        ? parts
        : null;
    } catch {
      return null;
    }
  });
  const chatIds = parsed.flatMap((parts) =>
    (parts ?? []).filter((part) => part && showsAsk(part)).map((part) => part.chatId as string),
  );
  if (chatIds.length === 0) return messages;
  let asked = new Map<string, TaskChatCards>();
  let rows = new Map<string, ConciergeTaskRow>();
  let failed = false;
  try {
    const [cards, tasks] = await Promise.all([
      sources.taskCardsOf(chatIds),
      sources.findBySessions(chatIds),
    ]);
    asked = cards;
    rows = new Map(tasks.flatMap((row) => (row.sessionId ? [[row.sessionId, row]] : [])));
  } catch (error) {
    failed = true;
    log.warn("failed to read the cards task cards show", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return messages.map((message, index) => {
    const parts = parsed[index];
    if (!parts) return message;
    const at = new Date(message.createdAt).getTime();
    const filled = parts.map((part) => {
      if (!part || typeof part !== "object" || !showsAsk(part)) return part;
      const card: TaskCard = failed
        ? { kind: "unavailable" }
        : cardAt(asked.get(part.chatId), at, rows.get(part.chatId), sources.waitExpiry);
      return { ...part, card };
    });
    return { ...message, content: JSON.stringify(filled) };
  });
}

/**
 * The card event for the question or approval `id` of task chat `chatId`,
 * read as it stands now, or null when the chat asked no such thing.
 */
export async function settledCard(
  sources: TaskCardSources,
  chatId: string,
  item: { kind: "question" | "approval"; id: string },
): Promise<ChatCardSettledEvent["card"] | null> {
  const [asked, [row]] = await Promise.all([
    sources.taskCardsOf([chatId]).then((cards) => cards.get(chatId)),
    sources.findBySessions([chatId]),
  ]);
  if (item.kind === "approval") {
    const approval = asked?.approvals.find((each) => each.id === item.id);
    return approval ? approvalCard(approval) : null;
  }
  // The newest card asked under that id: a later turn can ask again under it.
  const question = asked?.questions.filter((each) => each.id === item.id).at(-1);
  return question ? questionCard(question, row, sources.waitExpiry) : null;
}

/** The open questions of task chat `chatId`, as their cards now read: what a wait's expiry settles. */
export async function openQuestionCards(
  sources: TaskCardSources,
  chatId: string,
): Promise<ChatCardSettledEvent["card"][]> {
  const [asked, [row]] = await Promise.all([
    sources.taskCardsOf([chatId]).then((cards) => cards.get(chatId)),
    sources.findBySessions([chatId]),
  ]);
  return (asked?.questions ?? [])
    .filter((question) => !question.output)
    .map((question) => questionCard(question, row, sources.waitExpiry));
}
