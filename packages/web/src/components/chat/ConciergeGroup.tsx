import { Fragment, memo, useMemo, type ReactNode } from "react";
import { ChatBubble } from "@/components/chat/ChatBubble";
import Markdown from "@/components/chat/ChatMarkdown";
import { ConciergeBubble } from "@/components/chat/ConciergeBubble";
import { UserMessageBubble } from "@/components/chat/UserMessageBubble";
import { renderFlatEntries } from "@/components/chat/entries";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { BlockActions } from "@/components/chat/MessageList";
import { userMessageText } from "@/components/chat/chat-view";
import type { ConciergeEntry, ConciergeItem } from "@/components/chat/concierge-groups";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

// The same bubble reparses nothing while the transcript re-renders around it;
// a message's identity changes on every reload, so compare what it shows.
const GuardianBubble = memo(
  function GuardianBubble({ msg }: { msg: ChatMessage }) {
    const text = useMemo(() => userMessageText(msg.content), [msg.content]);
    return (
      <div data-timeline-anchor={msg.id} className="flex min-w-0 max-w-full flex-col items-end">
        <ConciergeBubble side="end" copyText={text} createdAt={msg.createdAt} feedbackTurn={null}>
          <UserMessageBubble msg={msg} text={text} own />
        </ConciergeBubble>
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState,
);

// Each `say` call is its own message, so each text part is its own bubble. A
// long message is the same bubble with markdown that reads as a document.
// Cards render as they do anywhere.
function AgentEntry({
  entry,
  actions,
  rateable,
}: {
  entry: ConciergeEntry;
  actions: BlockActions;
  /** Whether the entry's turn is over and feedback is on. */
  rateable: boolean;
}) {
  const { message } = entry;
  const parts = parseMessageEntries(message);
  const lastText = parts.findLastIndex((part) => part.type === "text" && part.content.trim());
  return parts.map((part, index) => {
    const key = `${message.id}:${index}`;
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
      >
        <ChatBubble tone="received">
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
  typing,
}: {
  group: Extract<ConciergeItem, { kind: "group" }>;
  actions: BlockActions;
  runningTurnId: string | null;
  feedback: boolean;
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
          <GuardianBubble key={entry.message.id} msg={entry.message} />
        ) : (
          <AgentEntry
            key={entry.message.id}
            entry={entry}
            actions={actions}
            rateable={feedback && (!runningTurnId || entry.message.turnId !== runningTurnId)}
          />
        ),
      )}
      {group.typing ? typing : null}
    </div>
  );
}
