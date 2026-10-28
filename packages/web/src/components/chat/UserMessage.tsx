import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import { UserMessageBubble } from "@/components/chat/UserMessageBubble";
import type { ChatMessage } from "@/lib/chat-types";
import { userMessageText } from "@/components/chat/chat-view";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { cn } from "@/lib/utils";
import { MessageRow } from "@/components/chat/MessageRow";
import { ReplyButton } from "@/components/chat/reply/ReplyButton";
import { isSettledUserMessage } from "@/components/chat/reply/reply-source";
import { SenderAvatar, sentByViewer } from "@/components/chat/SenderAvatar";
import { useDashboardIdentity } from "@/hooks/use-dashboard-identity";

// Isolated so that streaming-driven re-renders of ChatPage do not re-parse
// every historical user message through ReactMarkdown on every snapshot tick.
// The custom comparator survives `loadMessages` refresh — that path mints new
// ChatMessage object identities even though id+content are unchanged.
export const UserMessage = memo(
  function UserMessage({ msg }: { msg: ChatMessage }) {
    const { t } = useTranslation("chat");
    const { data: viewer } = useDashboardIdentity();
    const text = useMemo(() => userMessageText(msg.content), [msg.content]);
    const timestamp = useMemo(() => formatMessageTimestamp(msg.createdAt), [msg.createdAt]);
    // Some user turns carry only a structured part with no text (e.g. an
    // interaction_result, whose inline component re-renders its own read-only
    // state), so suppress the empty bubble.
    if (!text) return null;
    const own = sentByViewer(msg.sender, viewer);
    const bubble = (
      <UserMessageBubble
        msg={msg}
        text={text}
        own={own}
        className={cn("max-w-[70%]", !own && "self-start")}
      />
    );
    // Timestamp + copy under the bubble. Hover-revealed on pointer devices,
    // always visible on touch. Precision tracks recency: time of day today,
    // month + day this year, full date for older years.
    const actions = (
      <div
        className={cn(
          "mt-1 flex items-center gap-2 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100",
          own
            ? "-mr-[var(--control-action-offset-sm)]"
            : "-ml-[var(--control-action-offset-sm)] flex-row-reverse justify-end",
        )}
      >
        {timestamp ? <span className="text-aux text-muted-foreground">{timestamp}</span> : null}
        <CopyMessageButton text={text} />
        {isSettledUserMessage(msg) ? (
          <ReplyButton
            source={{
              messageId: msg.id,
              sessionId: msg.sessionId,
              author: "guardian",
              name: msg.sender?.name ?? undefined,
              text,
            }}
          />
        ) : null}
      </div>
    );
    // Someone else's message reads like the agent's: on the left, under their
    // name. Only the signed-in person's own messages sit on the right.
    if (!own && msg.sender) {
      return (
        <MessageRow
          name={msg.sender.name ?? t("senderGuardian")}
          avatar={<SenderAvatar sender={msg.sender} />}
          className="group"
          footer={actions}
        >
          {bubble}
        </MessageRow>
      );
    }
    return (
      <div className="group mb-4 flex items-start justify-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col items-end">
          {bubble}
          {actions}
        </div>
        {msg.sender ? <SenderAvatar sender={msg.sender} /> : null}
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState &&
    prev.msg.sender?.name === next.msg.sender?.name &&
    prev.msg.sender?.avatarUrl === next.msg.sender?.avatarUrl,
);
