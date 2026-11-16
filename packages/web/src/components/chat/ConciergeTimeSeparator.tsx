import { memo } from "react";
import { formatMessageTimestamp } from "@/lib/message-timestamp";

/** A centered time line between two stretches of conversation. `hidden` marks it for the thread in focus to fold away. */
export const ConciergeTimeSeparator = memo(function ConciergeTimeSeparator({
  at,
  hidden,
}: {
  at: string;
  hidden?: boolean;
}) {
  const label = formatMessageTimestamp(at);
  if (!label) return null;
  return (
    // Pulled toward the messages it introduces, so it reads as their heading.
    <p
      data-thread-out={hidden || undefined}
      className="-mb-2 text-center text-aux text-muted-foreground"
    >
      <time dateTime={at}>{label}</time>
    </p>
  );
});
