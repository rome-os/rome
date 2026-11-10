import { useMemo, useState } from "react";
import { z } from "zod";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { chatStatusTopic, useLiveEvents } from "@/hooks/use-live-events";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import {
  type ConciergeActivity,
  conciergeActivity,
  type TaskChatActivity,
} from "./concierge-activity";
import { tasksOfChat } from "./tasks";
import { useConciergeTasks } from "./use-concierge-tasks";

const sessionRunningSchema = z.object({ sessionId: z.string(), running: z.boolean() });

/**
 * What a Concierge chat's header shows it doing, from facts only: its own
 * streaming turn and the tool it is in, and whether the task chats it started
 * are running or wait on the guardian. A task chat's running state follows the
 * live `session_running` events, so it changes the moment the turn does.
 */
export function useConciergeActivity(input: {
  chatId: string | null;
  streaming: boolean;
  awaitingGuardian: boolean;
  snapshot: TraceSnapshot | null;
}): ConciergeActivity {
  const { chatId, streaming, awaitingGuardian, snapshot } = input;
  const enabled = chatId !== null;
  const { tasks } = useConciergeTasks({ enabled });
  const { sessions } = useChatSessions("active", undefined, { enabled });
  const [liveRunning, setLiveRunning] = useState<ReadonlyMap<string, boolean>>(new Map());

  useLiveEvents(
    chatStatusTopic,
    {
      session_running: {
        schema: sessionRunningSchema,
        fn: ({ sessionId, running }) =>
          setLiveRunning((prev) => {
            if (prev.get(sessionId) === running) return prev;
            const next = new Map(prev);
            next.set(sessionId, running);
            return next;
          }),
      },
    },
    { enabled },
  );

  const taskChats = useMemo<TaskChatActivity[]>(() => {
    const byId = new Map((sessions ?? []).map((session) => [session.id, session]));
    return tasksOfChat(tasks, chatId).flatMap((task) => {
      if (!task.chat || task.archivedAt !== null) return [];
      const session = byId.get(task.chat.id);
      const live = liveRunning.get(task.chat.id);
      const running = live ?? session?.running ?? false;
      return [
        {
          title: task.title,
          running,
          // A running turn has answered whatever waited.
          awaitingGuardian: !running && (session?.awaitingGuardian ?? false),
          updatedAt: task.updatedAt,
        },
      ];
    });
  }, [tasks, chatId, sessions, liveRunning]);

  return useMemo(
    () => conciergeActivity({ streaming, awaitingGuardian, snapshot, tasks: taskChats }),
    [streaming, awaitingGuardian, snapshot, taskChats],
  );
}
