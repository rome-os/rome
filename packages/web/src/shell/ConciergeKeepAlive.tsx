import { Activity, type ComponentType, useEffect, useMemo, useState } from "react";
import { type Location, Route, Routes, useLocation } from "react-router-dom";
import { CONCIERGE_CHAT_ID, isConciergePath, useConciergeChat } from "@/hooks/use-concierge";
import { useSessionDeleted } from "@/lib/session-deleted";

type ConciergePageComponent = ComponentType<{ active: boolean }>;

// The page lives in the chat's own chunk. It loads while the guardian is on a
// chat, so that opening the Concierge finds it ready: a `lazy` component would
// suspend on its first render, and React holds a revealed fallback back for
// about 300 ms.
let loadedPage: ConciergePageComponent | null = null;
let loading: Promise<void> | null = null;
function loadConciergePage(): Promise<void> {
  loading ??= import("@/pages/free/FreePage").then((module) => {
    loadedPage = module.ConciergePage;
  });
  return loading;
}

/**
 * "kept": the Concierge page is mounted, shown or hidden.
 * "retired": its chat was deleted while the page was on screen; it stays gone
 * until the guardian leaves the page, so the delete does not mount it again.
 */
type Phase = "idle" | "kept" | "retired";

function sameAddress(a: Location, b: Location): boolean {
  return (
    a.pathname === b.pathname && a.search === b.search && a.hash === b.hash && a.state === b.state
  );
}

/**
 * Keeps the Concierge chat mounted once it has been opened, so coming back to
 * it from another chat or page shows it as it was left, scrolled where it was,
 * with the composer's draft, and with nothing to load.
 *
 * It sits beside the router's outlet, not in a route, so a route change does
 * not unmount it. An `<Activity>` hides it with `display: none` and tears down
 * its effects (live events, polls, observers) while the state stays; the chat
 * catches up when it is shown again (see `Chat`). Only the Concierge is kept:
 * every other chat mounts and unmounts with its route, as it always did.
 *
 * It is mounted on the first visit, not at startup, and let go when the
 * Concierge is turned off, when its chat is deleted, and with the shell on
 * sign-out.
 *
 * Hidden, the page sees the location it was left at. A router location that
 * changed under it would render the whole transcript again, for a page nobody
 * looks at, on every navigation.
 */
export function ConciergeKeepAlive() {
  const { enabled } = useConciergeChat();
  const location = useLocation();
  const onConcierge = enabled && isConciergePath(location.pathname);
  const onChat = location.pathname === "/chat" || location.pathname.startsWith("/chat/");
  const [Page, setPage] = useState<ConciergePageComponent | null>(() => loadedPage);
  useEffect(() => {
    if (Page || !enabled || !onChat) return;
    let live = true;
    void loadConciergePage().then(() => {
      if (live) setPage(() => loadedPage);
    });
    return () => {
      live = false;
    };
  }, [Page, enabled, onChat]);
  const [seen, setSeen] = useState(location);
  const [phase, setPhase] = useState<Phase>("idle");
  // Derived while rendering, so the page never shows a frame it should not.
  // Coming back to the same address keeps the location it was left with: a
  // new entry in the history has a new key, and the page would render again for it.
  if (onConcierge && !sameAddress(seen, location)) setSeen(location);
  if (phase === "idle" && onConcierge) setPhase("kept");
  else if (phase === "kept" && !enabled) setPhase("idle");
  else if (phase === "retired" && !onConcierge) setPhase("idle");
  useSessionDeleted((sessionId) => {
    if (sessionId === CONCIERGE_CHAT_ID) setPhase("retired");
  });

  const page = useMemo(() => (Page ? <Page active={onConcierge} /> : null), [Page, onConcierge]);
  if (phase !== "kept" || !page) return null;
  return (
    <Activity mode={onConcierge ? "visible" : "hidden"}>
      <Routes location={seen}>
        <Route path="*" element={page} />
      </Routes>
    </Activity>
  );
}
