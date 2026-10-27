import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import { TurnFeedbackButtons } from "@/components/chat/TurnFeedbackButtons";
import { formatMessageTimestamp } from "@/lib/message-timestamp";

/**
 * What a Concierge bubble keeps behind its "more" control: when it was sent,
 * a copy button for its text, and for the last bubble of an agent turn, the
 * turn's feedback buttons. `feedbackTurn` is null where there is nothing to rate.
 */
export function ConciergeMessageMeta({
  copyText,
  createdAt,
  feedbackTurn,
}: {
  copyText: string;
  createdAt: string;
  feedbackTurn: { sessionId: string; turnId: string } | null;
}) {
  const timestamp = formatMessageTimestamp(createdAt);
  if (!copyText && !feedbackTurn && !timestamp) return null;
  return (
    <div className="flex items-center">
      {timestamp ? (
        <time dateTime={createdAt} className="px-2 text-aux text-muted-foreground">
          {timestamp}
        </time>
      ) : null}
      {copyText ? <CopyMessageButton text={copyText} /> : null}
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
