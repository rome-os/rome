import { ThreadLabelLine } from "@/components/chat/reply/chat-threads";
import { Fragment, memo, useMemo, type ReactNode } from "react";
import { UserMessage } from "./UserMessage";
import { ChatBubble } from "@/components/chat/ChatBubble";
import Markdown from "@/components/chat/ChatMarkdown";
import { CollapsibleBubbleContent } from "@/components/chat/CollapsibleBubbleContent";
import { ConciergeBubble } from "@/components/chat/ConciergeBubble";
import { UserMessageBubble } from "@/components/chat/UserMessageBubble";
import { StatusReactionBadge, useStatusReaction } from "@/components/chat/status-reaction";
import { renderFlatEntries } from "@/components/chat/entries";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { BlockActions, ShareSelection } from "@/components/chat/MessageList";
import { SelectableRow } from "@/components/chat/SelectableRow";
import { userMessageText } from "@/components/chat/chat-view";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import type { ConciergeEntry, ConciergeItem } from "@/components/chat/concierge-groups";
import { isSettledUserMessage } from "@/components/chat/reply/reply-source";
import type { ArrivalProps } from "@/components/chat/use-bubble-arrivals";
import type { ChatMessage, TranscriptPart } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

// Room every guardian bubble keeps above it for its status reaction, which
// hangs half out of the bubble's top-left corner (status-reaction.tsx). With
// the group's 8px gap it clears the bubble above. It is there whether or not
// a mark shows, so nothing moves when one comes or goes.
const GUARDIAN_BUBBLE_GAP = "mt-2";

// The same bubble reparses nothing while the transcript re-renders around it;
// a message's identity changes on every reload, so compare what it shows.
const GuardianBubble = memo(
  function GuardianBubble({ msg, arrival }: { msg: ChatMessage; arrival?: number }) {
    const text = useMemo(() => userMessageText(msg.content), [msg.content]);
    const reaction = useStatusReaction(msg);
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
                turnId: msg.turnId,
                author: "guardian",
                name: msg.sender?.name ?? undefined,
                text,
              }
            : null
        }
        anchorId={msg.id}
        arrival={arrival}
        className={GUARDIAN_BUBBLE_GAP}
      >
        <UserMessageBubble
          msg={msg}
          text={text}
          own
          badge={<StatusReactionBadge reaction={reaction} />}
        />
      </ConciergeBubble>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState &&
    prev.msg.statusReaction === next.msg.statusReaction &&
    prev.arrival === next.arrival,
);

// Each `say` call is its own message, so each text part is its own bubble,
// cut with a toggle when it is tall. A forwarded report is a bubble of its own,
// named, like every message of a task's thread, by the label under it; the
// intro that came with it is the bubble above. Task chat cards render as they
// do anywhere.
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
    turnId: message.turnId,
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
          partOf={message.id}
        >
          {renderFlatEntries([part], {
            ...actions,
            sessionId: message.sessionId,
            turnId: message.turnId ?? undefined,
            messageAt: message.createdAt,
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
        partOf={message.id}
      >
        <ChatBubble tone="received" data-concierge-bubble {...arrival(message.id)}>
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
});

/**
 * One stretch of messages from a single sender, packed close together. The
 * guardian's bubbles align to the end, the agent's to the start. `typing` is
 * the agent's typing bubble, drawn after its messages.
 *
 * In share mode (`selection`), every bubble carries its turn's checkbox, and a
 * click anywhere on it picks or drops the whole turn, as a common chat's row
 * does. A bubble of no turn, or of another session, is dimmed and not picked.
 */
export const ConciergeGroup = memo(function ConciergeGroup({
  group,
  actions,
  runningTurnId,
  selection,
  feedback,
  arrival,
  typing,
}: {
  group: Extract<ConciergeItem, { kind: "group" }>;
  actions: BlockActions;
  runningTurnId: string | null;
  selection?: ShareSelection;
  feedback: boolean;
  /** Marks the bubbles that arrived while the transcript is open. */
  arrival: ArrivalProps;
  typing: ReactNode;
}) {
  return (
    <div
      className={cn(
        // A card keeps no margin of its own here, so its thread label sits as
        // close to it as a bubble's does.
        "flex flex-col gap-2 [&_[data-chat-card]]:mb-0",
        group.sender === "guardian" ? "items-end" : "items-start",
      )}
    >
      {group.entries.map((entry) => {
        const bubble = (
          <>
            {entry.message.sender?.kind === "automated" && entry.message.sender.onBehalfOf ? (
              // Sent for the guardian, so it stays with their messages and names its source.
              <div
                key={entry.message.id}
                data-timeline-anchor={entry.message.id}
                className="w-full"
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
            <ThreadLabelLine message={entry.message} />
          </>
        );
        if (!selection) return <Fragment key={entry.message.id}>{bubble}</Fragment>;
        const side = group.sender === "guardian" ? "items-end" : "items-start";
        const turnId = entry.message.turnId;
        if (!turnId || entry.message.sessionId !== selection.selectableSessionId) {
          return (
            <div
              key={entry.message.id}
              className={cn("flex w-full flex-col gap-2 pl-9 opacity-60", side)}
            >
              {bubble}
            </div>
          );
        }
        const selected = selection.selectedTurns.has(turnId);
        return (
          <div key={entry.message.id} className="w-full">
            <SelectableRow
              selected={selected}
              onToggle={() => selection.onToggleTurn(turnId)}
              label={selected ? "Deselect message" : "Select message"}
              contentClassName={cn("flex flex-col gap-2", side)}
            >
              {bubble}
            </SelectableRow>
          </div>
        );
      })}
      {group.typing ? typing : null}
    </div>
  );
});
