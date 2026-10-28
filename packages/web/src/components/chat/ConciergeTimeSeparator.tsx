import { formatMessageTimestamp } from "@/lib/message-timestamp";

/** A centered time line between two stretches of conversation. */
export function ConciergeTimeSeparator({ at }: { at: string }) {
  const label = formatMessageTimestamp(at);
  if (!label) return null;
  return (
    // Pulled toward the messages it introduces, so it reads as their heading.
    <p className="-mb-2 text-center text-aux text-muted-foreground">
      <time dateTime={at}>{label}</time>
    </p>
  );
}
