import { Fragment, memo, useMemo, type ReactNode } from "react";
import { ChatBubble } from "@/components/chat/ChatBubble";
import Markdown from "@/components/chat/ChatMarkdown";
import { ConciergeBubble } from "@/components/chat/ConciergeBubble";
import { UserMessageBubble } from "@/components/chat/UserMessageBubble";
import { renderFlatEntries } from "@/components/chat/entries";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { BlockActions } from "@/components/chat/MessageList";
import { userMessageText } from "@/components/chat/chat-view";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import type { ConciergeEntry, ConciergeItem } from "@/components/chat/concierge-groups";
import { isSettledUserMessage } from "@/components/chat/reply/reply-source";
import type { ArrivalProps } from "@/components/chat/use-bubble-arrivals";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

// The same bubble reparses nothing while the transcript re-renders around it;
// a message's identity changes on every reload, so compare what it shows.
const GuardianBubble = memo(
  function GuardianBubble({ msg, arrival }: { msg: ChatMessage; arrival?: number }) {
    const text = useMemo(() => userMessageText(msg.content), [msg.content]);
    return (
      <div
        data-timeline-anchor={msg.id}
        className="flex min-w-0 max-w-full flex-col items-end"
        data-arrival={arrival}
      >
        <ConciergeBubble
          side="end"
          copyText={text}
          createdAt={msg.createdAt}
          feedbackTurn={null}
          reply={
            isSettledUserMessage(msg)
              ? {
                  messageId: msg.id,
                  sessionId: msg.sessionId,
                  author: "guardian",
                  name: msg.sender?.name ?? undefined,
                  text,
                }
              : null
          }
        >
          <UserMessageBubble msg={msg} text={text} own />
        </ConciergeBubble>
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState &&
    prev.arrival === next.arrival,
);

// Each `say` call is its own message, so each text part is its own bubble. A
// long message is the same bubble with markdown that reads as a document.
// Cards render as they do anywhere.
function AgentEntry({
  entry,
  actions,
  rateable,
  arrival,
}: {
  entry: ConciergeEntry;
  actions: BlockActions;
  arrival: ArrivalProps;
  /** Whether the entry's turn is over and feedback is on. */
  rateable: boolean;
}) {
  const { message } = entry;
  const parts = parseMessageEntries(message);
  const lastText = parts.findLastIndex((part) => part.type === "text" && part.content.trim());
  // A quote of this message jumps to its first bubble.
  const firstBubble = parts.findIndex(
    (part) => part.type === "task_chat" || (part.type === "text" && part.content.trim()),
  );
  const replyTo = (text: string): ReplySource => ({
    messageId: message.id,
    sessionId: message.sessionId,
    author: "agent",
    text,
  });
  return parts.map((part, index) => {
    const key = `${message.id}:${index}`;
    if (part.type === "task_chat") {
      // The card is a message of its own, so it takes the same details as a bubble.
      return (
        <ConciergeBubble
          key={key}
          side="start"
          copyText=""
          createdAt={message.createdAt}
          feedbackTurn={null}
          reply={replyTo(`[Task chat] ${part.title} (chat ${part.chatId})`)}
          anchorId={index === firstBubble ? message.id : undefined}
        >
          {renderFlatEntries([part], {
            ...actions,
            sessionId: message.sessionId,
            turnId: message.turnId ?? undefined,
          })}
        </ConciergeBubble>
      );
    }
    if (part.type !== "text") {
      return (
        <Fragment key={key}>
          {renderFlatEntries([part], {
            ...actions,
            sessionId: message.sessionId,
            turnId: message.turnId ?? undefined,
          })}
        </Fragment>
      );
    }
    if (!part.content.trim()) return null;
    const long = "format" in part && part.format === "long";
    return (
      <ConciergeBubble
        key={key}
        side="start"
        copyText={part.content}
        createdAt={message.createdAt}
        feedbackTurn={
          rateable && entry.endsTurn && index === lastText && message.turnId
            ? { sessionId: message.sessionId, turnId: message.turnId }
            : null
        }
        reply={replyTo(part.content)}
        anchorId={index === firstBubble ? message.id : undefined}
      >
        <ChatBubble tone="received" {...arrival(message.id)}>
          <Markdown className="min-w-0 text-foreground" compact={false} preserveSoftBreaks={!long}>
            {part.content}
          </Markdown>
        </ChatBubble>
      </ConciergeBubble>
    );
  });
}

/**
 * One stretch of messages from a single sender, packed close together. The
 * guardian's bubbles align to the end, the agent's to the start. `typing` is
 * the agent's typing bubble, drawn after its messages.
 */
export function ConciergeGroup({
  group,
  actions,
  runningTurnId,
  feedback,
  arrival,
  typing,
}: {
  group: Extract<ConciergeItem, { kind: "group" }>;
  actions: BlockActions;
  runningTurnId: string | null;
  feedback: boolean;
  /** Marks the bubbles that arrived while the transcript is open. */
  arrival: ArrivalProps;
  typing: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        group.sender === "guardian" ? "items-end" : "items-start",
      )}
    >
      {group.entries.map((entry) =>
        group.sender === "guardian" ? (
          <GuardianBubble
            key={entry.message.id}
            msg={entry.message}
            arrival={arrival(entry.message.id)["data-arrival"]}
          />
        ) : (
          <AgentEntry
            key={entry.message.id}
            entry={entry}
            actions={actions}
            rateable={feedback && (!runningTurnId || entry.message.turnId !== runningTurnId)}
            arrival={arrival}
          />
        ),
      )}
      {group.typing ? typing : null}
    </div>
  );
}
