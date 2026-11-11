import { useCallback, useMemo, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  TraceDrawer,
  traceDrawerContentInsetClass,
  type TraceDrawerTarget,
} from "@/components/agent-trace/TraceDrawer";
import { buildChatView, buildRows, type AgentIdentity } from "@/components/chat/chat-view";
import { renderFlatEntries, renderSingleEntry } from "@/components/chat/entries";
import { MessageList, type BlockActions } from "@/components/chat/MessageList";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import type { ChatMessage } from "@/lib/chat-types";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";

// The main agent's name on the public feed: the name the chat showed for it,
// frozen at share time. An older share without one shows "Rome".
const FALLBACK_AGENT_NAME = "Rome";

const NO_OP = () => {};

export interface PublicChatProps {
  // The flat snapshot messages, each tagged with its own sessionId.
  messages: ChatMessage[];
  mainSessionId: string;
  // Trace message id → prebuilt TraceSnapshot, served straight to the drawer.
  traces: Record<string, TraceSnapshot>;
  /** The name the chat showed for its main agent. */
  agentName?: string;
  hasApps?: boolean;
}

// A login-free, read-only rendering of a shared chat. Reuses the exact
// chat-view → MessageList pipeline as the live /chat, minus the composer,
// streaming, and any guardian-only affordance. No new turns can be sent.
export function PublicChat({
  messages,
  mainSessionId,
  traces,
  agentName,
  hasApps = false,
}: PublicChatProps) {
  const mainIdentity = useMemo<AgentIdentity>(
    () => ({ name: agentName || FALLBACK_AGENT_NAME, iconUrl: null }),
    [agentName],
  );
  const [traceDrawerTarget, setTraceDrawerTarget] = useState<TraceDrawerTarget | null>(null);

  // Group the flat snapshot back into the per-session map chat-view expects.
  const messagesBySession = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const message of messages) {
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

  // Resolve a stored trace from the frozen snapshot — no network, no auth.
  const loadStoredTrace = useCallback(
    async (messageId: string): Promise<TraceSnapshot | null> => traces[messageId] ?? null,
    [traces],
  );

  return (
    <TooltipProvider delayDuration={150}>
      {/* Fills the column under the share page's header. */}
      <div className="@container/chat relative flex flex-1">
        {/* Mirror Chat.tsx: in the wide / no-apps layout (@5xl/chat) the trace
            drawer is `fixed` and out of flow, so reserve its 480px here to keep
            the messages clear of it. */}
        <div
          className={`relative flex min-w-0 flex-1 flex-col @5xl/chat:transition-[width] @5xl/chat:duration-200 @5xl/chat:ease-out ${traceDrawerContentInsetClass(
            traceDrawerTarget !== null,
            hasApps,
          )}`}
        >
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
            onOpenStoredTrace={setTraceDrawerTarget}
            actions={actions}
          />
        </div>
        <TraceDrawer
          target={traceDrawerTarget}
          onClose={() => setTraceDrawerTarget(null)}
          hasApps={hasApps}
          loadStoredTrace={loadStoredTrace}
          allowSubagentUsage={false}
          readOnly
          renderInlineBlock={(block, key) =>
            renderSingleEntry(block, key, {
              onApprovalResolved: NO_OP,
              compact: true,
            })
          }
          renderRunBlocks={(blocks, live) =>
            renderFlatEntries(blocks, {
              onApprovalResolved: NO_OP,
              compact: true,
              live,
            })
          }
        />
      </div>
    </TooltipProvider>
  );
}
