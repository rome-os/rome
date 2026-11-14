// What a task card in a Concierge chat shows: the question or approval its
// task chat waited on when the card was said, and how it ended. The stored
// `task_chat` part points at its task chat and the item it waited on. Rome
// fills the card in each time it hands the message out, in one read per page,
// and tells the chats that show it when it settles (docs/domains/chats.md#task).

import type {
  ChatCardSettledEvent,
  TaskApprovalOutcome,
  TaskCard,
  TaskChatWaitedOn,
  TaskQuestionOutcome,
} from "@rome/api-types/chat";
import type { ConciergeOpenWait } from "@rome/api-types/concierge";
import { RESOLVED_BY_EXPIRY, RESOLVED_BY_STOP } from "./approval-expiry.js";
import type { ConciergeTaskRow } from "../db/repositories/concierge-tasks.js";
import type { AskedApproval, AskedQuestion, TaskChatCards } from "../webchat/repository.js";
import { createLogger } from "../logger.js";
import { GUARDIAN_OWNER } from "../webchat/owner.js";

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
function showsAsk(part: Record<string, unknown>): part is {
  type: "task_chat";
  chatId: string;
  show?: "ask";
  waitedOn?: TaskChatWaitedOn;
} {
  return part.type === "task_chat" && typeof part.chatId === "string" && part.show !== "task";
}

/** Whether the item an ask card's part names is the wait `wait`. */
function showsWait(waitedOn: TaskChatWaitedOn, wait: ConciergeOpenWait): boolean {
  return wait.kind === "approval"
    ? waitedOn.kind === "approval" && waitedOn.id === wait.id
    : waitedOn.kind === "question" &&
        waitedOn.id === wait.id &&
        waitedOn.messageId === wait.messageId;
}

/**
 * For each task chat in `waits`, the message of `messages` whose card the
 * transcript draws answerable for the wait it now holds: the newest
 * `task_chat` part for that chat, a task card included, when it is a question
 * or approval card that shows that wait. A card names what it shows; one from
 * before names nothing and shows what was asked by its time, so it counts when
 * said no earlier than the wait's own second. A task chat whose newest part is
 * anything else is left out, and its owner answers in the task chat.
 * `messages` come in the order said.
 */
