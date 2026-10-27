import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import { TurnFeedbackButtons } from "@/components/chat/TurnFeedbackButtons";
import { ReplyButton } from "@/components/chat/reply/ReplyButton";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import { formatMessageTimestamp } from "@/lib/message-timestamp";

/**
 * What a Concierge bubble keeps behind its "more" control: when it was sent,
 * a copy button for its text, and for the last bubble of an agent turn, the
 * turn's feedback buttons. The row a tap opens on touch also holds the Reply
 * button, which hover devices show beside the bubble instead. `feedbackTurn`
 * is null where there is nothing to rate; `reply` is null where the row has no
 * Reply.
 */
export function ConciergeMessageMeta({
  copyText,
  createdAt,
  feedbackTurn,
  reply,
  onReply,
}: {
  copyText: string;
  createdAt: string;
  feedbackTurn: { sessionId: string; turnId: string } | null;
  reply: ReplySource | null;
  /** Called after a reply is picked, so the row holding the button can close. */
  onReply: () => void;
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
      {copyText ? <CopyMessageButton text={copyText} /> : null}
      {reply ? <ReplyButton source={reply} onReply={onReply} /> : null}
      {feedbackTurn ? (
        <TurnFeedbackButtons
          key={`${feedbackTurn.sessionId}:${feedbackTurn.turnId}`}
          sessionId={feedbackTurn.sessionId}
          turnId={feedbackTurn.turnId}
        />
      ) : null}
    </div>
  );
}
