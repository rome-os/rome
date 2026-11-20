// Test fixtures for the Concierge's tasks: a task is its task chat, so making
// one makes the chat (named, owned, marked as a task chat) and its row.

import type {
  ConciergeTaskRow,
  ConciergeTasksRepository,
} from "../db/repositories/concierge-tasks.js";
import { TASK_CHAT_TRIGGER_KIND } from "../webchat/privacy.js";
import type { WebChatRepository } from "../webchat/repository.js";

export interface TaskChatInput {
  /** The task chat's id, which is the task's id. Made up when left out. */
  id?: string;
  /** The task chat's name, which is the task's title. */
  title: string;
  /** The Concierge chat it reports to. Left out or null is the owner's main chat. */
  chatId?: string | null;
  /** Whose Concierge it is. Left out is the guardian's. */
  ownerKey?: string | null;
  /** A message of the Concierge chat it points to, by key. */
  sourceMessageId?: string | null;
}

let counter = 0;

/** Makes a task chat and its task, and answers the task as the repository reads it. */
export async function makeTask(
  {
    chats,
    repo,
  }: {
    chats: Pick<WebChatRepository, "createSession" | "setSessionTrigger">;
    repo: ConciergeTasksRepository;
  },
  input: TaskChatInput,
): Promise<ConciergeTaskRow> {
  const id = input.id ?? `task-chat-${++counter}`;
  await chats.createSession(
    id,
    input.title,
    undefined,
    undefined,
    null,
    undefined,
    null,
    "webchat",
    null,
    {
      ownerKey: input.ownerKey ?? null,
    },
  );
  await chats.setSessionTrigger(id, {
    triggerKind: TASK_CHAT_TRIGGER_KIND,
    triggerName: input.title,
  });
  return repo.create(id, {
    chatId: input.chatId ?? null,
    ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
  });
}
