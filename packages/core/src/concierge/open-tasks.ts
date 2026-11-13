// A Concierge chat's open tasks as a renewed session's first turn reads them,
// from the task list Rome keeps rather than from the model
// (docs/concepts/sessions.md#handoff).

import type { ConciergeService } from "./service.js";

/**
 * Chat `chatId`'s tasks that have not ended, one line each with its id,
 * title, status and when a check is due, or null when it has none or is no
 * Concierge chat. The status is the one Rome derives, as `task_list` reads it.
 */
export async function conciergeOpenTasks(
  service: Pick<ConciergeService, "conciergeChat" | "ownerOfChat" | "deps">,
  chatId: string,
): Promise<string | null> {
  if (!(await service.conciergeChat(chatId))) return null;
  const owner = await service.ownerOfChat(chatId);
  if (!owner) return null;
  const { tasks } = service.deps;
  const rows = (await tasks.repo.listForAgent(true)).filter(
    (task) => task.owner === owner && task.conciergeChat.id === chatId,
  );
  if (rows.length === 0) return null;
  const status = await tasks.statusOf(rows.map((task) => task.row));
  const open = rows.flatMap((task) => {
    const of = status.get(task.row.id);
    return of && of.status !== "ended" ? [{ ...task, status: of }] : [];
  });
  if (open.length === 0) return null;
  return open
    .map(({ row, chat, status: of }) =>
      [
        `- ${row.id} · ${row.title} · ${of.status}`,
        of.status === "later" && of.laterAt !== null && Number.isFinite(of.laterAt)
          ? ` · check due ${new Date(of.laterAt).toISOString()}`
          : "",
        chat ? ` · task chat ${chat.id}` : "",
        row.summary ? `\n  ${row.summary}` : "",
      ].join(""),
    )
    .join("\n");
}

/**
 * Who said chat `chatId`'s owner lines, as a handoff reads them: the guardian,
 * or a visitor by name. Null for no Concierge chat.
 */
export async function conciergeOwnerLabel(
  service: Pick<ConciergeService, "conciergeChat" | "ownerOfChat" | "owners">,
  chatId: string,
): Promise<string | null> {
  if (!(await service.conciergeChat(chatId))) return null;
  const owner = await service.ownerOfChat(chatId);
  if (!owner) return null;
  const profile = await service.owners.profileOf(owner);
  if (profile.role === "guardian") return profile.name ? `Guardian (${profile.name})` : "Guardian";
  return profile.name ? `Visitor (${profile.name})` : "Visitor";
}
