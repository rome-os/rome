import { CircleAlert, CircleHelp, CircleSlash } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChatBubble } from "@/components/chat/ChatBubble";
import Markdown from "@/components/chat/ChatMarkdown";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { QuotedReply } from "@/components/chat/reply/QuotedReply";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

/**
 * A guardian message's bubble with its delivery state: the breathing bubble
 * while the agent has not taken the input in, and the border, icon, and title
 * when it never arrived. A screen-reader status line follows the bubble.
 * `own` is false for another person's message, which reads as received.
 */
export function UserMessageBubble({
  msg,
  text,
  own,
  className,
  badge,
}: {
  msg: ChatMessage;
  text: string;
  own: boolean;
  className?: string;
  /** Sits on the bubble's own surface, positioned against it, as a status reaction does. Pass it, null included, to keep the bubble its anchor. */
  badge?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const undelivered =
    msg.inputState === "failed" || msg.inputState === "unknown" || msg.inputState === "cancelled";
  const pending =
    msg.inputState === "queued" || msg.inputState === "submitted" || msg.inputState === "accepted";
  const quote = parseMessageEntries(msg).find((part) => part.type === "reply_to");
  const statusLabel =
    msg.inputState && msg.inputState !== "consumed" ? t(`inputState.${msg.inputState}`) : undefined;
  return (
    <>
      {/* A delivered or pending message is the primary bubble. One that never
          reached the agent drops to the muted bubble, so its state border and
          icon read. */}
      <ChatBubble
        tone={undelivered ? "muted" : own ? "sent" : "received"}
        className={cn(
          "transition-colors motion-reduce:transition-none",
          // The badge is placed against the bubble, and takes no room of its own.
          badge !== undefined && "relative",
          undelivered && "flex items-start gap-2",
          // A pending bubble is the normal bubble, breathing until the agent
          // takes the input in (see `.rome-bubble-pending` in globals.css).
          pending && "rome-bubble-pending",
          msg.inputState === "cancelled" && "border-dashed border-border bg-transparent",
          msg.inputState === "failed" && "border-destructive/50",
          msg.inputState === "unknown" && "border-warning/50",
          className,
        )}
        title={statusLabel}
        aria-busy={pending || undefined}
      >
        {msg.inputState === "failed" ? (
          <CircleAlert className="mt-1 size-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : msg.inputState === "unknown" ? (
          <CircleHelp className="mt-1 size-4 shrink-0 text-warning" aria-hidden="true" />
        ) : msg.inputState === "cancelled" ? (
          <CircleSlash className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : null}
        <div className="min-w-0">
          {quote ? <QuotedReply part={quote} hostId={msg.id} /> : null}
          <Markdown className="min-w-0 text-foreground" compact={false} preserveSoftBreaks>
            {text}
          </Markdown>
        </div>
        {badge}
      </ChatBubble>
      <span className="sr-only" role="status">
        {statusLabel}
      </span>
    </>
  );
}
