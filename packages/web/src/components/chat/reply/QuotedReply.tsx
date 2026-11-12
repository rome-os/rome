import { Reply } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReplyToPart } from "@rome/api-types/chat";
import { cn } from "@/lib/utils";
import { useChatThreads } from "./chat-threads";
import { useReplyDraft } from "./reply-draft";
import { plainQuote } from "./reply-source";

/**
 * The quote a reply carries, inside the reply's bubble: a gray left edge, a
 * reply arrow, and the first two lines of what was quoted. A reply in a task's
 * chat thread opens the thread view, as does any inside the open view. Any
 * other jumps to the original when the loaded transcript holds it, and is
 * plain text otherwise (docs/domains/chats.md#chat-thread).
 */
export function QuotedReply({ part, hostId }: { part: ReplyToPart; hostId?: string }) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  const threads = useChatThreads();
  // The thread view's own transcript has no threads provider: all of it is the task's.
  const inTaskThread = threads
    ? hostId !== undefined && threads.taskThreads.has(hostId)
    : draft?.thread !== null && draft?.thread !== undefined;
  const opensThread = draft?.threads === true && inTaskThread;
  const jumpable = opensThread || draft?.has(part.messageId) === true;
  const body = (
    <>
      <span className="flex h-5 shrink-0 items-center" role="img" aria-label={t("reply.action")}>
        <Reply className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 text-ui">
        {part.author === "automated" ? (
          <span className="block truncate text-aux">{part.name ?? t("senderAutomation")}</span>
        ) : null}
        <span className="line-clamp-2 break-words">{plainQuote(part.text)}</span>
      </span>
    </>
  );
  const frame =
    "mb-2 flex w-full gap-2 rounded-8 border-l-3 border-muted-foreground bg-muted px-2 py-1 text-left text-muted-foreground";
  if (!draft || !jumpable) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      aria-label={t(opensThread ? "reply.openThread" : "reply.jump")}
      className={cn(frame, "cursor-pointer transition-colors hover:bg-border")}
      onClick={() =>
        opensThread
          ? draft.openThread({
              messageId: part.messageId,
              author: part.author,
              ...(part.name ? { name: part.name } : {}),
              preview: plainQuote(part.text),
            })
          : draft.jump(part.messageId)
      }
    >
      {body}
    </button>
  );
}
