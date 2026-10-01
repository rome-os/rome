import { memo, useMemo } from "react";
import { CircleAlert, CircleHelp, CircleSlash } from "lucide-react";
import { useTranslation } from "react-i18next";
import Markdown from "@/components/chat/ChatMarkdown";
import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import type { ChatMessage, ChatEntry } from "@/lib/chat-types";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { cn } from "@/lib/utils";

// Isolated so that streaming-driven re-renders of ChatPage do not re-parse
// every historical user message through ReactMarkdown on every snapshot tick.
// The custom comparator survives `loadMessages` refresh — that path mints new
// ChatMessage object identities even though id+content are unchanged.
export const UserMessage = memo(
  function UserMessage({ msg }: { msg: ChatMessage }) {
    const { t } = useTranslation("chat");
    const text = useMemo(() => {
      let blocks: ChatEntry[];
      try {
        const parsed = JSON.parse(msg.content);
        blocks = Array.isArray(parsed) ? parsed : [{ type: "text", content: msg.content }];
      } catch {
        blocks = [{ type: "text", content: msg.content }];
      }
      return blocks
        .filter((b) => b.type === "text")
        .map((b) => b.content)
        .join("\n");
    }, [msg.content]);
    const timestamp = useMemo(() => formatMessageTimestamp(msg.createdAt), [msg.createdAt]);
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
      <div className="group mb-4 flex flex-col items-end">
        {/* One inset on every side, equal to `--markdown-block-space-between`
            at this density. A rim narrower than the space the renderer puts
            between two paragraphs reads as content spilling out of the box. */}
        <div
          className={cn(
            "flex max-w-[70%] items-start gap-2 break-words rounded-12 border border-transparent bg-surface-muted p-4 transition-colors motion-reduce:transition-none",
            pending && "border-dashed border-border-strong bg-transparent",
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
        </div>
        <span className="sr-only" role="status">
          {statusLabel}
        </span>
        {/* Timestamp + copy under the bubble. Hover-revealed on pointer
            devices, always visible on touch. Precision tracks recency: time
            of day today, month + day this year, full date for older years. */}
        <div className="mt-1 -mr-1 flex items-center gap-2 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100">
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
