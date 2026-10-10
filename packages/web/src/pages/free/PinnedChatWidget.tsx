import { useCallback } from "react";
import { ChatComponent } from "@/components/chat/ChatComponent";
import { useFreeCells } from "./use-free-cells";

/**
 * A chat card pinned to one session — the side-chat surface. Unlike the main
 * pane's ChatWidget it carries no workspace-store enrichment: the pinned
 * conversation follows no files and installs nothing.
 */
export function PinnedChatWidget({
  sessionId,
  placementId,
}: {
  sessionId: string;
  placementId: string;
}) {
  const { removeWidget } = useFreeCells();
  // A session deleted from the sidebar must not leave a blank card. This only
  // fires from a (re)load of the messages, so a stale card clears on the next
  // /chat reload rather than instantly.
  const handleNotFound = useCallback(() => removeWidget(placementId), [placementId, removeWidget]);
  return (
    <ChatComponent
      sessionId={sessionId}
      onSessionCreated={() => {}}
      onSessionNotFound={handleNotFound}
    />
  );
}
