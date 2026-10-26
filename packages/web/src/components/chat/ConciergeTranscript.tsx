import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { ChatBubble } from "@/components/chat/ChatBubble";
import Markdown from "@/components/chat/ChatMarkdown";
import { renderFlatEntries } from "@/components/chat/entries";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { BlockActions, LivePreview } from "@/components/chat/MessageList";
import { ModelSwitchNotice } from "@/components/chat/ModelSwitchNotice";
import { TurnActions, turnCopyText } from "@/components/chat/TurnActions";
import { UserMessage } from "@/components/chat/UserMessage";
import type { ChatRow } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";

function TypingBubble() {
  const { t } = useTranslation("chat");
  return (
    <ChatBubble
      tone="received"
      className="mb-4 flex h-10 items-center gap-1 py-0"
      role="status"
      aria-label={t("concierge.typing")}
    >
      <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" aria-hidden />
      <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" aria-hidden />
      <span className="rome-typing-dot size-1.5 rounded-full bg-muted-foreground" aria-hidden />
    </ChatBubble>
  );
}

// Each `say` call is its own message, so each text part is its own bubble. A
// long message takes the transcript's width; cards render as they do anywhere.
// A settled turn gets the action row other chats show under an agent turn.
function AgentMessages({
  messages,
  actions,
  running,
  feedback,
}: {
  messages: ChatMessage[];
  actions: BlockActions;
  running: boolean;
  feedback: boolean;
}) {
  const last = messages.at(-1);
  const turn = messages[0]?.turnId
    ? { sessionId: messages[0].sessionId, turnId: messages[0].turnId }
    : null;
  return (
    <div className="group mb-4 flex flex-col items-start gap-2">
      {messages.flatMap((message) =>
        parseMessageEntries(message).map((part, index) => {
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
          return long ? (
            <div key={key} className="w-full rounded-16 bg-surface-muted px-4 py-3">
              <Markdown className="min-w-0 text-foreground" compact={false}>
                {part.content}
              </Markdown>
            </div>
          ) : (
            <ChatBubble key={key} tone="received" className="max-w-[80%]">
              <Markdown className="min-w-0 text-foreground" compact={false} preserveSoftBreaks>
                {part.content}
              </Markdown>
            </ChatBubble>
          );
        }),
      )}
      {running ? null : (
        <TurnActions
          copyText={turnCopyText(messages)}
          feedbackTurn={feedback ? turn : null}
          // Concierge is one fixed chat, so a turn is not branched off it.
          showBranch={false}
          createdAt={last?.createdAt}
        />
      )}
    </div>
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
  return (
    // Padding outside, width cap inside: the composer floor's geometry, so the
    // messages and the composer share both edges at every width.
    <div className="flex-1 px-3 pt-4 md:px-6">
      <div ref={contentRef} data-chat-transcript className="mx-auto flex max-w-5xl flex-col">
        {rows.map((row) => {
          if (row.kind === "user") {
            return (
              <div key={row.key} data-timeline-anchor={row.message.id}>
                <UserMessage msg={row.message} />
              </div>
            );
          }
          if (row.kind === "trace") return null;
          if (row.kind === "model_switch")
            return <ModelSwitchNotice key={row.key} model={row.model} />;
          return (
            <AgentMessages
              key={row.key}
              messages={row.messages}
              actions={actions}
              running={!!runningTurnId && row.messages.some((m) => m.turnId === runningTurnId)}
              feedback={feedback}
            />
          );
        })}
        {live.isStreaming ? <TypingBubble /> : null}
      </div>
    </div>
  );
}
