import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small centered line across the transcript, for something that happened
 * in the chat rather than something said in it: the chat moved to another
 * model, a location was shared by itself.
 */
export function ChatNotice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="note"
      className={cn(
        "mb-4 w-full self-stretch text-center text-aux text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
