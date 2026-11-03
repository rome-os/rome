import { type ReactNode, useRef } from "react";
import { type EntranceKind, useEntrance } from "@/components/chat/use-chat-motion";

/** Wraps one transcript entry (a bubble, a card, or a row) so it comes in once
 * while its turn is live. See `useEntrance` for when it animates. */
export function TranscriptEntry({
  entryKey,
  live,
  kind,
  className,
  children,
}: {
  entryKey: string;
  live: boolean;
  kind: EntranceKind;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEntrance(ref, entryKey, live, kind);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
