import type { ConciergeTaskAction, ConciergeTaskDto } from "@rome/api-types/concierge";
import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";
import { postSessionTurnJson } from "@/lib/chat-api";
import { randomUUID } from "@/lib/random-uuid";
import { beginPending, failPending } from "./task-pending";

/** How much of a row's id names it when another row has the same title. */
const SHORT_ID_LENGTH = 6;

/**
 * What a panel button says to the Concierge, in the guardian's language: the
 * action and the row's title, as the guardian would type it. A row that shares
 * its title with another open row also names its short id, so the Concierge
 * can tell them apart.
 */
export function pressText(
  t: (key: string, options: Record<string, string>) => string,
  action: ConciergeTaskAction,
  task: Pick<ConciergeTaskDto, "id" | "title">,
  rows: ReadonlyArray<Pick<ConciergeTaskDto, "id" | "title" | "archivedAt">>,
): string {
  const text = t(`concierge.tasks.actionText.${action}`, { title: task.title });
  const clash = rows.some(
    (row) => row.id !== task.id && row.archivedAt === null && row.title === task.title,
  );
  return clash
    ? `${text} ${t("concierge.tasks.actionText.withId", { id: task.id.slice(0, SHORT_ID_LENGTH) })}`
    : text;
}

/**
 * Presses a panel button: it sends the Concierge the same message the guardian
 * could type, and the Concierge does the work and writes the row. The priority
 * is `next`: the message joins a running turn or waits for it, and never cuts it
 * off.
 */
export async function sendTaskAction(
  task: Pick<ConciergeTaskDto, "id" | "updatedAt">,
  action: ConciergeTaskAction,
  text: string,
): Promise<void> {
  // The message keeps this id, so the press can be matched with the turn that takes it in.
  const inputId = randomUUID();
  beginPending(task.id, action, task.updatedAt, inputId);
  try {
    const sent = await postSessionTurnJson(CONCIERGE_CHAT_ID, { inputId, text, priority: "next" });
    if (!sent.ok) failPending(task.id);
  } catch {
    failPending(task.id);
  }
}
