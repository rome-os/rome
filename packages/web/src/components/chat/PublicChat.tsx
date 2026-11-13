import { useMemo } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildChatView, buildRows, type AgentIdentity } from "@/components/chat/chat-view";
import { MessageList, type BlockActions } from "@/components/chat/MessageList";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { PublicTaskChatContext } from "@/components/chat/entries/TaskChatCard";
import { MessageActionsProvider } from "@/components/chat/message-actions";
import {
  READ_ONLY_WIDGET_HOST,
  WidgetHostContext,
} from "@/components/chat/entries/widget-ui/turn-fields";
import type { ChatMessage } from "@/lib/chat-types";

// The main agent's name on the public feed: the name the chat showed for it,
// frozen at share time. An older share without one shows "Rome".
const FALLBACK_AGENT_NAME = "Rome";

const NO_OP = () => {};

export interface PublicChatProps {
  // The flat snapshot messages, each tagged with its own sessionId.
  messages: ChatMessage[];
  mainSessionId: string;
  /** The name the chat showed for its main agent. */
  agentName?: string;
}

// A login-free, read-only rendering of a shared chat. Reuses the exact
// chat-view → MessageList pipeline as the live /chat, minus the composer,
// streaming, and any guardian-only affordance. No new turns can be sent.
// A share shows messages only, never the work behind them: a trace row an
// older share still holds is skipped, so no trace panel opens.
export function PublicChat({ messages, mainSessionId, agentName }: PublicChatProps) {
  const mainIdentity = useMemo<AgentIdentity>(
    () => ({ name: agentName || FALLBACK_AGENT_NAME, iconUrl: null }),
    [agentName],
  );

  // Group the flat snapshot back into the per-session map chat-view expects.
  const messagesBySession = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      if (message.role === "trace") continue;
      const list = map.get(message.sessionId);
      if (list) list.push(message);
      else map.set(message.sessionId, [message]);
    }
    return map;
  }, [messages]);

  const view = useMemo(
    () => buildChatView(messagesBySession, mainSessionId, mainIdentity),
    [messagesBySession, mainSessionId, mainIdentity],
  );

  const rows = useMemo(
    () =>
      buildRows(view.displayMessages, view.identityBySession, mainIdentity, {
        runningTurnId: null,
        isStreaming: false,
      }),
    [view, mainIdentity],
  );

  // Read-only: inline app cards render, but submit/dismiss are inert.
  const actions = useMemo<BlockActions>(
    () => ({
      onApprovalResolved: NO_OP,
      onSubmitAppComponent: NO_OP,
      onDismissAppComponent: NO_OP,
      interactionResults: view.interactionResults,
    }),
    [view.interactionResults],
  );

  // No one is signed in here: task chat cards show their title only, and
  // messages show no time or actions.
  return (
    <PublicTaskChatContext.Provider value>
      <MessageActionsProvider value={false}>
        <WidgetHostContext.Provider value={READ_ONLY_WIDGET_HOST}>
          <TooltipProvider delayDuration={150}>
            {/* Fills the column under the share page's header, and keeps the last
            message clear of the screen's bottom edge. */}
            <div className="@container/chat relative flex flex-1 pb-[calc(var(--rome-safe-area-bottom)+2.5rem)]">
              <div className="relative flex min-w-0 flex-1 flex-col">
                <MessageList
                  rows={rows}
                  live={{
                    isStreaming: false,
                    runningTurnId: null,
                    snapshot: null,
                    textStore: EMPTY_LIVE_TEXT,
                    identity: mainIdentity,
                  }}
                  contentRef={NO_OP}
                  onOpenLiveTrace={NO_OP}
                  onOpenStoredTrace={NO_OP}
                  actions={actions}
                />
              </div>
            </div>
          </TooltipProvider>
        </WidgetHostContext.Provider>
      </MessageActionsProvider>
    </PublicTaskChatContext.Provider>
  );
}
