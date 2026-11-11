import { createContext, useContext } from "react";

/**
 * Whether the transcript's messages show the action row under them: the
 * time, copy, Reply, Share and feedback. The public share page turns it off,
 * so a visitor reads the conversation alone.
 */
const MessageActionsContext = createContext(true);

export const MessageActionsProvider = MessageActionsContext.Provider;

export function useMessageActions(): boolean {
  return useContext(MessageActionsContext);
}
