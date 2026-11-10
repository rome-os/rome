import { ThreadRepliesLine } from "@/components/chat/reply/chat-threads";
import { Fragment, memo, useMemo, type ReactNode } from "react";
import type { ForwardedFrom } from "@rome/api-types/chat";
import { UserMessage } from "./UserMessage";
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
import { messageLayout } from "./message-layout";

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
// long or rich one reads as a document instead: no fill, at a reading width
// (see messageLayout). Either is cut with a toggle when it is tall. A forwarded
// report is a part of its own with a chip that names its task chat; the intro
// that came with it is the bubble above. Task chat cards render as they do
// anywhere.
const AgentEntry = memo(function AgentEntry({
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
    const format = "format" in part ? part.format : undefined;
    const layout = messageLayout(part.content, format);
    const forwardedFrom = originOf(part);
    return (
      <ConciergeBubble
        key={key}
        side="start"
        layout={layout}
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
          tone={layout === "document" ? "document" : "received"}
          data-concierge-bubble
          {...arrival(message.id)}
        >
          {forwardedFrom ? (
            <ForwardedChip chatId={forwardedFrom.chatId} title={forwardedFrom.title} />
          ) : null}
          <CollapsibleBubbleContent fill={layout === "document" ? "canvas" : "bubble"}>
            <Markdown
              className="min-w-0 text-foreground"
              compact={false}
              preserveSoftBreaks={format !== "long"}
            >
              {part.content}
            </Markdown>
          </CollapsibleBubbleContent>
        </ChatBubble>
      </ConciergeBubble>
    );
  });
});

/**
 * One stretch of messages from a single sender, packed close together. The
 * guardian's bubbles align to the end, the agent's to the start. `typing` is
 * the agent's typing bubble, drawn after its messages.
 */
export const ConciergeGroup = memo(function ConciergeGroup({
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
        "flex flex-col gap-2",
        group.sender === "guardian" ? "items-end" : "items-start",
      )}
    >
      {group.entries.map((entry) => (
        <Fragment key={entry.message.id}>
          {entry.message.sender?.kind === "automated" ? (
            <div
              key={entry.message.id}
              data-timeline-anchor={entry.message.id}
              className="w-full self-start"
            >
              <UserMessage msg={entry.message} />
            </div>
          ) : group.sender === "guardian" ? (
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
          )}
          <ThreadRepliesLine message={entry.message} />
        </Fragment>
      ))}
      {group.typing ? typing : null}
    </div>
  );
});
