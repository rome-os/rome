import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { ConciergeGroup } from "@/components/chat/ConciergeGroup";
import { ConciergeTimeSeparator } from "@/components/chat/ConciergeTimeSeparator";
import { ConciergeUnreadDivider } from "@/components/chat/ConciergeUnreadDivider";
import type { BlockActions, LivePreview, ShareSelection } from "@/components/chat/MessageList";
import { LatestTaskChatsContext } from "@/components/chat/entries/render";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatEntry } from "@/lib/chat-types";
import { ModelSwitchNotice } from "@/components/chat/ModelSwitchNotice";
import type { ChatRow } from "@/components/chat/chat-view";
import { buildConciergeItems, showsTyping } from "@/components/chat/concierge-groups";
import { useBubbleArrivals } from "@/components/chat/use-bubble-arrivals";
import { useSimulatedTyping } from "@/components/chat/use-simulated-typing";

function TypingBubble() {
  const { t } = useTranslation("chat");
  return (
    <ChatBubble
      tone="received"
      className="flex h-10 items-center gap-1 py-0"
      role="status"
      aria-label={t("concierge.typing")}
    >
      <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" aria-hidden />
      <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" aria-hidden />
      <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" aria-hidden />
    </ChatBubble>
  );
}

// One element for every render: a typing bubble has no props, and a fresh one
// each time would defeat the memoized group that draws it.
const TYPING_BUBBLE = <TypingBubble />;

/**
 * The Concierge chat's transcript: the guardian's bubbles, the agent's
 * messages, and a typing indicator while a turn runs. It shows no trace, turn
 * summary, live activity, or live text: the agent's text is private, and what
 * it says arrives as messages.
 */
export function ConciergeTranscript({
  rows: allRows,
  live,
  selection,
  actions,
  contentRef,
  feedback = false,
  unreadFrom,
}: {
  rows: ChatRow[];
  live: LivePreview;
  /** Share mode: each bubble picks its turn, as a common chat's rows do. */
  selection?: ShareSelection;
  actions: BlockActions;
  contentRef: (node: HTMLElement | null) => void;
  /** Shows the feedback buttons under each settled turn. */
  feedback?: boolean;
  /** The id of the first message that was unread when the chat opened; a divider goes above it. */
  unreadFrom?: string | null;
}) {
  const runningTurnId = live.isStreaming ? live.runningTurnId : null;
  const simulated = useSimulatedTyping(allRows, live);
  const rows = simulated.rows;
  const typing = showsTyping(rows, live, simulated.holding);
  const items = useMemo(
    () => buildConciergeItems(rows, { typing, unreadFrom }),
    [rows, typing, unreadFrom],
  );
  const messageIds = useMemo(
    () =>
      items.flatMap((item) => (item.kind === "group" ? item.entries.map((e) => e.message.id) : [])),
    [items],
  );
  const latestTaskChats = useMemo(() => {
    const latestTaskChats = new Map<string, ChatEntry>();
    for (const item of items) {
      if (item.kind !== "group") continue;
      for (const entry of item.entries) {
        if (entry.message.role !== "assistant") continue;
        for (const part of parseMessageEntries(entry.message)) {
          if (part.type === "task_chat") latestTaskChats.set(part.chatId, part);
        }
      }
    }
    return latestTaskChats;
  }, [items]);
  const arrival = useBubbleArrivals(messageIds);
  return (
    // Padding outside, width cap inside: the composer floor's geometry, so the
    // messages and the composer share both edges at every width.
    <LatestTaskChatsContext.Provider value={latestTaskChats}>
      <div className="flex-1 px-3 pt-4 md:px-6">
        <div
          ref={contentRef}
          data-chat-transcript
          data-concierge-transcript
          className="@container mx-auto flex max-w-5xl flex-col gap-4 pb-4"
          role="log"
          aria-relevant="additions"
          aria-busy={typing || undefined}
        >
          {items.map((item) => {
            if (item.kind === "separator")
              return <ConciergeTimeSeparator key={item.key} at={item.at} />;
            if (item.kind === "unread") return <ConciergeUnreadDivider key={item.key} />;
            if (item.kind === "notice")
              return (
                <ModelSwitchNotice
                  key={item.key}
                  model={item.model}
                  quota={item.quota}
                  className="mb-0"
                />
              );
            return (
              <ConciergeGroup
                key={item.key}
                group={item}
                actions={actions}
                runningTurnId={runningTurnId}
                selection={selection}
                feedback={feedback}
                arrival={arrival}
                typing={TYPING_BUBBLE}
              />
            );
          })}
        </div>
      </div>
    </LatestTaskChatsContext.Provider>
  );
}
