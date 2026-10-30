import { memo, useMemo, type ReactNode } from "react";
import type { ForwardedFrom } from "@rome/api-types/chat";
import { ChatBubble } from "@/components/chat/ChatBubble";
import Markdown from "@/components/chat/ChatMarkdown";
import { CollapsibleBubbleContent } from "@/components/chat/CollapsibleBubbleContent";
import { ConciergeBubble } from "@/components/chat/ConciergeBubble";
import { ForwardedChip } from "@/components/chat/ForwardedChip";
import { UserMessageBubble } from "@/components/chat/UserMessageBubble";
import { renderFlatEntries } from "@/components/chat/entries";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { BlockActions } from "@/components/chat/MessageList";
import { userMessageText } from "@/components/chat/chat-view";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import type { ConciergeEntry, ConciergeItem } from "@/components/chat/concierge-groups";
import { isSettledUserMessage } from "@/components/chat/reply/reply-source";
import type { ArrivalProps } from "@/components/chat/use-bubble-arrivals";
import type { ChatMessage, TranscriptPart } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

// The same bubble reparses nothing while the transcript re-renders around it;
// a message's identity changes on every reload, so compare what it shows.
const GuardianBubble = memo(
  function GuardianBubble({ msg, arrival }: { msg: ChatMessage; arrival?: number }) {
    const text = useMemo(() => userMessageText(msg.content), [msg.content]);
    // The bubble is a direct child of the group, so its width cap is a share
    // of the column, as the agent's is.
    return (
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
        anchorId={msg.id}
        arrival={arrival}
      >
        <UserMessageBubble msg={msg} text={text} own />
      </ConciergeBubble>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState &&
    prev.arrival === next.arrival,
);

// Core stores a text part's origin as it was written, so it is read as unknown.
function forwardedOrigin(value: unknown): ForwardedFrom | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { chatId, title } = value as Partial<ForwardedFrom>;
  return typeof chatId === "string" && typeof title === "string" ? { chatId, title } : undefined;
}

// The task chat a text part was forwarded from, when it carries one.
function originOf(part: TranscriptPart): ForwardedFrom | undefined {
  return part.type === "text" && "forwardedFrom" in part
    ? forwardedOrigin(part.forwardedFrom)
    : undefined;
}

// Each `say` call is its own message, so each text part is its own bubble. A
// long message is the same bubble with markdown that reads as a document, cut
// with a toggle when it is tall. A forwarded report is a bubble of its own with
// a quote's gray left edge and a chip that names its task chat; the intro that
// came with it is the bubble above. Task chat cards render as they do anywhere.
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
  // A message of several bubbles replies to one bubble's text, not to all of it.
  const bubbles = parts.filter(
    (part) => part.type === "task_chat" || (part.type === "text" && part.content.trim()),
  ).length;
  const replyTo = (text: string): ReplySource => ({
    messageId: message.id,
    sessionId: message.sessionId,
    author: "agent",
    text,
    ...(bubbles > 1 ? { ownBubble: true } : {}),
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
      // The message id tells the Needs you jump which reply a card belongs to.
      return (
        <div key={key} data-chat-card-message={message.id} className="contents">
          {renderFlatEntries([part], {
            ...actions,
            sessionId: message.sessionId,
            turnId: message.turnId ?? undefined,
          })}
        </div>
      );
    }
    if (!part.content.trim()) return null;
    const long = "format" in part && part.format === "long";
    const forwardedFrom = originOf(part);
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
        <ChatBubble
          tone="received"
          data-concierge-bubble
          className={forwardedFrom ? "border-l-3 border-l-muted-foreground" : undefined}
          {...arrival(message.id)}
        >
          {forwardedFrom ? (
            <ForwardedChip chatId={forwardedFrom.chatId} title={forwardedFrom.title} />
          ) : null}
          <CollapsibleBubbleContent>
            <Markdown
              className="min-w-0 text-foreground"
              compact={false}
              preserveSoftBreaks={!long}
            >
              {part.content}
            </Markdown>
          </CollapsibleBubbleContent>
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
