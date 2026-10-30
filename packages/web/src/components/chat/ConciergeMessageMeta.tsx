import { memo } from "react";
import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import { TurnFeedbackButtons } from "@/components/chat/TurnFeedbackButtons";
import { ReplyButton } from "@/components/chat/reply/ReplyButton";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import { formatMessageTimestamp } from "@/lib/message-timestamp";

/**
 * A Concierge bubble's details: when it was sent, a copy button for its text,
 * Reply, and for the last bubble of an agent turn, the turn's feedback buttons.
 * Hover devices show them in a toolbar over the bubble with `size` `xs`; touch
 * devices in the row a tap opens under it. `feedbackTurn` is null where there
 * is nothing to rate; `reply` is null where the bubble has no Reply.
 */
export const ConciergeMessageMeta = memo(function ConciergeMessageMeta({
  copyText,
  createdAt,
  feedbackTurn,
  reply,
  onReply,
  size = "sm",
}: {
  copyText: string;
  createdAt: string;
  feedbackTurn: { sessionId: string; turnId: string } | null;
  reply: ReplySource | null;
  /** Called after a reply is picked, so the row holding the button can close. */
  onReply?: () => void;
  size?: "xs" | "sm";
}) {
  const timestamp = formatMessageTimestamp(createdAt);
  if (!copyText && !feedbackTurn && !timestamp && !reply) return null;
  return (
    <div className="flex items-center">
      {timestamp ? (
        <time dateTime={createdAt} className="px-2 text-aux text-muted-foreground">
          {timestamp}
        </time>
      ) : null}
      {copyText ? <CopyMessageButton text={copyText} size={size} /> : null}
      {reply ? <ReplyButton source={reply} onReply={onReply} size={size} /> : null}
      {feedbackTurn ? (
        <TurnFeedbackButtons
          key={`${feedbackTurn.sessionId}:${feedbackTurn.turnId}`}
          sessionId={feedbackTurn.sessionId}
          turnId={feedbackTurn.turnId}
          size={size}
        />
      ) : null}
    </div>
  );
});
