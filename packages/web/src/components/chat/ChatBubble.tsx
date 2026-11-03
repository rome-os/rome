import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ChatBubbleTone = "sent" | "received" | "muted";

/**
 * One message bubble in the transcript. `sent` is the guardian's own message on
 * the primary color, `received` is an agent text block on the muted surface,
 * and `muted` is a sent message that never reached the agent.
 *
 * A `sent` bubble re-maps the markdown color tokens inside it (see
 * `.rome-bubble-on-primary` in globals.css), so links, list markers, and inline
 * code stay legible on the primary fill.
 */
export const ChatBubble = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { tone: ChatBubbleTone }
>(function ChatBubble({ tone, className, children, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "w-fit min-w-0 max-w-full break-words rounded-16 border border-transparent px-3 py-2",
        tone === "sent" && "rome-bubble-on-primary bg-primary text-primary-foreground",
        tone === "received" && "bg-surface-muted text-foreground",
        tone === "muted" && "bg-surface-muted text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
});
