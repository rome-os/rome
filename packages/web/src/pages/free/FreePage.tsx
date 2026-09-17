import { useLocation, useParams } from "react-router-dom";
import { FreeGrid } from "./FreeGrid";
import { useChatSessionName } from "@/hooks/use-chat-session-name";
import { useDocumentTitle } from "@/hooks/use-document-title";

export default function FreePage() {
  const location = useLocation();
  const hideSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";

  // `/chat/*` opens a session by id. The chat a guardian names is the one they
  // keep a tab on, so the name outranks the route's own title.
  const sessionId = useParams<{ "*"?: string }>()["*"]?.split("/")[0] ?? null;
  const sessionName = useChatSessionName(sessionId);
  useDocumentTitle(sessionName);

  return (
    // Plain div: RomeShellLayout owns the `main` landmark. `hideSidebar` drops
    // the sidebar but keeps the layout, so this is nested either way.
    <div
      className={`flex min-h-0 flex-col overflow-hidden ${
        hideSidebar ? "h-dvh pt-safe" : "h-[var(--rome-mobile-content-height)] md:h-dvh"
      }`}
    >
      <FreeGrid />
    </div>
  );
}
