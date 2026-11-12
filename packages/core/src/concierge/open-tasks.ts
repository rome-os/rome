// A Concierge chat's open tasks as a renewed session's first turn reads them,
// from the task list Rome keeps rather than from the model
// (docs/concepts/sessions.md#handoff).

import type { ConciergeService } from "./service.js";

/**
 * Chat `chatId`'s open task rows, one line each with its id, title, state and
 * what it waits on, or null when it has none or is no Concierge chat.
 */
export async function conciergeOpenTasks(
  service: Pick<ConciergeService, "conciergeChat" | "ownerOfChat" | "deps">,
  chatId: string,
): Promise<string | null> {
  if (!(await service.conciergeChat(chatId))) return null;
  const owner = await service.ownerOfChat(chatId);
  if (!owner) return null;
  const rows = (await service.deps.tasks.repo.listForAgent(false)).filter(
    (task) => task.owner === owner && task.conciergeChat.id === chatId,
  );
  if (rows.length === 0) return null;
  return rows
    .map(({ row, chat }) =>
      [
        `- ${row.id} · ${row.title} · ${row.state}`,
        row.waitingOn ? ` · waiting on ${row.waitingOn}` : "",
        chat ? ` · task chat ${chat.id}` : "",
        row.summary ? `\n  ${row.summary}` : "",
      ].join(""),
    )
    .join("\n");
}
