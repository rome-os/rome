import type { ConciergeTaskDto } from "@rome/api-types/concierge";

/**
 * Stops task `task` directly, as its owner asked from its card: Rome stops it
 * at once, and the Concierge hears of it. The card shows the stop once the
 * task's status changes. Answers whether Rome took it.
 */
export async function stopTask(task: Pick<ConciergeTaskDto, "id">): Promise<boolean> {
  try {
    const response = await fetch(`/api/concierge/tasks/${encodeURIComponent(task.id)}/stop`, {
      method: "POST",
      credentials: "include",
    });
    return response.ok;
  } catch {
    return false;
  }
}
