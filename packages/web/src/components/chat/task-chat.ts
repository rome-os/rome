import { createContext, useContext } from "react";
import type { ChatMessageSender } from "@rome/api-types/chat";

/** Whether the transcript is a task chat's (docs/domains/chats.md#task-chat). */
export const TaskChatContext = createContext(false);

/**
 * Whether a message was said by the Concierge in the task chat it started.
 * The Concierge is the only agent that says a task chat's prompts, as an
 * agent on no one's behalf. Anywhere else such a sender is another agent.
 */
export function useSaidByConcierge(sender: ChatMessageSender | undefined): boolean {
  const inTaskChat = useContext(TaskChatContext);
  return (
    inTaskChat &&
    sender?.kind === "automated" &&
    sender.sourceType === "agent" &&
    !sender.onBehalfOf
  );
}