export function cardMessagesOf(
  messages: readonly { id: string; content: string; createdAt: Date }[],
  /** Each waiting task chat, and the wait it holds now. */
  waits: ReadonlyMap<string, ConciergeOpenWait>,
): Map<string, string> {
  const newest = new Map<string, { messageId: string; shows: boolean }>();
  for (const message of messages) {
    // Stored times are whole seconds: a card said in the wait's second shows it.
    const said = message.createdAt.getTime() + SAME_SECOND_MS - 1;
    let parts: unknown;
    try {
      parts = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type !== "task_chat" || typeof record.chatId !== "string") continue;
      const wait = waits.get(record.chatId);
      if (!wait) continue;
      const waitedOn = record.waitedOn as TaskChatWaitedOn | undefined;
      const shows = showsAsk(record) && (waitedOn ? showsWait(waitedOn, wait) : said >= wait.since);
      newest.set(record.chatId, { messageId: message.id, shows });
    }
  }
  return new Map(
    [...newest].flatMap(([chatId, { messageId, shows }]) => (shows ? [[chatId, messageId]] : [])),
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
/**
 * `card` with `closed` filled in from its task `row`: an open card of a task
 * that ended is closed, except an expired question, which still takes an answer.
 */
function closedBy<C extends Extract<TaskCard, { kind: "question" | "approval" }>>(
  card: C,
  row: ConciergeTaskRow | undefined,
): C {
  const open = !card.outcome && !(card.kind === "question" && card.expired);
  return { ...card, closed: open && row?.endedAt != null };
}

/** The approval as a card draws it; `row` says whether its task ended. */
export function approvalCard(
  approval: AskedApproval,
  row: ConciergeTaskRow | undefined,
): Extract<TaskCard, { kind: "approval" }> {
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
  return closedBy(
    {
      kind: "approval",
      id: approval.id,
      title,
      ...(typeof payload.actionName === "string" ? { actionName: payload.actionName } : {}),
      ...(payload.preview !== undefined ? { preview: payload.preview } : {}),
      since: approval.since,
      ...(outcome ? { outcome } : {}),
    },
    row,
  );
}

/** The question as a card draws it; `row` says whether its wait expired and whether its task ended. */
export function questionCard(
  question: AskedQuestion,
  row: ConciergeTaskRow | undefined,
  waitExpiry: number,
): Extract<TaskCard, { kind: "question" }> {
  const outcome = questionOutcome(question);
  const expiredAt = row?.expiredWaitAt?.getTime();
  // Every item said by an ended wait's deadline was part of it (tasks.ts currentWait).
  const expired = !outcome && expiredAt !== undefined && question.since <= expiredAt + waitExpiry;
  return closedBy(
    {
      kind: "question",
      id: question.id,
      messageId: question.messageId,
      render: question.render,
      since: question.since,
      expired,
      ...(outcome ? { outcome } : {}),
    },
    row,
  );
}

/**
 * The card a task card said at `at` shows when its part names no item (a
 * part from before `waitedOn`): the newest question or approval its task
 * chat had asked by then, or `unavailable` when it had none.
 */
export function cardAt(
  asked: TaskChatCards | undefined,
  at: number,
  row: ConciergeTaskRow | undefined,
  waitExpiry: number,
): TaskCard {
  // Stored times are whole seconds: what was asked in the card's own second
  // counts, and nothing from the second after.
  const by = Math.floor(at / SAME_SECOND_MS) * SAME_SECOND_MS + SAME_SECOND_MS - 1;
  const question = asked?.questions.filter((each) => each.since <= by).at(-1);
  const approval = asked?.approvals
    .filter((each) => each.since <= by)
    .sort((a, b) => a.since - b.since)
    .at(-1);
  if (approval && (!question || approval.since > question.since))
    return approvalCard(approval, row);
  if (question) return questionCard(question, row, waitExpiry);
  return { kind: "unavailable" };
}

/** The item `waitedOn` names, as its card now reads, or `unavailable` when the chat has no such item. */
function cardOf(
  asked: TaskChatCards | undefined,
  waitedOn: TaskChatWaitedOn,
  row: ConciergeTaskRow | undefined,
  waitExpiry: number,
): TaskCard {
  if (waitedOn.kind === "approval") {
    const approval = asked?.approvals.find((each) => each.id === waitedOn.id);
    return approval ? approvalCard(approval, row) : { kind: "unavailable" };
  }
  const question = asked?.questions.find(
    (each) => each.id === waitedOn.id && each.messageId === waitedOn.messageId,
  );
  return question ? questionCard(question, row, waitExpiry) : { kind: "unavailable" };
}

/**
 * `messages` with the card of each task card filled in, read once for the
 * whole page. A message with none comes back as it was; a page whose read
 * fails shows its cards as unavailable rather than failing.
 */
export async function withTaskCards<
  T extends { role: string; content: string; createdAt: Date | string },
>(
  sources: TaskCardSources,
  messages: T[],
  /**
   * The owner of the private Concierge chat the messages are in: a card
   * shows only that owner's own task chats. Null for any other chat, whose
   * cards all show as unavailable, since others may read it.
   */
  owner: string | null,
): Promise<T[]> {
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
      // A part can name any chat. Only a task chat of the reader's own shows
      // what it asked: another owner's, or a chat with no task, shows none.
      const row = rows.get(part.chatId);
      const own = owner !== null && row !== undefined && (row.ownerKey ?? GUARDIAN_OWNER) === owner;
      const card: TaskCard =
        failed || !own
          ? { kind: "unavailable" }
          : part.waitedOn
            ? cardOf(asked.get(part.chatId), part.waitedOn, row, sources.waitExpiry)
            : // A card from before `show` shows what its task waits on now.
              cardAt(
                asked.get(part.chatId),
                part.show === undefined ? Number.POSITIVE_INFINITY : at,
                row,
                sources.waitExpiry,
              );
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
    return approval ? approvalCard(approval, row) : null;
  }
  // The newest card asked under that id: a later turn can ask again under it.
  const question = asked?.questions.filter((each) => each.id === item.id).at(-1);
  return question ? questionCard(question, row, sources.waitExpiry) : null;
}

/**
 * The open cards of task chat `chatId`, as they now read: its questions with
 * no answer, and with `approvals` its approvals with no decision. A wait's
 * expiry settles the questions; the task ending or starting again settles both.
 */
export async function openCards(
  sources: TaskCardSources,
  chatId: string,
  { approvals = false }: { approvals?: boolean } = {},
): Promise<ChatCardSettledEvent["card"][]> {
  const [asked, [row]] = await Promise.all([
    sources.taskCardsOf([chatId]).then((cards) => cards.get(chatId)),
    sources.findBySessions([chatId]),
  ]);
  const questions = (asked?.questions ?? [])
    .filter((question) => !question.output)
    .map((question) => questionCard(question, row, sources.waitExpiry));
  if (!approvals) return questions;
  const open = (asked?.approvals ?? [])
    .map((approval) => approvalCard(approval, row))
    .filter((card) => !card.outcome);
  return [...questions, ...open];
}
