import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import { ShareMessageButton } from "@/components/chat/ShareMessageButton";
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
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { useSaidByConcierge } from "@/components/chat/task-chat";
import { RomeMascot } from "@/components/concierge/RomeMascot";

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
    const concierge = useSaidByConcierge(msg.sender);
    // Some user turns carry only a structured part with no text (e.g. an
    // interaction_result, whose inline component re-renders its own read-only
    // state), so suppress the empty bubble.
    if (!text) return null;
    // The Concierge speaks for its owner in a task chat, so its messages sit
    // on the owner's side, under its own name and mascot.
    const own = concierge || sentByViewer(msg.sender, viewer);
    const onBehalfOf = msg.sender?.kind === "automated" ? msg.sender.onBehalfOf : undefined;
    const displaySender = onBehalfOf ?? msg.sender;
    const sourceBadge =
      onBehalfOf && msg.sender ? (
        <span
          data-automated-badge
          className={cn(
            "block max-w-full truncate text-aux text-muted-foreground",
            own ? "min-w-0" : "mt-1",
          )}
        >
          {t("senderOnBehalf", { name: msg.sender.name ?? t("senderAutomation") })}
        </span>
      ) : null;
    const bubble = (
      <UserMessageBubble
        msg={msg}
        text={text}
        own={own && !concierge}
        // The bubble's cap follows the message row, not a wider attribution footer.
        className={cn(own && sourceBadge ? "max-w-[70cqw]" : "max-w-[70%]", !own && "self-start")}
      />
    );
    // Timestamp + copy under the bubble. Hover-revealed on pointer devices,
    // always visible on touch. Precision tracks recency: time of day today,
    // month + day this year, full date for older years.
    const actions = (
      <div
        className={cn(
          "flex items-center gap-2 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100",
          // Reserve badge space even when an older timestamp includes a full date.
          own && sourceBadge ? "ml-auto max-w-[70cqw] shrink-0" : "mt-1",
          own
            ? "-mr-[var(--control-action-offset-sm)]"
            : "-ml-[var(--control-action-offset-sm)] flex-row-reverse justify-end",
        )}
      >
        {timestamp ? (
          <span className={cn("text-aux text-muted-foreground", own && sourceBadge && "truncate")}>
            {timestamp}
          </span>
        ) : null}
        <CopyMessageButton text={text} />
        {isSettledUserMessage(msg) ? (
          <ReplyButton
            source={{
              messageId: msg.id,
              sessionId: msg.sessionId,
              author: msg.sender?.kind === "automated" ? "automated" : "guardian",
              name:
                msg.sender?.name ??
                (msg.sender?.kind === "automated" ? t("senderAutomation") : undefined),
              text,
            }}
          />
        ) : null}
        {isSettledUserMessage(msg) ? (
          <ShareMessageButton sessionId={msg.sessionId} messageId={msg.id} />
        ) : null}
      </div>
    );
    const footer = (
      <>
        {sourceBadge}
        {actions}
      </>
    );
    // Someone else's message reads like the agent's: on the left, under their
    // name. Only the signed-in person's own messages sit on the right.
    if (!own && displaySender) {
      return (
        <MessageRow
          name={
            displaySender.name ??
            t(displaySender.kind === "automated" ? "senderAutomation" : "senderGuardian")
          }
          subtitle={
            displaySender.kind === "automated" ? (
              <span className="rounded-4 border border-border px-1 text-aux text-muted-foreground">
                {t("senderAutomated")}
              </span>
            ) : undefined
          }
          avatar={<SenderAvatar sender={displaySender} />}
          className="group"
          footer={footer}
        >
          {bubble}
        </MessageRow>
      );
    }
    if (concierge) {
      const name = msg.sender?.name ?? t("senderAutomation");
      return (
        <div data-concierge-message className="group mb-4 flex items-start justify-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col items-end">
            <span className="mb-1 flex h-5 max-w-full items-center truncate text-aux text-muted-foreground">
              {name}
            </span>
            {bubble}
            {actions}
          </div>
          <AgentAvatar label={name} mark={<RomeMascot className="h-1/2 w-auto" />} />
        </div>
      );
    }
    return (
      <div className="group mb-4 flex items-start justify-end gap-2">
        <div className={cn("flex min-w-0 flex-1 flex-col items-end", sourceBadge && "@container")}>
          {sourceBadge ? (
            <div className="flex min-w-0 max-w-full flex-col items-end">
              {bubble}
              <div className="mt-1 flex w-full min-w-0 items-center gap-2">
                {sourceBadge}
                {actions}
              </div>
            </div>
          ) : (
            <>
              {bubble}
              {actions}
            </>
          )}
        </div>
        {msg.sender ? <SenderAvatar sender={msg.sender} /> : null}
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState &&
    prev.msg.sender?.kind === next.msg.sender?.kind &&
    prev.msg.sender?.name === next.msg.sender?.name &&
    (prev.msg.sender?.kind === "automated"
      ? next.msg.sender?.kind === "automated" &&
        prev.msg.sender.iconUrl === next.msg.sender.iconUrl &&
        prev.msg.sender.sourceType === next.msg.sender.sourceType &&
        prev.msg.sender.onBehalfOf?.name === next.msg.sender.onBehalfOf?.name &&
        prev.msg.sender.onBehalfOf?.avatarUrl === next.msg.sender.onBehalfOf?.avatarUrl &&
        !!prev.msg.sender.onBehalfOf === !!next.msg.sender.onBehalfOf
      : next.msg.sender?.kind !== "automated" &&
        prev.msg.sender?.avatarUrl === next.msg.sender?.avatarUrl &&
        (prev.msg.sender?.kind !== "visitor" ||
          (next.msg.sender?.kind === "visitor" &&
            prev.msg.sender.accountId === next.msg.sender.accountId))),
);
