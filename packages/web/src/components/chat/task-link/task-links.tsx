// What a Concierge chat's task links show: each task chat's live name and
// status (docs/domains/chats.md#task-link). The links in a transcript register
// the task chats they name, and one read answers for all of them. A task may
// come from any of the owner's Concierge chats. The chat's `tasks_changed`
// events, which fire on any of its owner's tasks, read it again, so a chip
// moves as its task chat runs.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { z } from "zod";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import {
  TASK_LIST_CHANGED_EVENT,
  type TaskLinkDto,
  type TaskLinksResponse,
} from "@rome/api-types/task-list";
import { useLiveEvents } from "@/hooks/use-live-events";
import { fetchJson } from "@/lib/fetch-json";

const taskLinksKey = (chatId: string) => ["chat-task-links", chatId] as const;
const changedSchema = z.object({ chatId: z.string(), follows: z.literal(true).optional() });

interface TaskLinksValue {
  /** Asks to read task chat `id`'s status. */
  register: (id: string) => void;
  /** The task chats the last read asked about, and what it found. */
  read: { asked: ReadonlySet<string>; found: ReadonlyMap<string, TaskLinkDto> } | null;
}

const TaskLinksContext = createContext<TaskLinksValue | null>(null);

/**
 * Reads the status of the task links under it. Only a Concierge chat's
 * transcript sets it up: a task link anywhere else reads as its text.
 */
export function TaskLinksProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ids, setIds] = useState<readonly string[]>([]);
  const register = useCallback(
    (id: string) => setIds((current) => (current.includes(id) ? current : [...current, id].sort())),
    [],
  );
  const asked = ids.join(",");
  const { data } = useQuery({
    queryKey: [...taskLinksKey(chatId), asked],
    enabled: ids.length > 0,
    // The chips keep what they show while a new id is read in.
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const response = await fetchJson<TaskLinksResponse>(
        `/api/chats/${encodeURIComponent(chatId)}/task-links?ids=${encodeURIComponent(asked)}`,
        { fallback: "Failed to read the task links" },
      );
      return {
        asked: new Set(ids),
        found: new Map(response.tasks.map((task) => [task.id, task] as const)),
      };
    },
  });
  const reread = () => queryClient.invalidateQueries({ queryKey: taskLinksKey(chatId) });
  useLiveEvents(
    {
      topic: chatTasksTopicName(chatId),
      sseUrl: `/api/chats/${encodeURIComponent(chatId)}/tasks/events`,
    },
    { [TASK_LIST_CHANGED_EVENT]: { schema: changedSchema, fn: () => void reread() } },
    { onReconnect: () => void reread() },
  );
  const value = useMemo(() => ({ register, read: data ?? null }), [register, data]);
  return <TaskLinksContext.Provider value={value}>{children}</TaskLinksContext.Provider>;
}

/** What a task link shows: still reading, a task chat of this chat's owner, or none. */
export type TaskLinkState =
  | { state: "loading" }
  | { state: "found"; task: TaskLinkDto }
  | { state: "none" };

/**
 * Task chat `id`'s name and status as this chat's links show them. Outside a
 * Concierge chat, and for a task chat that is not this chat's owner's, or does
 * not exist, there is none: the link reads as its text.
 */
export function useTaskLink(id: string): TaskLinkState {
  const links = useContext(TaskLinksContext);
  const register = links?.register;
  useEffect(() => register?.(id), [register, id]);
  if (!links) return { state: "none" };
  const task = links.read?.found.get(id);
  if (task) return { state: "found", task };
  return links.read?.asked.has(id) ? { state: "none" } : { state: "loading" };
}

/** {@link TaskLinksProvider} for a Concierge chat, and nothing around any other chat. */
export function TaskLinksScope({
  chatId,
  children,
}: {
  chatId: string | null;
  children: ReactNode;
}) {
  return chatId ? (
    <TaskLinksProvider chatId={chatId}>{children}</TaskLinksProvider>
  ) : (
    <>{children}</>
  );
}
