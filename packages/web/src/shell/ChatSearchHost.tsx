import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { OPEN_CHAT_SEARCH_EVENT } from "@/lib/chat-search-events";
import { ChatSearchDialog } from "./ChatSearchDialog";

/**
 * The chat search dialog with the state that opens it. The shell mounts this
 * instead of holding the state itself: a state change renders the component
 * that owns it and everything it draws, and the shell draws the whole sidebar,
 * hundreds of chat rows that have nothing to do with the dialog. Navigating
 * closes it.
 */
export function ChatSearchHost() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_CHAT_SEARCH_EVENT, show);
    return () => window.removeEventListener(OPEN_CHAT_SEARCH_EVENT, show);
  }, []);
  return <ChatSearchDialog open={open} onOpenChange={setOpen} />;
}
