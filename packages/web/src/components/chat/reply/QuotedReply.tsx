import { Reply } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReplyToPart } from "@rome/api-types/chat";
import { cn } from "@/lib/utils";
import { useChatThreads } from "./chat-threads";
import { useReplyDraft } from "./reply-draft";
import { quoteLine } from "./reply-source";

const FOCUS_RING =
  "outline-1 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

/**
 * What a click on a reply's quote does, and its accessible name:
 * focus the chat on the reply's thread, held on the reply, while no thread is
 * in focus. While one is, go to the original when the transcript shows it.
 * Without either, the quote is plain.
 */
function useQuoteTarget(part: ReplyToPart, hostId: string | undefined) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  const threads = useChatThreads();
  const threadOf = threads && hostId !== undefined ? threads.roots.get(hostId) : undefined;
  const opensThread = draft?.threads === true && draft.thread === null && threadOf !== undefined;
  const threadTitle = threadOf ? threads?.titles.get(threadOf) : undefined;
  if (!draft || !(opensThread || draft.has(part.messageId))) return null;
  return {
    label: t(opensThread ? "reply.openThread" : "reply.jump"),
    onClick: () =>
      opensThread
        ? draft.openThread({ thread: hostId ?? part.messageId, title: threadTitle ?? "" })
        : draft.jump(part.messageId),
  };
}

/**
 * The quote a reply carries when it does not sit under what it answers
 * (docs/domains/chats.md#chat-thread): a small reply arrow and one muted line
 * of the quoted message, at the top of the reply's bubble. A message from an
 * automation names it first.
 */
export function QuotedReply({ part, hostId }: { part: ReplyToPart; hostId?: string }) {
  const { t } = useTranslation("chat");
  const target = useQuoteTarget(part, hostId);
  const className =
    "mb-1 flex w-full max-w-72 items-center gap-1 text-left text-aux text-muted-foreground transition-colors";
  const quoted = (
    <>
      <Reply aria-hidden className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
      <span className="min-w-0 truncate">
        {part.author === "automated" ? (
          <>
            <span className="text-badge">{part.name ?? t("senderAutomation")}</span>
            <span aria-hidden> · </span>
          </>
        ) : null}
        {quoteLine(part.text)}
      </span>
    </>
  );
  if (!target) {
    return (
      <div data-reply-quote={part.messageId} className={className}>
        {quoted}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-reply-quote={part.messageId}
      aria-label={target.label}
      title={part.text}
      className={cn(className, "cursor-pointer hover:text-foreground", FOCUS_RING)}
      onClick={target.onClick}
    >
      {quoted}
    </button>
  );
}
