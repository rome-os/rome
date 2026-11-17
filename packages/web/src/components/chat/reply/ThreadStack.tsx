// A chat thread's stack in the main timeline: the newest message of the thread
// on one line, tucked under the thread's root bubble
// (docs/domains/chats.md#chat-thread). It opens the thread in focus.

import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { userMessageText } from "@/components/chat/chat-view";
import { cn } from "@/lib/utils";
import { type ThreadStack as Stack, useChatThreads } from "./chat-threads";
import { useReplyDraft } from "./reply-draft";
import { quoteLine } from "./reply-source";

/**
 * The words a card shows in a quote: a question card's question, an approval
 * card's title, else its task's title, as core stores the quote of a card.
 */
function cardLine(
  part: Extract<ReturnType<typeof parseMessageEntries>[number], { type: "task_chat" }>,
) {
  const card = part.show === "ask" ? part.card : undefined;
  if (card?.kind === "approval" && card.title.trim()) return card.title;
  if (card?.kind === "question") {
    const props = (card.render?.props ?? {}) as { questions?: { question?: unknown }[] };
    const question = props.questions?.[0]?.question;
    if (typeof question === "string" && question.trim()) return question;
  }
  return part.title;
}

/** The one line a thread's newest message shows: its first line of text, or its card's words. */
export function stackPreview(last: Stack["last"]): string {
  if (last.role === "user") return quoteLine(userMessageText(last.content));
  const text = parseMessageEntries(last).flatMap((part) => {
    if (part.type === "text")
      return part.turnPhase === "commentary" || !part.content.trim() ? [] : [part.content];
    return part.type === "task_chat" ? [cardLine(part)] : [];
  });
  return quoteLine(text.join("\n\n"));
}

/**
 * The stack under the root `root`, or nothing when the root's thread has no
 * replies to show: while a thread is in focus, in a share, or outside a chat
 * that opens threads. It is drawn inside the root bubble's own box, which is
 * as wide as the bubble and nothing else: a fixed inset each side keeps it
 * narrower than the bubble, whatever else sits in the bubble's column.
 */
export function ThreadStack({ root }: { root: string }) {
  const threads = useChatThreads();
  const draft = useReplyDraft();
  const stack = threads?.focus ? undefined : threads?.stacks.get(root);
  if (!threads || !stack || !draft?.threads || draft.thread !== null) return null;
  return (
    <StackView
      stack={stack}
      onOpen={() => draft.openThread({ thread: root, title: threads.titles.get(root) ?? "" })}
    />
  );
}

function StackView({ stack, onOpen }: { stack: Stack; onOpen: () => void }) {
  const { t } = useTranslation("chat");
  const preview = stackPreview(stack.last);
  const count = stack.unread > 0 ? stack.unread : stack.total;
  return (
    // Its top 1rem is behind the root bubble: the box is a stacking context
    // (ConciergeBubble), so this goes behind what the box holds. The box
    // leaves 2.5rem under the bubble for what shows.
    <div data-thread-stack-slot className="absolute inset-x-4 top-[calc(100%-1rem)] -z-10">
      <button
        type="button"
        data-thread-stack={stack.root}
        data-unread={stack.unread > 0 || undefined}
        data-layered={stack.total > 1 || undefined}
        aria-label={t("thread.stack", { preview })}
        onClick={onOpen}
        className={cn(
          "flex h-13 w-full cursor-pointer items-center gap-2 rounded-16 border border-border bg-surface-muted px-3 pt-6 pb-2 text-left text-aux text-muted-foreground transition-colors duration-300 ease-out",
          "outline-1 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 data-[timeline-landed]:bg-primary/10",
          // A thin second layer under it says there is more than one.
          stack.total > 1 &&
            "shadow-[0_6px_0_-3px_color-mix(in_oklab,var(--surface-muted),var(--foreground)_12%)]",
          stack.unread > 0 && "text-foreground",
        )}
      >
        <AgentAvatar size="sm" className="data-[size=sm]:size-[18px]" />
        <span className="min-w-0 flex-1 truncate">{preview}</span>
        {stack.unread > 0 ? (
          <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-badge text-primary-foreground tabular-nums">
            {count}
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {t("thread.stackCount", { count })}
          </span>
        )}
      </button>
    </div>
  );
}
