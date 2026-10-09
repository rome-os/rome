import { memo, useMemo, useRef } from "react";
import { CircleAlert, CircleHelp, CircleSlash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChatBubble } from "@/components/chat/ChatBubble";
import Markdown from "@/components/chat/ChatMarkdown";
import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import type { ChatMessage } from "@/lib/chat-types";
import { parseEntries } from "@/components/chat/entries/parse-entries";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { cn } from "@/lib/utils";
import { useSendFlight } from "@/components/chat/use-chat-motion";

// Isolated so that streaming-driven re-renders of ChatPage do not re-parse
// every historical user message through ReactMarkdown on every snapshot tick.
// The custom comparator survives `loadMessages` refresh — that path mints new
// ChatMessage object identities even though id+content are unchanged.
export const UserMessage = memo(
  function UserMessage({ msg }: { msg: ChatMessage }) {
    const { t } = useTranslation("chat");
    const rowRef = useRef<HTMLDivElement>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);
    useSendFlight(msg.id, rowRef, bubbleRef);
    const text = useMemo(() => {
      const blocks = parseEntries(msg.content);
      return blocks.flatMap((b) => (b.type === "text" ? [b.content] : [])).join("\n");
    }, [msg.content]);
    const timestamp = useMemo(() => formatMessageTimestamp(msg.createdAt), [msg.createdAt]);
    const undelivered =
      msg.inputState === "failed" || msg.inputState === "unknown" || msg.inputState === "cancelled";
    const pending =
      msg.inputState === "queued" ||
      msg.inputState === "submitted" ||
      msg.inputState === "accepted";
    const statusLabel =
      msg.inputState && msg.inputState !== "consumed"
        ? t(`inputState.${msg.inputState}`)
        : undefined;
    // Some user turns carry only a structured part with no text (e.g. an
    // interaction_result, whose inline component re-renders its own read-only
    // state), so suppress the empty bubble.
    if (!text) return null;
    // The guardian's own messages stay as a right-aligned bubble — no avatar or
    // name, since there's only ever one human in the conversation.
    return (
      <div ref={rowRef} className="group mb-4 flex flex-col items-end">
        {/* A delivered or pending message is the primary bubble. One that
            never reached the agent drops to the muted bubble, so its state
            border and icon read. */}
        <ChatBubble
          ref={bubbleRef}
          tone={undelivered ? "muted" : "sent"}
          className={cn(
            "max-w-[70%] transition-colors motion-reduce:transition-none",
            undelivered && "flex items-start gap-2",
            // A pending bubble is the normal bubble, breathing until the agent
            // takes the input in (see `.rome-bubble-pending` in globals.css).
            pending && "rome-bubble-pending",
            msg.inputState === "cancelled" && "border-dashed border-border bg-transparent",
            msg.inputState === "failed" && "border-destructive/50",
            msg.inputState === "unknown" && "border-warning/50",
          )}
          title={statusLabel}
          aria-busy={pending || undefined}
        >
          {msg.inputState === "failed" ? (
            <CircleAlert className="mt-1 size-4 shrink-0 text-destructive" aria-hidden="true" />
          ) : msg.inputState === "unknown" ? (
            <CircleHelp className="mt-1 size-4 shrink-0 text-warning" aria-hidden="true" />
          ) : msg.inputState === "cancelled" ? (
            <CircleSlash
              className="mt-1 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
          <Markdown className="min-w-0 text-foreground" compact={false} preserveSoftBreaks>
            {text}
          </Markdown>
        </ChatBubble>
        <span className="sr-only" role="status">
          {statusLabel}
        </span>
        {/* Timestamp + copy under the bubble. Hover-revealed on pointer
            devices, always visible on touch. Precision tracks recency: time
            of day today, month + day this year, full date for older years. */}
        <div className="mt-1 -mr-[var(--control-action-offset-sm)] flex items-center gap-2 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100">
          {timestamp ? <span className="text-aux text-muted-foreground">{timestamp}</span> : null}
          <CopyMessageButton text={text} />
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.inputState === next.msg.inputState,
);
