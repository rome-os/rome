import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { ConciergeGroup } from "@/components/chat/ConciergeGroup";
import { ConciergeTimeSeparator } from "@/components/chat/ConciergeTimeSeparator";
import type { BlockActions, LivePreview } from "@/components/chat/MessageList";
import { ModelSwitchNotice } from "@/components/chat/ModelSwitchNotice";
import type { ChatRow } from "@/components/chat/chat-view";
import { buildConciergeItems } from "@/components/chat/concierge-groups";
import { useBubbleArrivals } from "@/components/chat/use-bubble-arrivals";

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

/**
 * The Concierge chat's transcript: the guardian's bubbles, the agent's
 * messages, and a typing indicator while a turn runs. It shows no trace, turn
 * summary, live activity, or live text: the agent's text is private, and what
 * it says arrives as messages.
 */
export function ConciergeTranscript({
  rows,
  live,
  actions,
  contentRef,
  feedback = false,
}: {
  rows: ChatRow[];
  live: LivePreview;
  actions: BlockActions;
  contentRef: (node: HTMLElement | null) => void;
  /** Shows the feedback buttons under each settled turn. */
  feedback?: boolean;
}) {
  const runningTurnId = live.isStreaming ? live.runningTurnId : null;
  const items = useMemo(
    () => buildConciergeItems(rows, { typing: live.isStreaming }),
    [rows, live.isStreaming],
  );
  const arrival = useBubbleArrivals(
    items.flatMap((item) => (item.kind === "group" ? item.entries.map((e) => e.message.id) : [])),
  );
  return (
    // Padding outside, width cap inside: the composer floor's geometry, so the
    // messages and the composer share both edges at every width. The inner
    // element is the container that bubble controls measure their width against.
    <div className="flex-1 px-3 pt-4 md:px-6">
      <div
        ref={contentRef}
        data-chat-transcript
        data-concierge-transcript
        className="@container mx-auto flex max-w-5xl flex-col gap-4 pb-4"
        role="log"
        aria-relevant="additions"
        aria-busy={live.isStreaming || undefined}
      >
        {items.map((item) => {
          if (item.kind === "separator")
            return <ConciergeTimeSeparator key={item.key} at={item.at} />;
          if (item.kind === "notice")
            return <ModelSwitchNotice key={item.key} model={item.model} className="mb-0" />;
          return (
            <ConciergeGroup
              key={item.key}
              group={item}
              actions={actions}
              runningTurnId={runningTurnId}
              feedback={feedback}
              arrival={arrival}
              typing={<TypingBubble />}
            />
          );
        })}
      </div>
    </div>
  );
}
