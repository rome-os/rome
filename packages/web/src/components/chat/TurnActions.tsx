import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import { TurnBranchButton } from "@/components/chat/TurnBranchButton";
import { TurnFeedbackButtons } from "@/components/chat/TurnFeedbackButtons";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { ReplyButton } from "@/components/chat/reply/ReplyButton";
import type { ReplySource } from "@/components/chat/reply/reply-source";
import type { ChatMessage } from "@/lib/chat-types";
import { formatMessageTimestamp } from "@/lib/message-timestamp";

// The raw text a copy button puts on the clipboard for an agent turn: every
// text block (commentary + final answer) across the turn's messages, joined as
// the markdown source — not the rendered HTML.
export function turnCopyText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    for (const b of parseMessageEntries(m)) {
      if (b.type === "text" && b.content.trim()) {
        parts.push(b.content);
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * The action row under a settled agent turn: copy, feedback, branch, and the
 * time. Renders nothing when the turn has none of them. The row's parent sets
 * `group`, which reveals it on hover on pointer devices.
 */
export function TurnActions({
  copyText,
  feedbackTurn,
  showBranch,
  createdAt,
  reply,
}: {
  copyText: string;
  /** The turn to rate; null hides feedback and branch. */
  feedbackTurn: { sessionId: string; turnId: string } | null;
  showBranch: boolean;
  createdAt?: string;
  /** What Reply quotes; null hides it. */
  reply?: ReplySource | null;
}) {
  const timestamp = createdAt ? formatMessageTimestamp(createdAt) : "";
  if (!copyText && !feedbackTurn && !timestamp && !reply) return null;
  return (
    // Hover-revealed on pointer devices, always visible on touch — mirrors the affordance
    // under the guardian's own bubbles. `has-[[aria-pressed=true]]` keeps
    // the row visible while the feedback draft is open (its popover is
    // portaled, so group-focus-within can't see it) and once a rating is
    // recorded.
    <div className="-ml-[var(--control-action-offset)] mt-1 flex items-center md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100 md:has-[[aria-expanded=true]]:opacity-100 md:has-[[aria-pressed=true]]:opacity-100">
      {copyText ? <CopyMessageButton text={copyText} /> : null}
      {reply ? <ReplyButton source={reply} /> : null}
      {feedbackTurn ? (
        <TurnFeedbackButtons
          key={`${feedbackTurn.sessionId}:${feedbackTurn.turnId}`}
          sessionId={feedbackTurn.sessionId}
          turnId={feedbackTurn.turnId}
        />
      ) : null}
      {showBranch && feedbackTurn ? (
        <TurnBranchButton
          key={`branch:${feedbackTurn.sessionId}:${feedbackTurn.turnId}`}
          sessionId={feedbackTurn.sessionId}
          turnId={feedbackTurn.turnId}
        />
      ) : null}
      {timestamp ? (
        <time dateTime={createdAt} className="ml-2 text-aux text-muted-foreground">
          {timestamp}
        </time>
      ) : null}
    </div>
  );
}
