import { useLocation } from "react-router-dom";
import { useConciergeChatId } from "@/hooks/use-concierge";
import { activeSessionFromPath } from "@/lib/chat-session";

/** The id of the chat open at the current route, the main Concierge chat's included. */
export function useActiveSessionId(): string | null {
  return activeSessionFromPath(useLocation().pathname, useConciergeChatId());
}
