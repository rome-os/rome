import { memo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { CONCIERGE_CHAT_ID, isConciergePath, useConciergeChat } from "@/hooks/use-concierge";
import { FreeGrid } from "./FreeGrid";

function ChatPageFrame({ children }: { children: ReactNode }) {
  const location = useLocation();
  const hideSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";

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
      {children}
    </div>
  );
}

export default function FreePage() {
  const location = useLocation();
  const concierge = useConciergeChat();
  // The Concierge chat has a page of its own, kept alive by ConciergeKeepAlive
  // so that coming back to it costs nothing. Its route draws nothing; the
  // settings still loading, it is not known yet whether the page is the Concierge's.
  if (isConciergePath(location.pathname) && (concierge.enabled || concierge.settingsLoading)) {
    return null;
  }
  return (
    <ChatPageFrame>
      <FreeGrid />
    </ChatPageFrame>
  );
}

/**
 * The Concierge chat's page, mounted by ConciergeKeepAlive whatever the route.
 * `active` is false while another page is on screen.
 */
export const ConciergePage = memo(function ConciergePage({ active }: { active: boolean }) {
  return (
    <ChatPageFrame>
      <FreeGrid sessionId={CONCIERGE_CHAT_ID} active={active} />
    </ChatPageFrame>
  );
});
