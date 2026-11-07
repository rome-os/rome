import { Navigate, useLocation } from "react-router-dom";
import { useConciergeChat } from "@/hooks/use-concierge";
import { MAIN_CHAT_PATH } from "@/lib/chat-session";
import { FreeGrid } from "./FreeGrid";

/** The old address of the main Concierge chat. Search and state, such as a draft, ride along. */
export function MainChatRedirect() {
  const { search, state } = useLocation();
  return <Navigate to={{ pathname: MAIN_CHAT_PATH, search }} state={state} replace />;
}

export default function FreePage() {
  const location = useLocation();
  const hideSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";
  // `/message` names no chat: it is the signed-in person's main Concierge chat,
  // whose id is the guardian's fixed one or a visitor's own, so the server says.
  const onMainChat = location.pathname === MAIN_CHAT_PATH;
  const main = useConciergeChat();
  if (onMainChat && main.loading) return null;

  return (
    // Plain div: RomeShellLayout owns the `main` landmark. `hideSidebar` drops
    // the sidebar but keeps the layout, so this is nested either way.
    <div
      className={`flex min-h-0 flex-col overflow-hidden ${
        hideSidebar
          ? "h-[var(--rome-viewport-height)] pt-safe"
          : "h-[var(--rome-mobile-content-height)] md:h-[var(--rome-viewport-height)]"
      }`}
    >
      <FreeGrid sessionId={onMainChat ? (main.chatId ?? undefined) : undefined} />
    </div>
  );
}
